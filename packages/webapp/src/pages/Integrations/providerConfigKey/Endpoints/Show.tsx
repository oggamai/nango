import { Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { Skeleton } from '../../../../components/ui/Skeleton';
import { useGetIntegrationFlows } from '../../../../hooks/useIntegration';
import { useStore } from '../../../../store';
import { useMemo } from 'react';
import type { GetIntegration, NangoSyncConfig } from '@nangohq/types';
import type { FlowGroup, NangoSyncConfigWithEndpoint } from './components/List';
import { EndpointsList } from './components/List';
import { EndpointOne } from './components/One';
import PageNotFound from '../../../PageNotFound';

export const EndpointsShow: React.FC<{ integration: GetIntegration['Success']['data'] }> = ({ integration }) => {
    const env = useStore((state) => state.env);
    const { providerConfigKey } = useParams();
    const [searchParams] = useSearchParams();
    const { data, loading } = useGetIntegrationFlows(env, providerConfigKey!);

    const { byGroup, v1Flow } = useMemo<{ byGroup: FlowGroup[]; v1Flow: NangoSyncConfig[] }>(() => {
        if (!data) {
            return { byGroup: [], v1Flow: [] };
        }

        // Create groups
        const v1Flow = [];
        const tmp: Record<string, NangoSyncConfigWithEndpoint[]> = {};
        for (const flow of data.flows) {
            for (const endpoint of flow.endpoints) {
                const groupName = endpoint.group || 'others';

                let group = tmp[groupName];
                if (!group) {
                    group = [];
                    tmp[groupName] = group;
                }

                group.push({ ...flow, endpoint });
            }

            if (flow.endpoints.length <= 0) {
                v1Flow.push(flow);
            }
        }

        // Sort flows inside the groups
        const groups: FlowGroup[] = [];
        for (const group of Object.entries(tmp)) {
            groups.push({
                name: group[0],
                flows: group[1]
                    .sort((a, b) => {
                        // Sort by length of path
                        const lenA = (a.endpoint.path.match(/\//g) || []).length;
                        const lenB = (b.endpoint.path.match(/\//g) || []).length;
                        if (lenA > lenB) return 1;
                        else if (lenA < lenB) return -1;

                        // Sort alphabetically
                        return a.endpoint.path > b.endpoint.path ? 1 : -1;
                    })
                    .sort((a, b) => {
                        if (a.endpoint.path !== b.endpoint.path) return 0;

                        // Sort by method
                        if (a.endpoint.method === 'GET' && b.endpoint.method !== 'GET') return -1;
                        else if (a.endpoint.method === 'POST' && b.endpoint.method === 'PUT') return -1;
                        else if (a.endpoint.method === 'PUT' && b.endpoint.method === 'PATCH') return -1;
                        else if (a.endpoint.method === 'PATCH' && b.endpoint.method === 'DELETE') return -1;
                        else return 0;
                    })
            });
        }

        groups.sort((a, b) => a.name.localeCompare(b.name));
        return { byGroup: groups, v1Flow };
    }, [data]);

    const currentFlow = useMemo<NangoSyncConfigWithEndpoint | undefined>(() => {
        if (searchParams.size <= 0 || !data) {
            return;
        }

        const method = searchParams.get('method');
        const path = searchParams.get('path');
        if (!method || !path) {
            return;
        }

        for (const flow of data.flows) {
            for (const endpoint of flow.endpoints) {
                if (endpoint.method === method && endpoint.path === path) {
                    return { ...flow, endpoint };
                }
            }
        }
    }, [searchParams, data]);

    if (loading) {
        return (
            <div>
                <Skeleton className="w-[150px]" />
            </div>
        );
    }

    if (!data) {
        return null;
    }

    return (
        <Routes>
            <Route path="/" element={<EndpointsList byGroup={byGroup} v1Flow={v1Flow} integration={integration} />} />
            <Route path="/endpoint" element={currentFlow && <EndpointOne flow={currentFlow} integration={integration} />} />
            <Route path="*" element={<PageNotFound />} />
        </Routes>
    );
};
