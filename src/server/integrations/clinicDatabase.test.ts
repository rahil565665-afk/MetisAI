import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { HttpError } from '../http.js';
import { cleanSupabaseKey, describeDatabaseError, normalizeSupabaseUrl } from './clinicDatabase.js';

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
  assert.match(describeDatabaseError({ code: '23503', message: 'violates foreign key constraint secret-detail' }, 409), /old link/);
  assert.match(describeDatabaseError({ message: 'TypeError: fetch failed' }, 0), /Could not reach/);
  const other = describeDatabaseError({ code: '99999', message: 'secret-detail-that-must-not-leak' }, 500);
  assert.match(other, /99999/);
  assert.equal(other.includes('secret-detail'), false);
  assert.equal(describeDatabaseError({ code: '23503', message: 'violates foreign key constraint secret-detail' }, 409).includes('secret-detail'), false);
});
