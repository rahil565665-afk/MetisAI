import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { assertServerConfig, cookieOptions, voiceTokenSigningKeyHex } from './config.js';

const NAMES = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DASHBOARD_ADMIN_PASSCODE', 'APP_PUBLIC_URL', 'DASHBOARD_SESSION_SECRET', 'TENANT_CREDENTIALS_ENCRYPTION_KEY', 'NODE_ENV'] as const;
const saved: Partial<Record<(typeof NAMES)[number], string | undefined>> = {};

function configure(overrides: Partial<Record<(typeof NAMES)[number], string | undefined>> = {}): void {
  const base: Record<string, string> = {
    SUPABASE_URL: 'https://example-project.invalid',
    SUPABASE_SECRET_KEY: 'test-secret-key',
    DASHBOARD_ADMIN_PASSCODE: 'a-long-test-passcode',
    APP_PUBLIC_URL: 'https://dentdesk.example.com',
    DASHBOARD_SESSION_SECRET: 'cd'.repeat(32),
    TENANT_CREDENTIALS_ENCRYPTION_KEY: 'ef'.repeat(32),
    NODE_ENV: 'production',
  };
  for (const name of NAMES) {
    const value = name in overrides ? overrides[name] : base[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

beforeEach(() => { for (const name of NAMES) saved[name] = process.env[name]; });
afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });

test('a complete production configuration passes', () => {
  configure();
  assert.doesNotThrow(() => assertServerConfig());
});

test('each required setting is reported when missing', () => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DASHBOARD_ADMIN_PASSCODE', 'APP_PUBLIC_URL'] as const) {
    configure({ [name]: undefined });
    assert.throws(() => assertServerConfig(), new RegExp(name), name);
  }
});

test('short passcodes and plain-HTTP public URLs are rejected', () => {
  configure({ DASHBOARD_ADMIN_PASSCODE: 'short' });
  assert.throws(() => assertServerConfig(), /DASHBOARD_ADMIN_PASSCODE/);
  configure({ APP_PUBLIC_URL: 'http://dentdesk.example.com' });
  assert.throws(() => assertServerConfig(), /HTTPS/);
  configure({ APP_PUBLIC_URL: 'https://dentdesk.example.com/app' });
  assert.throws(() => assertServerConfig(), /origin/);
  configure({ APP_PUBLIC_URL: 'http://localhost:8787' });
  assert.doesNotThrow(() => assertServerConfig());
});

test('a missing session secret fails closed unless NODE_ENV is development', () => {
  configure({ DASHBOARD_SESSION_SECRET: undefined });
  assert.throws(() => assertServerConfig(), /DASHBOARD_SESSION_SECRET/);
  configure({ DASHBOARD_SESSION_SECRET: undefined, NODE_ENV: undefined });
  assert.throws(() => assertServerConfig(), /DASHBOARD_SESSION_SECRET/);
  configure({ DASHBOARD_SESSION_SECRET: undefined, NODE_ENV: 'development' });
  assert.doesNotThrow(() => assertServerConfig());
});

test('a missing or malformed credentials encryption key is rejected', () => {
  configure({ TENANT_CREDENTIALS_ENCRYPTION_KEY: undefined });
  assert.throws(() => assertServerConfig(), /TENANT_CREDENTIALS_ENCRYPTION_KEY/);
  configure({ TENANT_CREDENTIALS_ENCRYPTION_KEY: 'too-short' });
  assert.throws(() => assertServerConfig(), /TENANT_CREDENTIALS_ENCRYPTION_KEY/);
});

test('voice signing keys are stable per clinic and differ between clinics', () => {
  configure();
  const a = voiceTokenSigningKeyHex('b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4');
  const b = voiceTokenSigningKeyHex('7c62c466-76b8-42ca-93c2-34433dd87059');
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, voiceTokenSigningKeyHex('b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4'));
  assert.notEqual(a, b);
});

test('session cookies are HttpOnly, SameSite=Lax and Secure on HTTPS', () => {
  configure();
  const options = cookieOptions();
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.secure, true);
});
