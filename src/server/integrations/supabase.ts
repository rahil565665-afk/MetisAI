import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppUser, Company } from '../types.js';

export interface RenderCompanyFields {
  render_service_id?: string | null;
  render_service_url?: string | null;
  render_deployment_status?: 'not_created' | 'creating' | 'building' | 'live' | 'failed' | 'suspended';
  render_last_deploy_id?: string | null;
  render_last_deploy_at?: string | null;
  integration_status?: Record<string, { configured: boolean; updatedAt?: string; note?: string }>;
}

export type ManagedCompany = Company & RenderCompanyFields;

let client: SupabaseClient | undefined;
export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Supabase server configuration is missing.');
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Database operation failed: ${result.error.message}`);
  if (result.data === null) throw new Error('Database returned no data.');
  return result.data;
}

export async function getMembership(tenantId: string, userId: string): Promise<{ role: string } | null> {
  const result = await getSupabase().from('tenant_memberships').select('role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
  if (result.error) throw new Error(`Could not verify tenant membership: ${result.error.message}`);
  return result.data;
}

export async function listCompanies(user: AppUser): Promise<ManagedCompany[]> {
  const db = getSupabase();
  if (user.is_platform_admin) return unwrap(await db.from('companies').select('*').order('created_at', { ascending: false })) as ManagedCompany[];
  const memberships = unwrap(await db.from('tenant_memberships').select('tenant_id').eq('user_id', user.id)) as Array<{ tenant_id: string }>;
  const ids = memberships.map((row) => row.tenant_id);
  if (!ids.length) return [];
  return unwrap(await db.from('companies').select('*').in('id', ids).order('created_at', { ascending: false })) as ManagedCompany[];
}

export async function getCompany(tenantId: string): Promise<ManagedCompany> {
  return unwrap(await getSupabase().from('companies').select('*').eq('id', tenantId).single()) as ManagedCompany;
}

export async function createCompany(input: {
  slug: string;
  name: string;
  businessType: string;
  timezone: string;
  receptionistConfig: Record<string, unknown>;
}): Promise<ManagedCompany> {
  const db = getSupabase();
  return unwrap(await db.from('companies').insert({
    slug: input.slug,
    name: input.name,
    business_type: input.businessType,
    timezone: input.timezone,
    receptionist_config: input.receptionistConfig,
  }).select('*').single()) as ManagedCompany;
}

export async function updateCompany(tenantId: string, changes: Partial<Pick<ManagedCompany,
  'name' | 'business_type' | 'timezone' | 'is_active' | 'receptionist_config' | 'render_service_id' | 'render_service_url' | 'render_deployment_status' | 'render_last_deploy_id' | 'render_last_deploy_at' | 'integration_status'>>): Promise<ManagedCompany> {
  return unwrap(await getSupabase().from('companies').update({ ...changes, updated_at: new Date().toISOString() }).eq('id', tenantId).select('*').single()) as ManagedCompany;
}

export async function updateIntegrationStatus(tenantId: string, provider: string, status: { configured: boolean; updatedAt?: string; note?: string }): Promise<ManagedCompany> {
  const company = await getCompany(tenantId);
  const integration_status = { ...(company.integration_status ?? {}), [provider]: status };
  return updateCompany(tenantId, { integration_status });
}

export async function updateDeployment(tenantId: string, fields: Partial<Pick<ManagedCompany,
  'render_service_id' | 'render_service_url' | 'render_deployment_status' | 'render_last_deploy_id' | 'render_last_deploy_at'>>): Promise<ManagedCompany> {
  return updateCompany(tenantId, fields);
}

export async function createCallLog(tenantId: string, userId: string | null, transport: 'browser' | 'twilio'): Promise<string> {
  const row = unwrap(await getSupabase().from('call_logs').insert({ tenant_id: tenantId, user_id: userId, transport }).select('id').single()) as { id: string };
  return row.id;
}

export async function markTransferRequest(callId: string, reason: string): Promise<void> {
  const result = await getSupabase().from('call_logs').update({ status: 'transfer_requested', transfer_requested: true, transfer_reason: reason }).eq('id', callId);
  if (result.error) throw new Error(`Could not record call handoff: ${result.error.message}`);
}

export async function endCallLog(callId: string, status: 'completed' | 'error' | 'transfer_requested', reason?: string): Promise<void> {
  const result = await getSupabase().from('call_logs').update({ status, ended_at: new Date().toISOString(), ...(status === 'transfer_requested' ? { transfer_requested: true, transfer_reason: reason ?? null } : {}) }).eq('id', callId);
  if (result.error) throw new Error(`Could not close call log: ${result.error.message}`);
}

export async function updateAgentCallLog(tenantId: string, callId: string, fields: Record<string, unknown>): Promise<void> {
  const result = await getSupabase().from('call_logs').update(fields).eq('tenant_id', tenantId).eq('id', callId).select('id').maybeSingle();
  if (result.error) throw new Error(`Could not update call log: ${result.error.message}`);
  if (!result.data) throw new Error('Call log was not found for this clinic.');
}

export async function addMessage(tenantId: string, callId: string, role: string, content: string): Promise<void> {
  if (!content.trim()) return;
  const result = await getSupabase().from('conversation_messages').insert({ tenant_id: tenantId, call_id: callId, role, content: content.slice(0, 8000) });
  if (result.error) throw new Error(`Could not store conversation transcript: ${result.error.message}`);
}

export async function recordAppointment(input: { tenantId: string; bookingUid: string; status: string; start: string; end?: string; type: string; name: string; email?: string; phone?: string; callId?: string }): Promise<void> {
  const result = await getSupabase().from('receptionist_appointments').upsert({ tenant_id: input.tenantId, cal_booking_uid: input.bookingUid, status: input.status, starts_at: input.start, ends_at: input.end ?? null, appointment_type: input.type, attendee_name: input.name, attendee_email: input.email ?? null, attendee_phone: input.phone ?? null, last_call_id: input.callId ?? null, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,cal_booking_uid' });
  if (result.error) throw new Error(`Could not store booking record: ${result.error.message}`);
}

export async function updateAppointmentStatus(tenantId: string, bookingUid: string, status: string): Promise<void> {
  const result = await getSupabase().from('receptionist_appointments').update({ status, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('cal_booking_uid', bookingUid);
  if (result.error) throw new Error(`Could not update booking record: ${result.error.message}`);
}

export async function recordReschedule(tenantId: string, oldUid: string, newUid: string | undefined, start: string, callId?: string): Promise<void> {
  const db = getSupabase();
  const previous = await db.from('receptionist_appointments').select('*').eq('tenant_id', tenantId).eq('cal_booking_uid', oldUid).maybeSingle();
  if (previous.error) throw new Error(`Could not load prior booking: ${previous.error.message}`);
  const updated = await db.from('receptionist_appointments').update({ status: 'rescheduled', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('cal_booking_uid', oldUid);
  if (updated.error) throw new Error(`Could not update prior booking: ${updated.error.message}`);
  if (newUid && previous.data) {
    const result = await db.from('receptionist_appointments').upsert({
      tenant_id: tenantId, cal_booking_uid: newUid, status: 'accepted', starts_at: start,
      ends_at: null, appointment_type: previous.data.appointment_type, attendee_name: previous.data.attendee_name,
      attendee_email: previous.data.attendee_email, attendee_phone: previous.data.attendee_phone, last_call_id: callId ?? null,
    }, { onConflict: 'tenant_id,cal_booking_uid' });
    if (result.error) throw new Error(`Could not record rescheduled booking: ${result.error.message}`);
  }
}

export async function listRecentCalls(tenantId: string, limit = 20): Promise<unknown[]> {
  return unwrap(await getSupabase().from('call_logs').select('id,status,transport,started_at,ended_at,caller_name,transfer_requested,transfer_reason').eq('tenant_id', tenantId).order('started_at', { ascending: false }).limit(limit)) as unknown[];
}

export async function getUsageSummary(tenantId: string, since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)): Promise<{ calls: number; appointments: number; escalationCount: number; talkSeconds: number; periodStart: string }> {
  const db = getSupabase();
  const periodStart = since.toISOString();
  const [callCount, appointmentCount, rows] = await Promise.all([
    db.from('call_logs').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('started_at', periodStart),
    db.from('receptionist_appointments').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', periodStart),
    db.from('call_logs').select('started_at,ended_at,transfer_requested').eq('tenant_id', tenantId).gte('started_at', periodStart).order('started_at', { ascending: false }).limit(2000),
  ]);
  if (callCount.error || appointmentCount.error || rows.error) throw new Error('Could not load usage summary.');
  const records = rows.data ?? [];
  const talkSeconds = records.reduce((sum, call) => {
    if (!call.ended_at) return sum;
    const seconds = (Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000;
    return sum + (Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 4 * 60 * 60)) : 0);
  }, 0);
  return {
    calls: callCount.count ?? 0,
    appointments: appointmentCount.count ?? 0,
    escalationCount: records.filter((call) => call.transfer_requested).length,
    talkSeconds: Math.round(talkSeconds),
    periodStart,
  };
}

export interface TenantProviderSecretRecord {
  tenant_id: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export async function getTenantProviderSecretRecord(tenantId: string): Promise<TenantProviderSecretRecord | null> {
  const result = await getSupabase()
    .from('tenant_provider_secrets')
    .select('tenant_id,ciphertext,nonce,key_version,created_at,updated_at')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (result.error) throw new Error(`Could not load encrypted provider secrets: ${result.error.message}`);
  return result.data as TenantProviderSecretRecord | null;
}

export async function upsertTenantProviderSecretRecord(
  tenantId: string,
  encrypted: Pick<TenantProviderSecretRecord, 'ciphertext' | 'nonce' | 'key_version'>,
): Promise<void> {
  const result = await getSupabase().from('tenant_provider_secrets').upsert({
    tenant_id: tenantId,
    ...encrypted,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id' });
  if (result.error) throw new Error(`Could not save encrypted provider secrets: ${result.error.message}`);
}

export async function deleteTenantProviderSecretRecord(tenantId: string): Promise<void> {
  const result = await getSupabase().from('tenant_provider_secrets').delete().eq('tenant_id', tenantId);
  if (result.error) throw new Error(`Could not clear encrypted provider secrets: ${result.error.message}`);
}
