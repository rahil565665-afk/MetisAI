import type { Company, IntegrationStatus, SessionUser } from './types.js';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body: unknown = await response.json().catch((): unknown => ({}));
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export interface NewTenantInput {
  name: string;
  slug: string;
  timezone: string;
  receptionist_config: { greeting: string; knowledge_base: string; voice_output_mode?: 'native' | 'cartesia' };
  integrations: {
    geminiApiKey: string;
    cartesiaApiKey: string;
    cartesiaVoiceId: string;
    calcomApiKey: string;
    calcomEventTypeId: number | null;
    calcomEventTypeSlug: string;
    calcomUsername: string;
    calcomTeamSlug: string;
  };
}

export interface UsageSummary {
  calls: number;
  appointments: number;
  escalationCount: number;
  talkSeconds: number;
  periodStart: string;
}

export const api = {
  getSession: async () => request<{ authenticated: boolean; user: SessionUser | null }>('/api/session'),
  login: async (passcode: string) => request<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ passcode }) }),
  logout: async () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  tenants: async () => (await request<{ tenants: Company[] }>('/api/tenants')).tenants,
  createTenant: async (input: NewTenantInput) => (await request<{ tenant: Company }>('/api/tenants', { method: 'POST', body: JSON.stringify(input) })).tenant,
  updateTenant: async (id: string, changes: Record<string, unknown>) => (await request<{ tenant: Company }>(`/api/tenants/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })).tenant,
  integrations: async (id: string) => (await request<{ integrations: Record<string, IntegrationStatus> }>(`/api/tenants/${encodeURIComponent(id)}/integrations`)).integrations,
  updateIntegration: async (id: string, provider: string, values: Record<string, unknown>) => request<{ ok: boolean; provider: string; message: string }>(`/api/tenants/${encodeURIComponent(id)}/integrations`, { method: 'PUT', body: JSON.stringify({ provider, ...values }) }),
  deploymentStatus: async (id: string) => request<Record<string, unknown>>(`/api/tenants/${encodeURIComponent(id)}/deployment-status`),
  redeploy: async (id: string) => request<{ ok: boolean; deployId: string | null; message: string }>(`/api/tenants/${encodeURIComponent(id)}/redeploy`, { method: 'POST', body: '{}' }),
  deleteAgent: async (id: string) => request<{ ok: boolean; tenant: Company; message: string }>(`/api/tenants/${encodeURIComponent(id)}/agent`, { method: 'DELETE' }),
  usage: async (id: string) => request<UsageSummary>(`/api/tenants/${encodeURIComponent(id)}/usage`),
  calls: async (id: string) => (await request<{ calls: any[] }>(`/api/tenants/${encodeURIComponent(id)}/calls`)).calls,
};
