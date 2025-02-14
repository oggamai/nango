import type { NangoProps, RunnerOutput } from '@nangohq/shared';
import { AxiosError } from 'axios';
import { ActionError, NangoSync, NangoAction, instrumentSDK, SpanTypes, validateData, NangoError } from '@nangohq/shared';
import { Buffer } from 'buffer';
import * as vm from 'node:vm';
import * as url from 'url';
import * as crypto from 'crypto';
import * as zod from 'zod';
import * as soap from 'soap';
import * as botbuilder from 'botbuilder';
import tracer from 'dd-trace';
import { errorToObject, metrics } from '@nangohq/utils';
import { logger } from './utils.js';

export async function exec(
    nangoProps: NangoProps,
    code: string,
    codeParams?: object,
    abortController: AbortController = new AbortController()
): Promise<RunnerOutput> {
    const rawNango = (() => {
        switch (nangoProps.scriptType) {
            case 'sync':
            case 'webhook':
                return new NangoSync(nangoProps);
            case 'action':
            case 'on-event':
                return new NangoAction(nangoProps);
        }
    })();
    const nango = process.env['NANGO_TELEMETRY_SDK'] ? instrumentSDK(rawNango) : rawNango;
    nango.abortSignal = abortController.signal;

    const wrappedCode = `
        (function() {
            var module = { exports: {} };
            var exports = module.exports;
            ${code}
            return module.exports;
        })();
    `;

    return await tracer.trace<Promise<RunnerOutput>>(SpanTypes.RUNNER_EXEC, async (span) => {
        span.setTag('accountId', nangoProps.team?.id)
            .setTag('environmentId', nangoProps.environmentId)
            .setTag('connectionId', nangoProps.connectionId)
            .setTag('providerConfigKey', nangoProps.providerConfigKey)
            .setTag('syncId', nangoProps.syncId);

        try {
            const script = new vm.Script(wrappedCode);
            const sandbox: vm.Context = {
                console,
                require: (moduleName: string) => {
                    switch (moduleName) {
                        case 'url':
                            return url;
                        case 'crypto':
                            return crypto;
                        case 'zod':
                            return zod;
                        case 'botbuilder':
                            return botbuilder;
                        case 'soap':
                            return soap;
                        default:
                            throw new Error(`Module '${moduleName}' is not allowed`);
                    }
                },
                Buffer,
                setTimeout,
                Error,
                URL,
                URLSearchParams
            };

            const context = vm.createContext(sandbox);
            const scriptExports = script.runInContext(context);

            if (nangoProps.scriptType === 'webhook') {
                if (!scriptExports.onWebhookPayloadReceived) {
                    const content = `There is no onWebhookPayloadReceived export for ${nangoProps.syncId}`;

                    throw new Error(content);
                }

                const output = await scriptExports.onWebhookPayloadReceived(nango, codeParams);
                return { success: true, response: output, error: null };
            }

            if (!scriptExports.default || typeof scriptExports.default !== 'function') {
                throw new Error(`Default exports is not a function but a ${typeof scriptExports.default}`);
            }
            if (nangoProps.scriptType === 'action') {
                let inputParams = codeParams;
                if (typeof codeParams === 'object' && Object.keys(codeParams).length === 0) {
                    inputParams = undefined;
                }

                // Validate action input against json schema
                const valInput = validateData({
                    version: nangoProps.syncConfig.version || '1',
                    input: inputParams,
                    modelName: nangoProps.syncConfig.input,
                    jsonSchema: nangoProps.syncConfig.models_json_schema
                });
                if (Array.isArray(valInput)) {
                    metrics.increment(metrics.Types.RUNNER_INVALID_ACTION_INPUT);
                    if (nangoProps.runnerFlags?.validateActionInput) {
                        span.setTag('error', new Error('invalid_action_input'));
                        return { success: false, response: null, error: { type: 'invalid_action_input', status: 400, payload: valInput } };
                    } else {
                        await nango.log('Invalid action input', { validation: valInput }, { level: 'warn' });
                        logger.error('data_validation_invalid_action_input');
                    }
                }

                const output = await scriptExports.default(nango, inputParams);

                // Validate action output against json schema
                const valOutput = validateData({
                    version: nangoProps.syncConfig.version || '1',
                    input: output,
                    modelName: nangoProps.syncConfig.models.length > 0 ? nangoProps.syncConfig.models[0] : undefined,
                    jsonSchema: nangoProps.syncConfig.models_json_schema
                });
                if (Array.isArray(valOutput)) {
                    metrics.increment(metrics.Types.RUNNER_INVALID_ACTION_OUTPUT);
                    if (nangoProps.runnerFlags?.validateActionOutput) {
                        span.setTag('error', new Error('invalid_action_output'));
                        return {
                            success: false,
                            response: null,
                            error: { type: 'invalid_action_output', status: 400, payload: { output, validation: valOutput } }
                        };
                    } else {
                        await nango.log('Invalid action output', { output, validation: valOutput }, { level: 'warn' });
                        logger.error('data_validation_invalid_action_output');
                    }
                }

                return { success: true, response: output, error: null };
            } else {
                await scriptExports.default(nango);
                return { success: true, response: true, error: null };
            }
        } catch (error) {
            if (error instanceof ActionError) {
                // It's not a mistake, we don't want to report user generated error
                // span.setTag('error', error);
                const { type, payload } = error;
                return {
                    success: false,
                    error: {
                        type,
                        payload: Array.isArray(payload) || (typeof payload !== 'object' && payload !== null) ? { message: payload } : payload || {}, // TODO: fix ActionError so payload is always an object
                        status: 500
                    },
                    response: null
                };
            }

            if (error instanceof NangoError) {
                span.setTag('error', error);
                return {
                    success: false,
                    error: {
                        type: error.type,
                        payload: error.payload,
                        status: error.status
                    },
                    response: null
                };
            } else if (error instanceof AxiosError) {
                span.setTag('error', error);
                if (error.response?.data) {
                    const errorResponse = error.response.data.payload || error.response.data;
                    return {
                        success: false,
                        error: {
                            type: 'script_http_error',
                            payload: typeof errorResponse === 'string' ? { message: errorResponse } : errorResponse,
                            status: error.response.status
                        },
                        response: null
                    };
                } else {
                    const tmp = errorToObject(error);
                    return {
                        success: false,
                        error: {
                            type: 'script_http_error',
                            payload: { name: tmp.name || 'Error', code: tmp.code, message: tmp.message },
                            status: 500
                        },
                        response: null
                    };
                }
            } else if (error instanceof Error) {
                const tmp = errorToObject(error);
                span.setTag('error', tmp);
                return {
                    success: false,
                    error: {
                        type: 'script_internal_error',
                        payload: { name: tmp.name || 'Error', code: tmp.code, message: tmp.message },
                        status: 500
                    },
                    response: null
                };
            } else {
                const tmp = errorToObject(!error || typeof error !== 'object' ? new Error(JSON.stringify(error)) : error);
                span.setTag('error', tmp);
                return {
                    success: false,
                    error: {
                        type: 'script_internal_error',
                        payload: { name: tmp.name || 'Error', code: tmp.code, message: tmp.message },
                        status: 500
                    },
                    response: null
                };
            }
        } finally {
            span.finish();
        }
    });
}
