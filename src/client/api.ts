import type { Company, IntegrationStatus, SessionUser } from './types.js';
import type { BusinessTemplateId, EnabledActions } from '../shared/businessTemplates.js';

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
  business_type: BusinessTemplateId;
  timezone: string;
  receptionist_config: {
    greeting: string;
    persona_name: string;
    tone: string;
    services: string[];
    opening_hours: string;
    safety_rules: string;
    booking_language: string;
    faqs: Array<{ question: string; answer: string }>;
    enabled_actions: EnabledActions;
    knowledge_base: string;
    knowledge_base_file: { name: string; pages: number; characters: number } | null;
  };
  /** Everything here is optional: a clinic is created whatever is filled in, and problems come back as warnings. */
  integrations: {
    geminiApiKey: string;
    supabaseUrl: string;
    supabaseSecretKey: string;
    calcomApiKey: string;
    calcomEventTypeId: string;
    calcomEventLink: string;
  };
}

export interface CallRow {
  id: string;
  transport: string;
  started_at: string;
  ended_at?: string | null;
  status: string;
  caller_name?: string | null;
  transfer_requested?: boolean;
  /** One line on how the call ended, for example "Booked Jacob for Friday at 9:00 AM." */
  outcome?: string | null;
  note_count?: number;
}

export interface CallDetail {
  id: string;
  transport: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  caller_name: string | null;
  caller_phone: string | null;
  transfer_requested: boolean;
  transfer_reason: string | null;
  metadata: {
    outcome?: string;
    end_reason?: string;
    failure?: string;
    scheduling?: { available: boolean; reason?: string };
    transcript?: Array<{ role: 'user' | 'assistant'; text: string; at?: string }>;
    events?: Array<{ text: string; at?: string }>;
    [key: string]: unknown;
  } | null;
}

export interface UsageSummary {
  calls: number;
  appointments: number;
  escalationCount: number;
  talkSeconds: number;
  periodStart: string;
  /** False when the clinic has no working Supabase project, so there is nothing to count. */
  connected: boolean;
  problem?: string;
}

export const api = {
  getSession: async () => request<{ authenticated: boolean; user: SessionUser | null }>('/api/session'),
  login: async (passcode: string) => request<{ ok: boolean }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ passcode }) }),
  logout: async () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  tenants: async () => (await request<{ tenants: Company[] }>('/api/tenants')).tenants,
  createTenant: async (input: NewTenantInput) => request<{ tenant: Company; warnings: string[] }>('/api/tenants', { method: 'POST', body: JSON.stringify(input) }),
  updateTenant: async (id: string, changes: Record<string, unknown>) => (await request<{ tenant: Company }>(`/api/tenants/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(changes) })).tenant,
  integrations: async (id: string) => (await request<{ integrations: Record<string, IntegrationStatus> }>(`/api/tenants/${encodeURIComponent(id)}/integrations`)).integrations,
  updateIntegration: async (id: string, provider: string, values: Record<string, unknown>) => request<{ ok: boolean; provider: string; message: string; warning?: string }>(`/api/tenants/${encodeURIComponent(id)}/integrations`, { method: 'PUT', body: JSON.stringify({ provider, ...values }) }),
  deploymentStatus: async (id: string) => request<Record<string, unknown>>(`/api/tenants/${encodeURIComponent(id)}/deployment-status`),
  endCall: async (id: string) => request<{ ok: boolean; ended: boolean; message: string }>(`/api/tenants/${encodeURIComponent(id)}/end-call`, { method: 'POST', body: '{}' }),
  deleteAgent: async (id: string) => request<{ ok: boolean; tenant: Company; message: string }>(`/api/tenants/${encodeURIComponent(id)}/agent`, { method: 'DELETE' }),
  usage: async (id: string) => request<UsageSummary>(`/api/tenants/${encodeURIComponent(id)}/usage`),
  downloadBackup: async () => {
    const response = await fetch('/api/backup', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Could not create the backup (${response.status}).`);
    const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'metisai-clinics.json';
    return { blob: await response.blob(), filename: name };
  },
  restoreBackup: async (payload: unknown) => request<{ restored: number; skipped: number; renamed: number; tenants: Company[] }>('/api/backup/restore', { method: 'POST', body: JSON.stringify(payload) }),
  calls: async (id: string) => request<{ calls: CallRow[]; connected: boolean; problem?: string }>(`/api/tenants/${encodeURIComponent(id)}/calls`),
  call: async (id: string, callId: string) => (await request<{ call: CallDetail }>(`/api/tenants/${encodeURIComponent(id)}/calls/${encodeURIComponent(callId)}`)).call,
};
