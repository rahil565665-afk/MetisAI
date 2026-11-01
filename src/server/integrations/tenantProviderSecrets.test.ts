import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  mergeAndEncryptTenantProviderSecrets,
  readTenantProviderSecrets,
} from './tenantProviderSecrets.js';

const tenantId = 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4';
const otherTenantId = '7c62c466-76b8-42ca-93c2-34433dd87059';
const dummyGeminiKey = 'dummy-gemini-secret-for-unit-test';
let encryptedRecord: Record<string, unknown> = {};
let hasEncryptedRecord = false;
let originalFetch: typeof globalThis.fetch;

before(() => {
  process.env.SUPABASE_URL = 'https://dentdesk-secrets-test.invalid';
  process.env.SUPABASE_SECRET_KEY = 'dummy-supabase-key-for-unit-test';
  process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY = '9f'.repeat(32);
  originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(requestUrl);
    assert.equal(url.hostname, 'dentdesk-secrets-test.invalid', 'the test must never contact a real Supabase project');
    assert.equal(url.pathname, '/rest/v1/tenant_provider_secrets');
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      const requestedTenant = (url.searchParams.get('tenant_id') ?? '').replace(/^eq\./, '');
      if (!hasEncryptedRecord || encryptedRecord.tenant_id !== requestedTenant) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(encryptedRecord), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'POST') {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
      assert.ok(body, 'the fake upsert must receive a JSON row');
      encryptedRecord = {
        ...body,
        created_at: '2026-10-30T00:00:00.000Z',
        updated_at: '2026-10-30T00:00:00.000Z',
      };
      hasEncryptedRecord = true;
      return new Response(null, { status: 204 });
    }

    return new Response('Unsupported fake database method.', { status: 405 });
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

test('provider secrets are encrypted, round-trip correctly, and are bound to one tenant', async () => {
  encryptedRecord = {};
  hasEncryptedRecord = false;
  const flags = await mergeAndEncryptTenantProviderSecrets(tenantId, { geminiApiKey: dummyGeminiKey });

  assert.equal(flags.geminiApiKey, true);
  assert.equal(hasEncryptedRecord, true);
  assert.equal(encryptedRecord.tenant_id, tenantId);
  assert.equal(typeof encryptedRecord.ciphertext, 'string');
  assert.equal(typeof encryptedRecord.nonce, 'string');
  assert.equal(encryptedRecord.key_version, 1);
  assert.equal(String(encryptedRecord.ciphertext).includes(dummyGeminiKey), false);

  const decrypted = await readTenantProviderSecrets(tenantId);
  assert.deepEqual(decrypted, { geminiApiKey: dummyGeminiKey });

  const saved = { ...encryptedRecord };
  encryptedRecord = { ...saved, tenant_id: otherTenantId };
  await assert.rejects(
    readTenantProviderSecrets(otherTenantId),
    /Could not decrypt stored provider secrets/,
  );

  const ciphertext = String(saved.ciphertext);
  const tampered = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
  encryptedRecord = { ...saved, ciphertext: tampered };
  await assert.rejects(
    readTenantProviderSecrets(tenantId),
    /Could not decrypt stored provider secrets/,
  );

  encryptedRecord = {};
  hasEncryptedRecord = false;
});
