import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, test } from 'node:test';
import { HttpError } from '../http.js';
import { CALCOM_NOT_FOUND, CALCOM_REJECTED, GEMINI_REJECTED, parseEventTypeId, setupCalendar, setupDatabase, setupGemini } from './providerSetup.js';

const env = process.env as Record<string, string | undefined>;
const saved = { node: env.NODE_ENV, gemini: env.GEMINI_LIVE_ORIGIN, cal: env.CALCOM_API_URL };
let respond: (url: string) => { status: number; body?: unknown } = () => ({ status: 200, body: {} });
let server: Server;
let origin = '';

before(async () => {
  server = createServer((request, response) => {
    const result = respond(request.url ?? '');
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  env.NODE_ENV = 'development';
  env.GEMINI_LIVE_ORIGIN = origin;
  env.CALCOM_API_URL = `${origin}/v2`;
});
afterEach(() => { respond = () => ({ status: 200, body: {} }); });
after(async () => {
  for (const [name, value] of [['NODE_ENV', saved.node], ['GEMINI_LIVE_ORIGIN', saved.gemini], ['CALCOM_API_URL', saved.cal]] as const) {
    if (value === undefined) delete env[name]; else env[name] = value;
  }
  await new Promise((resolve) => server.close(resolve));
});

test('a Gemini key that Google accepts is saved as configured', async () => {
  const result = await setupGemini('  AIza-good-key  ');
  assert.deepEqual(result.secrets, { geminiApiKey: 'AIza-good-key' });
  assert.equal(result.status.configured, true);
  assert.equal(result.status.problem, undefined);
  assert.equal(result.warning, undefined);
});

test('a Gemini key that Google rejects is still saved, with the problem recorded', async () => {
  respond = () => ({ status: 403 });
  const result = await setupGemini('AIza-bad-key');
  assert.deepEqual(result.secrets, { geminiApiKey: 'AIza-bad-key' });
  assert.equal(result.status.configured, false);
  assert.equal(result.status.problem, GEMINI_REJECTED);
  assert.equal(result.warning, GEMINI_REJECTED);
});

test('a provider outage never blocks saving a Gemini key', async () => {
  respond = () => ({ status: 503 });
  const result = await setupGemini('AIza-key');
  assert.equal(result.status.configured, true);
  assert.equal(result.warning, undefined);
});

test('an empty Gemini key is the only thing refused', async () => {
  await assert.rejects(() => setupGemini('   '), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('a database that cannot be reached is saved with the problem recorded', async () => {
  env.NODE_ENV = 'development';
  const result = await setupDatabase('t1', 'http://127.0.0.1:1', 'sb_secret_abcdefghijklmnopqrstuv');
  assert.deepEqual(result.secrets, { supabaseUrl: 'http://127.0.0.1:1', supabaseSecretKey: 'sb_secret_abcdefghijklmnopqrstuv' });
  assert.equal(result.status.configured, false);
  assert.match(result.status.problem ?? '', /Could not reach/);
  assert.match(result.message, /^Saved, but it is not working yet\. Could not reach/);
});

test('input that is not a Supabase project or key cannot be stored and says what to enter', async () => {
  await assert.rejects(() => setupDatabase('t1', 'https://example.com', 'sb_secret_abcdefghijklmnopqrstuv'), (error: unknown) => error instanceof HttpError && /project URL/.test(error.message));
  await assert.rejects(() => setupDatabase('t1', 'http://127.0.0.1:1', 'short'), (error: unknown) => error instanceof HttpError && /secret key/.test(error.message));
});

test('event type IDs may be numbers or typed text; anything else is explained', () => {
  assert.equal(parseEventTypeId(7768457), 7768457);
  assert.equal(parseEventTypeId(' 7768457 '), 7768457);
  assert.equal(parseEventTypeId(''), null);
  assert.equal(parseEventTypeId(null), null);
  assert.equal(parseEventTypeId(undefined), null);
  for (const bad of ['abc', '12ab', '-3', '1.5', '1'.repeat(20)]) {
    assert.throws(() => parseEventTypeId(bad), (error: unknown) => error instanceof HttpError && error.status === 400 && /event type ID/.test(error.message));
  }
});

test('a Cal.com key with no event yet is saved and says what is missing', async () => {
  const result = await setupCalendar({ apiKey: 'cal_live_abc' }, {});
  assert.deepEqual(result.secrets, { calcomApiKey: 'cal_live_abc' });
  assert.equal(result.status.configured, false);
  assert.equal(result.status.problem, undefined);
  assert.match(result.message, /Add the event type ID or an event link/);
});

test('an event with no key yet is saved and says what is missing', async () => {
  const result = await setupCalendar({ eventTypeId: 55 }, {});
  assert.deepEqual(result.secrets, {});
  assert.deepEqual(result.calendar, { event_type_id: 55, event_type_slug: null, username: null, team_slug: null });
  assert.equal(result.status.configured, false);
  assert.match(result.message, /Add the API key/);
});

test('a working Cal.com setup is configured', async () => {
  respond = () => ({ status: 200, body: { status: 'success', data: { slots: {} } } });
  const result = await setupCalendar({ apiKey: 'cal_live_abc', eventTypeId: 55 }, {});
  assert.equal(result.status.configured, true);
  assert.equal(result.status.problem, undefined);
});

test('Cal.com rejecting the key or the event is recorded, and everything is still saved', async () => {
  respond = () => ({ status: 401, body: { status: 'error' } });
  const rejected = await setupCalendar({ apiKey: 'cal_live_bad', eventTypeId: 55 }, {});
  assert.deepEqual(rejected.secrets, { calcomApiKey: 'cal_live_bad' });
  assert.equal(rejected.status.configured, false);
  assert.equal(rejected.status.problem, CALCOM_REJECTED);
  assert.equal(rejected.calendar?.event_type_id, 55);

  respond = () => ({ status: 404, body: { status: 'error' } });
  const missing = await setupCalendar({ apiKey: 'cal_live_abc', eventTypeId: 99 }, {});
  assert.equal(missing.status.problem, CALCOM_NOT_FOUND);
  assert.equal(missing.calendar?.event_type_id, 99);
});

test('nothing at all to save is the only Cal.com refusal', async () => {
  await assert.rejects(() => setupCalendar({}, {}), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('a stored key and event are reused when only one half is updated', async () => {
  respond = () => ({ status: 200, body: { status: 'success', data: { slots: {} } } });
  const result = await setupCalendar({ eventTypeId: 77 }, { apiKey: 'cal_live_stored' });
  assert.deepEqual(result.secrets, {});
  assert.equal(result.status.configured, true);
});
