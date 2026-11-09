import assert from 'node:assert/strict';
import { before, beforeEach, test } from 'node:test';
import { RegistryCore, memoryStore } from '../registry/core.js';
import { configureRegistry, getSecretRecord, putSecretRecord } from '../registry/index.js';
import {
  clearTenantProviderSecrets,
  mergeAndEncryptTenantProviderSecrets,
  readTenantProviderSecrets,
  readTenantProviderSecretsSafe,
  SecretsUnreadableError,
} from './tenantProviderSecrets.js';

const tenantId = 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4';
const otherTenantId = '7c62c466-76b8-42ca-93c2-34433dd87059';
const dummyGeminiKey = 'dummy-gemini-secret-for-unit-test';

before(() => {
  process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY = '9f'.repeat(32);
});

beforeEach(() => {
  configureRegistry(new RegistryCore(memoryStore()));
});

test('provider secrets are encrypted, round-trip correctly, and are bound to one tenant', async () => {
  const flags = await mergeAndEncryptTenantProviderSecrets(tenantId, { geminiApiKey: dummyGeminiKey });
  assert.equal(flags.geminiApiKey, true);
  assert.equal(flags.supabaseSecretKey, false);

  const stored = await getSecretRecord(tenantId);
  assert.ok(stored);
  assert.equal(stored.tenant_id, tenantId);
  assert.equal(stored.key_version, 1);
  assert.equal(stored.ciphertext.includes(dummyGeminiKey), false);

  assert.deepEqual(await readTenantProviderSecrets(tenantId), { geminiApiKey: dummyGeminiKey });

  // A ciphertext copied onto another clinic's record must not decrypt there.
  await putSecretRecord(otherTenantId, stored);
  await assert.rejects(readTenantProviderSecrets(otherTenantId), /Could not decrypt stored provider secrets/);

  // A tampered ciphertext must not decrypt either.
  const tampered = `${stored.ciphertext[0] === 'A' ? 'B' : 'A'}${stored.ciphertext.slice(1)}`;
  await putSecretRecord(tenantId, { ...stored, ciphertext: tampered });
  await assert.rejects(readTenantProviderSecrets(tenantId), /Could not decrypt stored provider secrets/);
});

test('each clinic keeps its own Supabase credentials, merged and cleared independently', async () => {
  await mergeAndEncryptTenantProviderSecrets(tenantId, { geminiApiKey: dummyGeminiKey, supabaseUrl: 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co', supabaseSecretKey: 'sb_secret_one_value_for_tests' });
  await mergeAndEncryptTenantProviderSecrets(otherTenantId, { supabaseUrl: 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co', supabaseSecretKey: 'sb_secret_other_value_for_tests' });

  // Adding a Cal.com key keeps what was already stored for the same clinic.
  await mergeAndEncryptTenantProviderSecrets(tenantId, { calcomApiKey: 'cal_live_test_key' });
  const first = await readTenantProviderSecrets(tenantId);
  assert.equal(first.supabaseUrl, 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co');
  assert.equal(first.calcomApiKey, 'cal_live_test_key');
  assert.equal((await readTenantProviderSecrets(otherTenantId)).supabaseUrl, 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co');

  await mergeAndEncryptTenantProviderSecrets(tenantId, { calcomApiKey: null });
  assert.equal((await readTenantProviderSecrets(tenantId)).calcomApiKey, undefined);

  await clearTenantProviderSecrets(tenantId);
  assert.deepEqual(await readTenantProviderSecrets(tenantId), {});
  assert.equal((await readTenantProviderSecrets(otherTenantId)).supabaseSecretKey, 'sb_secret_other_value_for_tests');
});

test('keys saved under a different encryption key are reported as unreadable, and a clinic can still be repaired', async () => {
  const original = process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY;
  await mergeAndEncryptTenantProviderSecrets(tenantId, { geminiApiKey: dummyGeminiKey, calcomApiKey: 'cal-old-key' });
  try {
    process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY = '3a'.repeat(32);
    await assert.rejects(readTenantProviderSecrets(tenantId), (error: unknown) => error instanceof SecretsUnreadableError);
    assert.deepEqual(await readTenantProviderSecretsSafe(tenantId), { secrets: {}, unreadable: true });

    // Entering one key again works instead of failing, and only that key is stored afterwards.
    const flags = await mergeAndEncryptTenantProviderSecrets(tenantId, { geminiApiKey: 'brand-new-gemini-key' });
    assert.equal(flags.geminiApiKey, true);
    assert.equal(flags.calcomApiKey, false);
    assert.deepEqual(await readTenantProviderSecretsSafe(tenantId), { secrets: { geminiApiKey: 'brand-new-gemini-key' }, unreadable: false });
  } finally {
    process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY = original;
  }
});

test('a clinic with no saved keys is readable and empty', async () => {
  assert.deepEqual(await readTenantProviderSecretsSafe(otherTenantId), { secrets: {}, unreadable: false });
});
