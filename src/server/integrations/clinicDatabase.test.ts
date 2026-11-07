import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HttpError } from '../http.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkClinicDatabase, cleanSupabaseKey, createCallLog, describeDatabaseError, normalizeSupabaseUrl, recordAppointment } from './clinicDatabase.js';

const env = process.env as Record<string, string | undefined>;
const original = env.NODE_ENV;
afterEach(() => { if (original === undefined) delete env.NODE_ENV; else env.NODE_ENV = original; });

const rejectsWith = (fn: () => unknown, pattern: RegExp) =>
  assert.throws(fn, (error: unknown) => error instanceof HttpError && error.status === 400 && pattern.test(error.message));

test('only a hosted Supabase project URL is accepted, and only its origin is kept', () => {
  env.NODE_ENV = 'production';
  assert.equal(normalizeSupabaseUrl('https://abcdefghijklmnopqrst.supabase.co'), 'https://abcdefghijklmnopqrst.supabase.co');
  assert.equal(normalizeSupabaseUrl('  https://abcdefghijklmnopqrst.supabase.co/rest/v1/  '), 'https://abcdefghijklmnopqrst.supabase.co');
  assert.equal(normalizeSupabaseUrl('abcdefghijklmnopqrst.supabase.co'), 'https://abcdefghijklmnopqrst.supabase.co');
  for (const bad of ['', 'http://abcdefghijklmnopqrst.supabase.co', 'https://example.com', 'https://supabase.co', 'https://evil.com/.supabase.co', 'https://abcdefghijklmnopqrst.supabase.co.evil.com', 'http://127.0.0.1:9000']) {
    rejectsWith(() => normalizeSupabaseUrl(bad), /project URL/);
  }
});

test('a local stand-in is accepted only in an explicit development run', () => {
  env.NODE_ENV = 'development';
  assert.equal(normalizeSupabaseUrl('http://127.0.0.1:9000/anything'), 'http://127.0.0.1:9000');
  env.NODE_ENV = 'production';
  rejectsWith(() => normalizeSupabaseUrl('http://127.0.0.1:9000'), /project URL/);
});

test('public Supabase keys and malformed keys are refused', () => {
  const anon = `x.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.y`;
  const service = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.y`;
  rejectsWith(() => cleanSupabaseKey('sb_publishable_abcdefghijklmnopqrstuv'), /public Supabase key/);
  rejectsWith(() => cleanSupabaseKey(anon), /public Supabase key/);
  rejectsWith(() => cleanSupabaseKey('too short'), /secret key/);
  rejectsWith(() => cleanSupabaseKey('has a space inside it long enough yes'), /secret key/);
  assert.equal(cleanSupabaseKey('  sb_secret_abcdefghijklmnopqrstuv  '), 'sb_secret_abcdefghijklmnopqrstuv');
  assert.equal(cleanSupabaseKey(service), service);
});

test('database failures are explained without repeating provider text', () => {
  assert.match(describeDatabaseError({ message: 'Invalid API key' }, 401), /rejected that secret key/);
  assert.match(describeDatabaseError({ code: '42P01', message: 'relation "x" does not exist' }, 404), /clinic-schema\.sql/);
  assert.match(describeDatabaseError({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 404), /missing its tables/);
  assert.match(describeDatabaseError({ code: '23503', message: 'violates foreign key constraint secret-detail' }, 409), /earlier version/);
  assert.match(describeDatabaseError({ message: 'TypeError: fetch failed' }, 0), /Could not reach/);
  const other = describeDatabaseError({ code: '99999', message: 'secret-detail-that-must-not-leak' }, 500);
  assert.match(other, /99999/);
  assert.equal(other.includes('secret-detail'), false);
  assert.equal(describeDatabaseError({ code: '23503', message: 'violates foreign key constraint secret-detail' }, 409).includes('secret-detail'), false);
});

/** A stand-in for the parts of the Supabase client the legacy-link repair touches. */
function fakeDatabase(options: { legacy: boolean; repairable?: boolean }) {
  const companies = new Set<string>();
  const calls: string[] = [];
  const linkError = { code: '23503', message: 'insert or update violates foreign key constraint', details: 'Key (tenant_id)=(t1) is not present in table "companies".' };
  const attempt = (table: string) => {
    calls.push(`write:${table}`);
    if (options.legacy && !companies.has('t1')) return { data: null, error: linkError, status: 409 };
    return { data: { id: 'row-1' }, error: null, status: 201 };
  };
  const builder = (table: string) => ({
    insert: () => ({ select: () => ({ single: async () => attempt(table) }) }),
    upsert: async (row: { id?: string }) => {
      if (table === 'companies') {
        calls.push('link:companies');
        if (options.repairable === false) return { data: null, error: { code: '42501', message: 'permission denied' }, status: 403 };
        companies.add(row.id ?? '');
        return { data: null, error: null, status: 201 };
      }
      const result = attempt(table);
      return { error: result.error, status: result.status };
    },
    delete: () => ({ eq: async () => ({ error: null }) }),
    select: () => ({ limit: async () => ({ data: [], error: null, status: 200 }) }),
  });
  return { db: { from: builder } as unknown as SupabaseClient, calls, companies };
}

test('a project from an earlier version is repaired by adding the one row its old link needs', async () => {
  const { db, calls, companies } = fakeDatabase({ legacy: true });
  await checkClinicDatabase(db, 't1');
  assert.deepEqual(calls.slice(0, 3), ['write:call_logs', 'link:companies', 'write:call_logs']);
  assert.equal(companies.has('t1'), true);
  assert.equal(await createCallLog(db, 't1', 'browser'), 'row-1');
  await recordAppointment(db, { tenantId: 't1', bookingUid: 'b1', status: 'accepted', start: '2026-11-10T10:00:00Z', type: 'Cleaning', name: 'Sam' });
});

test('a current project is never touched by the repair', async () => {
  const { db, calls } = fakeDatabase({ legacy: false });
  await checkClinicDatabase(db, 't1');
  assert.equal(calls.includes('link:companies'), false);
});

test('when the old link cannot be repaired, the explanation says what to run', async () => {
  const { db } = fakeDatabase({ legacy: true, repairable: false });
  await assert.rejects(() => checkClinicDatabase(db, 't1'), (error: unknown) => error instanceof HttpError && /clinic-schema\.sql/.test(error.message) && /earlier version/.test(error.message));
});
