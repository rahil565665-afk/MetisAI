import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../http.js';
import { readTenantProviderSecretsSafe, type TenantProviderSecrets } from './tenantProviderSecrets.js';

/**
 * Every clinic brings its own Supabase project. The console never holds a database of its own for
 * call history or appointments: it reads and writes the clinic's project with the clinic's secret key,
 * which is stored encrypted and decrypted only when it is needed.
 */

const HOSTED_HOST = /^[a-z0-9]{8,40}\.supabase\.co$/;
const URL_HELP = 'Enter the clinic’s Supabase project URL, like https://abcdefghijklmnop.supabase.co (Supabase → Project Settings → API → Project URL).';

/** Return the origin of a Supabase project URL, or throw a message the administrator can act on. */
export function normalizeSupabaseUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new HttpError(400, URL_HELP);
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new HttpError(400, URL_HELP);
  }
  // Local stand-ins are allowed only in an explicit development run, never in production.
  if (process.env.NODE_ENV === 'development' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  if (url.protocol !== 'https:' || !HOSTED_HOST.test(url.hostname)) throw new HttpError(400, URL_HELP);
  return url.origin;
}

function jwtRole(key: string): string | null {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

/** Trim a pasted secret key and refuse the public keys, which cannot write call history. */
export function cleanSupabaseKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 20 || key.length > 2048 || /\s/.test(key)) {
    throw new HttpError(400, 'Enter the clinic’s Supabase secret key (Project Settings → API → Secret key). It is one long value with no spaces.');
  }
  if (key.startsWith('sb_publishable_') || jwtRole(key) === 'anon') {
    throw new HttpError(400, 'That is the public Supabase key. Use the secret key instead (it starts with sb_secret_, or is the service_role key).');
  }
  return key;
}

export function connectClinicDatabase(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** A client for a clinic's stored credentials, or null when the clinic has not connected a database. */
export function databaseFromSecrets(secrets: Pick<TenantProviderSecrets, 'supabaseUrl' | 'supabaseSecretKey'>): SupabaseClient | null {
  if (!secrets.supabaseUrl || !secrets.supabaseSecretKey) return null;
  try {
    return connectClinicDatabase(normalizeSupabaseUrl(secrets.supabaseUrl), secrets.supabaseSecretKey);
  } catch {
    return null;
  }
}

/** The clinic's database, or null when none is connected or its saved keys can no longer be read. */
export async function clinicDatabase(tenantId: string): Promise<SupabaseClient | null> {
  return databaseFromSecrets((await readTenantProviderSecretsSafe(tenantId)).secrets);
}

interface DatabaseErrorLike { message?: string; code?: string; details?: string }

/** Turn a database failure into advice. Provider error text is never passed on. */
export function describeDatabaseError(error: DatabaseErrorLike | null | undefined, status?: number): string {
  const message = error?.message ?? '';
  const code = error?.code ?? '';
  if (status === 401 || status === 403 || /invalid api key|jwt|unauthori[sz]ed|permission denied/i.test(message) || code === '42501') {
    return 'Supabase rejected that secret key. Copy the secret key (not the public one) from Project Settings → API, and check it belongs to this project.';
  }
  if (code === '23503') {
    return 'This project still has a link from an earlier version that blocks saving call history, and it could not be repaired automatically. Run supabase/clinic-schema.sql in its SQL Editor once, then press Save connection again.';
  }
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204' || /schema cache|does not exist|could not find the table/i.test(message)) {
    return 'The clinic’s Supabase project is missing its tables. Run supabase/clinic-schema.sql in its SQL Editor, then retry.';
  }
  if (/fetch failed|network|enotfound|econn|getaddrinfo|timed? ?out/i.test(message) || status === 0) {
    return 'Could not reach that Supabase project. Check the project URL and that the project is not paused.';
  }
  return `Supabase returned an error${code ? ` (${code.slice(0, 20)})` : ''}. Check the project URL and secret key, and that supabase/clinic-schema.sql has been run.`;
}

