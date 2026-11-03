import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { VOICE_SUBPROTOCOL, bearerToken, canonicalOrigin, subprotocolToken, validOrigin, verifyVoiceToken } from './voiceAuth.js';

const tenantId = 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4';
const otherTenantId = '7c62c466-76b8-42ca-93c2-34433dd87059';
const secretHex = 'ab'.repeat(32);
const key = new TextEncoder().encode(secretHex);

async function token(claims: Record<string, unknown>, options: { iat?: number; exp?: number; secret?: Uint8Array } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(options.iat ?? now)
    .setExpirationTime(options.exp ?? now + 120)
    .sign(options.secret ?? key);
}

const valid = { tenantId, purpose: 'voice' };

test('accepts a fresh token for the matching clinic', async () => {
  const claims = await verifyVoiceToken(await token(valid), tenantId, secretHex);
  assert.equal(claims?.tenantId, tenantId);
});

test('rejects a token minted for a different clinic', async () => {
  assert.equal(await verifyVoiceToken(await token({ ...valid, tenantId: otherTenantId }), tenantId, secretHex), null);
});

test('rejects a token signed with another key', async () => {
  const forged = await token(valid, { secret: new TextEncoder().encode('cd'.repeat(32)) });
  assert.equal(await verifyVoiceToken(forged, tenantId, secretHex), null);
});

test('rejects expired tokens and tokens with a lifetime over three minutes', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyVoiceToken(await token(valid, { iat: now - 400, exp: now - 100 }), tenantId, secretHex), null);
  assert.equal(await verifyVoiceToken(await token(valid, { iat: now, exp: now + 3600 }), tenantId, secretHex), null);
});

test('rejects the wrong purpose and non-token input', async () => {
  assert.equal(await verifyVoiceToken(await token({ ...valid, purpose: 'agent_bridge' }), tenantId, secretHex), null);
  assert.equal(await verifyVoiceToken(null, tenantId, secretHex), null);
  assert.equal(await verifyVoiceToken('not-a-token', tenantId, secretHex), null);
});

test('rejects an unsigned (alg none) token', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...valid, iat: now, exp: now + 60 })).toString('base64url');
  assert.equal(await verifyVoiceToken(`${header}.${body}.`, tenantId, secretHex), null);
});

test('canonicalOrigin only accepts bare http(s) origins', () => {
  assert.equal(canonicalOrigin('https://app.example.com'), 'https://app.example.com');
  assert.equal(canonicalOrigin('https://app.example.com/path'), null);
  assert.equal(canonicalOrigin('https://user:pw@app.example.com'), null);
  assert.equal(canonicalOrigin('ftp://app.example.com'), null);
  assert.equal(canonicalOrigin('not a url'), null);
  assert.equal(canonicalOrigin(null), null);
});

test('WebSocket upgrades must carry an exactly matching Origin header', () => {
  const expected = 'https://app.example.com';
  const make = (origin?: string) => new Request(`${expected}/agents/${tenantId}/ws`, { headers: origin ? { origin } : {} });
  assert.equal(validOrigin(make(expected), expected, true), true);
  assert.equal(validOrigin(make(), expected, true), false);
  assert.equal(validOrigin(make('https://evil.example.com'), expected, true), false);
  assert.equal(validOrigin(make('https://app.example.com.evil.com'), expected, true), false);
});

test('same-origin GETs may omit Origin when it is not required, other methods may not', () => {
  const expected = 'https://app.example.com';
  assert.equal(validOrigin(new Request(`${expected}/agents/${tenantId}/ws`), expected, false), true);
  assert.equal(validOrigin(new Request(`https://other.example.com/agents/${tenantId}/ws`), expected, false), false);
  assert.equal(validOrigin(new Request(`${expected}/agents/${tenantId}/ws`, { method: 'POST' }), expected, false), false);
});

test('bearerToken extracts only well-formed tokens', () => {
  const good = 'a'.repeat(40);
  assert.equal(bearerToken(new Request('https://x.test/', { headers: { authorization: `Bearer ${good}` } })), good);
  assert.equal(bearerToken(new Request('https://x.test/', { headers: { authorization: 'Bearer short' } })), null);
  assert.equal(bearerToken(new Request('https://x.test/')), null);
});

test('the voice token is read from the offered subprotocols, never the URL', () => {
  const good = 'a'.repeat(40);
  const make = (protocols: string | null, url = 'https://x.test/agents/x/ws') =>
    new Request(url, protocols === null ? {} : { headers: { 'sec-websocket-protocol': protocols } });
  assert.equal(subprotocolToken(make(`${VOICE_SUBPROTOCOL}, bearer.${good}`)), good);
  assert.equal(subprotocolToken(make(`bearer.${good}, ${VOICE_SUBPROTOCOL}`)), good);
  assert.equal(subprotocolToken(make(`bearer.${good}`)), null, 'the voice subprotocol must be offered too');
  assert.equal(subprotocolToken(make(`${VOICE_SUBPROTOCOL}, bearer.short`)), null);
  assert.equal(subprotocolToken(make(VOICE_SUBPROTOCOL)), null);
  assert.equal(subprotocolToken(make(null, `https://x.test/agents/x/ws?token=${good}`)), null);
});