/**
 * A project that was set up with an earlier version of the schema has a foreign key from its tables to a
 * `companies` table. Rather than make the administrator edit the database, add the one row that link needs
 * and try again. Only done when the database itself asks for it, and only ever adds a row.
 */
function isLegacyLinkError(error: DatabaseErrorLike | null | undefined): boolean {
  return error?.code === '23503' && /companies/i.test(`${error.details ?? ''} ${error.message ?? ''}`);
}

async function linkLegacyCompany(db: SupabaseClient, tenantId: string): Promise<boolean> {
  const result = await db.from('companies').upsert(
    { id: tenantId, slug: `clinic-${tenantId}`, name: 'Clinic' },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  return !result.error;
}

async function withLegacyLink<T extends { error: DatabaseErrorLike | null }>(db: SupabaseClient, tenantId: string, run: () => PromiseLike<T>): Promise<T> {
  const first = await run();
  if (!isLegacyLinkError(first.error)) return first;
  if (!(await linkLegacyCompany(db, tenantId))) return first;
  return run();
}

/**
 * Prove the connection end to end: write a throw-away row, delete it, and read the appointments table.
 * Throws a 400 whose message says exactly what to fix.
 */
export async function checkClinicDatabase(db: SupabaseClient, tenantId: string): Promise<void> {
  const inserted = await withLegacyLink(db, tenantId, () => db.from('call_logs')
    .insert({ tenant_id: tenantId, transport: 'browser', status: 'completed', ended_at: new Date().toISOString(), metadata: { probe: true } })
    .select('id')
    .single());
  if (inserted.error || !inserted.data) throw new HttpError(400, describeDatabaseError(inserted.error, inserted.status));
  const removed = await db.from('call_logs').delete().eq('id', (inserted.data as { id: string }).id);
  if (removed.error) console.warn('[clinic-db] could not remove the connection-test row');
  const appointments = await db.from('receptionist_appointments').select('id').limit(1);
  if (appointments.error) throw new HttpError(400, describeDatabaseError(appointments.error, appointments.status));
}

/** A database failure whose message is advice for the administrator and is safe to show as it is. */
export class DatabaseAdviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseAdviceError';
  }
}

/** Fields a call's log row may carry. Anything else is ignored. */
const CALL_FIELDS = ['status', 'caller_name', 'caller_phone', 'started_at', 'ended_at', 'transfer_requested', 'transfer_reason', 'metadata'] as const;

function callFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of CALL_FIELDS) if (fields[key] !== undefined) clean[key] = fields[key];
  return clean;
}

export async function createCallLog(db: SupabaseClient, tenantId: string, transport: 'browser' | 'twilio', fields: Record<string, unknown> = {}): Promise<string> {
  const result = await withLegacyLink(db, tenantId, () => db.from('call_logs').insert({ tenant_id: tenantId, transport, ...callFields(fields) }).select('id').single());
  if (result.error || !result.data) throw new DatabaseAdviceError(describeDatabaseError(result.error, result.status));
  return (result.data as { id: string }).id;
}

export async function updateAgentCallLog(db: SupabaseClient, tenantId: string, callId: string, fields: Record<string, unknown>): Promise<void> {
  const result = await db.from('call_logs').update(callFields(fields)).eq('tenant_id', tenantId).eq('id', callId).select('id').maybeSingle();
  if (result.error) throw new DatabaseAdviceError(describeDatabaseError(result.error, result.status));
  if (!result.data) throw new DatabaseAdviceError('The call’s history row could not be found, so it was not updated.');
}

export async function recordAppointment(db: SupabaseClient, input: { tenantId: string; bookingUid: string; status: string; start: string; end?: string; type: string; name: string; email?: string; phone?: string; callId?: string }): Promise<void> {
  const result = await withLegacyLink(db, input.tenantId, () => db.from('receptionist_appointments').upsert({
    tenant_id: input.tenantId, cal_booking_uid: input.bookingUid, status: input.status, starts_at: input.start, ends_at: input.end ?? null,
    appointment_type: input.type, attendee_name: input.name, attendee_email: input.email ?? null, attendee_phone: input.phone ?? null,
    last_call_id: input.callId ?? null, updated_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,cal_booking_uid' }));
  if (result.error) throw new Error('Could not store booking record.');
}

export async function updateAppointmentStatus(db: SupabaseClient, tenantId: string, bookingUid: string, status: string): Promise<void> {
  const result = await db.from('receptionist_appointments').update({ status, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('cal_booking_uid', bookingUid);
  if (result.error) throw new Error('Could not update booking record.');
}

export async function recordReschedule(db: SupabaseClient, tenantId: string, oldUid: string, newUid: string | undefined, start: string, callId?: string): Promise<void> {
  const previous = await db.from('receptionist_appointments').select('*').eq('tenant_id', tenantId).eq('cal_booking_uid', oldUid).maybeSingle();
  if (previous.error) throw new Error('Could not load prior booking.');
  const updated = await db.from('receptionist_appointments').update({ status: 'rescheduled', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('cal_booking_uid', oldUid);
  if (updated.error) throw new Error('Could not update prior booking.');
  if (newUid && previous.data) {
    const result = await withLegacyLink(db, tenantId, () => db.from('receptionist_appointments').upsert({
      tenant_id: tenantId, cal_booking_uid: newUid, status: 'accepted', starts_at: start,
      ends_at: null, appointment_type: previous.data.appointment_type, attendee_name: previous.data.attendee_name,
      attendee_email: previous.data.attendee_email, attendee_phone: previous.data.attendee_phone, last_call_id: callId ?? null,
    }, { onConflict: 'tenant_id,cal_booking_uid' }));
    if (result.error) throw new Error('Could not record rescheduled booking.');
  }
}

/** One call as the dashboard lists it. The transcript is left out; open the call to read it. */
export interface CallSummary {
  id: string;
  status: string;
  transport: string;
  started_at: string;
  ended_at: string | null;
  caller_name: string | null;
  transfer_requested: boolean;
  transfer_reason: string | null;
  outcome: string | null;
  note_count: number;
}

export async function listRecentCalls(db: SupabaseClient, tenantId: string, limit = 20): Promise<CallSummary[]> {
  const result = await db.from('call_logs')
    .select('id,status,transport,started_at,ended_at,caller_name,transfer_requested,transfer_reason,outcome:metadata->>outcome,notes:metadata->events')
    .eq('tenant_id', tenantId).order('started_at', { ascending: false }).limit(limit);
  if (result.error) throw new DatabaseAdviceError(describeDatabaseError(result.error, result.status));
  return ((result.data ?? []) as unknown as Array<Record<string, unknown> & { notes?: unknown }>).map((row) => {
    const { notes, ...rest } = row;
    return { ...rest, outcome: typeof row.outcome === 'string' ? row.outcome : null, note_count: Array.isArray(notes) ? notes.length : 0 } as unknown as CallSummary;
  });
}

/** Everything saved about one call, including what was said. Null when this clinic has no such call. */
export async function getCallDetail(db: SupabaseClient, tenantId: string, callId: string): Promise<Record<string, unknown> | null> {
  const result = await db.from('call_logs').select('id,status,transport,started_at,ended_at,caller_name,caller_phone,transfer_requested,transfer_reason,metadata')
    .eq('tenant_id', tenantId).eq('id', callId).maybeSingle();
  if (result.error) throw new DatabaseAdviceError(describeDatabaseError(result.error, result.status));
  return (result.data as Record<string, unknown> | null) ?? null;
}

export interface UsageSummary { calls: number; appointments: number; escalationCount: number; talkSeconds: number; periodStart: string }

export async function getUsageSummary(db: SupabaseClient, tenantId: string, since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)): Promise<UsageSummary> {
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
