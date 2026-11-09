import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalComClient, CalComError, type Fetcher } from './calcom.js';

interface Recorded { url: URL; method: string; headers: Record<string, string>; body: unknown }

function fakeFetcher(responses: Array<{ status?: number; body?: unknown } | Error>): { fetcher: Fetcher; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const fetcher: Fetcher = async (input, init) => {
    calls.push({
      url: new URL(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  };
  return { fetcher, calls };
}

const ok = (data: unknown) => ({ body: { status: 'success', data } });

test('selector validation mirrors the clinic settings rules', () => {
  const key = 'cal_key';
  assert.throws(() => CalComClient.create({}, key), /exactly one Cal\.com event type ID or slug/);
  assert.throws(() => CalComClient.create({ event_type_id: 1, event_type_slug: 'x' }, key), /exactly one/);
  assert.throws(() => CalComClient.create({ event_type_slug: 'x' }, key), /exactly one clinic username or team slug/);
  assert.throws(() => CalComClient.create({ event_type_slug: 'x', username: 'a', team_slug: 'b' }, key), /exactly one clinic username or team slug/);
  assert.throws(() => CalComClient.create({ event_type_id: '12abc' }, key), /positive integer/);
  assert.throws(() => CalComClient.create({ event_type_id: 0 }, key), /positive integer/);
  assert.throws(() => CalComClient.create({ event_type_id: 5 }, undefined), /not configured/);
  assert.throws(() => CalComClient.create({ event_type_id: 5 }, '   '), /not configured/);
  CalComClient.create({ event_type_id: '42' }, key);
  CalComClient.create({ event_type_slug: 'checkup', username: 'northside' }, key);
  CalComClient.create({ event_type_slug: 'checkup', team_slug: 'northside' }, key);
});

test('availability queries use the slots API version and the right selector', async () => {
  const { fetcher, calls } = fakeFetcher([ok({ '2026-11-05': [{ start: '2026-11-05T09:00:00Z' }] })]);
  const client = CalComClient.create({ event_type_slug: 'checkup', team_slug: 'north' }, 'secret-key', { fetcher });
  const result = await client.availableSlots(new Date('2026-11-05T00:00:00Z'), new Date('2026-11-06T00:00:00Z'), 'America/Chicago');
  assert.deepEqual(result, { '2026-11-05': [{ start: '2026-11-05T09:00:00Z' }] });
  const [call] = calls;
  assert.equal(call!.url.pathname, '/v2/slots');
  assert.equal(call!.headers['cal-api-version'], '2024-09-04');
  assert.equal(call!.headers.Authorization, 'Bearer secret-key');
  assert.equal(call!.url.searchParams.get('eventTypeSlug'), 'checkup');
  assert.equal(call!.url.searchParams.get('teamSlug'), 'north');
  assert.equal(call!.url.searchParams.get('username'), null);
  assert.equal(call!.url.searchParams.get('start'), '2026-11-05T00:00:00Z');
  assert.equal(call!.url.searchParams.get('timeZone'), 'America/Chicago');
});

test('creating a booking posts the attendee and returns only a safe summary', async () => {
  const { fetcher, calls } = fakeFetcher([ok({ uid: 'uid123', status: 'accepted', start: '2026-11-05T09:00:00.000Z', end: '2026-11-05T09:30:00.000Z', eventType: { title: 'Checkup' }, secretInternal: 'x', attendees: [{ email: 'a@b.co' }] })]);
  const client = CalComClient.create({ event_type_id: 77 }, 'k', { fetcher });
  const booking = await client.createBooking({ name: 'Ada', email: 'ada@example.com', start: new Date('2026-11-05T09:00:00Z'), timeZone: 'UTC' });
  assert.deepEqual(booking, { uid: 'uid123', status: 'accepted', start: '2026-11-05T09:00:00.000Z', end: '2026-11-05T09:30:00.000Z', eventType: { title: 'Checkup' } });
  assert.equal(calls[0]!.headers['cal-api-version'], '2026-02-25');
  assert.deepEqual(calls[0]!.body, { eventTypeId: 77, start: '2026-11-05T09:00:00Z', attendee: { name: 'Ada', email: 'ada@example.com', timeZone: 'UTC', language: 'en' }, metadata: { source: 'metisai-receptionist' } });
});

test('a booking carries the phone number and the reason for the visit', async () => {
  const { fetcher, calls } = fakeFetcher([ok({ uid: 'uid123', status: 'accepted', start: '2026-11-05T09:00:00.000Z' })]);
  const client = CalComClient.create({ event_type_id: 77 }, 'k', { fetcher });
  await client.createBooking({ name: 'Ada', email: 'ada@example.com', start: new Date('2026-11-05T09:00:00Z'), timeZone: 'UTC', phone: '+14155550123', reason: 'Cleaning' });
  assert.deepEqual(calls[0]!.body, { eventTypeId: 77, start: '2026-11-05T09:00:00Z', attendee: { name: 'Ada', email: 'ada@example.com', timeZone: 'UTC', language: 'en', phoneNumber: '+14155550123' }, metadata: { reason: 'Cleaning', source: 'metisai-receptionist' } });
});

test('attendee identity must match and the booking must still be open', async () => {
  const booking = (status: string, email = 'Ada@Example.com') => ok({ uid: 'u', status, attendees: [{ email }] });
  const make = (responses: Parameters<typeof fakeFetcher>[0]) => CalComClient.create({ event_type_id: 1 }, 'k', { fetcher: fakeFetcher(responses).fetcher });
  await make([booking('accepted')]).requireAttendeeIdentity('uid-12345', 'ada@example.com');
  await assert.rejects(make([booking('accepted', 'other@example.com')]).requireAttendeeIdentity('uid-12345', 'ada@example.com'), /does not match/);
  await assert.rejects(make([booking('cancelled')]).requireAttendeeIdentity('uid-12345', 'ada@example.com'), /current status/);
  await assert.rejects(make([ok({ uid: 'u', status: 'accepted', attendees: [] })]).requireAttendeeIdentity('uid-12345', 'ada@example.com'), /attendee identity/);
  await assert.rejects(make([ok([{ uid: 'u' }, { uid: 'v' }] as unknown as object)]).requireAttendeeIdentity('uid-12345', 'ada@example.com'), /ambiguous/);
});

test('reschedule and cancel use the booking endpoints with the booking API version', async () => {
  const { fetcher, calls } = fakeFetcher([ok({ uid: 'new-uid-1', status: 'accepted', start: '2026-11-06T09:00:00Z' }), ok({ uid: 'uid-12345', status: 'cancelled' })]);
  const client = CalComClient.create({ event_type_id: 1 }, 'k', { fetcher });
  await client.rescheduleBooking('uid-12345', { email: 'ada@example.com', newStart: new Date('2026-11-06T09:00:00Z') });
  await client.cancelBooking('uid-12345', 'Patient asked');
  assert.equal(calls[0]!.url.pathname, '/v2/bookings/uid-12345/reschedule');
  assert.equal(calls[0]!.body && (calls[0]!.body as Record<string, unknown>).rescheduledBy, 'ada@example.com');
  assert.equal(calls[1]!.url.pathname, '/v2/bookings/uid-12345/cancel');
  assert.deepEqual(calls[1]!.body, { cancellationReason: 'Patient asked' });
  assert.ok(calls.every((call) => call.headers['cal-api-version'] === '2026-02-25'));
});

test('HTTP failures become friendly errors that never contain credentials; a refused request says why, with the key hidden', async () => {
  const cases: Array<[number, RegExp]> = [[401, /credentials/], [403, /credentials/], [404, /not found/], [409, /no longer available/], [429, /rate limit/], [500, /could not complete/], [400, /refused the request: leaks \[hidden\]/], [422, /refused the request/]];
  for (const [status, pattern] of cases) {
    const client = CalComClient.create({ event_type_id: 1 }, 'super-secret', { fetcher: fakeFetcher([{ status, body: { message: 'leaks super-secret' } }]).fetcher });
    await assert.rejects(client.availableSlots(new Date(), new Date(), 'UTC'), (error: unknown) => {
      assert.ok(error instanceof CalComError);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    });
  }
  const unreachable = CalComClient.create({ event_type_id: 1 }, 'super-secret', { fetcher: fakeFetcher([new Error('connect ECONNREFUSED super-secret')]).fetcher });
  await assert.rejects(unreachable.availableSlots(new Date(), new Date(), 'UTC'), (error: unknown) => error instanceof CalComError && error.message === 'Cal.com could not be reached');
});

test('a refused request carries only a short, cleaned reason from Cal.com', async () => {
  const run = (body: unknown) => CalComClient.create({ event_type_id: 1 }, 'cal_live_abc123', { fetcher: fakeFetcher([{ status: 400, body }]).fetcher }).createBooking({ name: 'A', email: 'a@b.co', start: new Date(), timeZone: 'UTC' });
  await assert.rejects(run({ status: 'error', error: { message: 'Attendee phone number is invalid' } }), { message: 'Cal.com refused the request: Attendee phone number is invalid' });
  await assert.rejects(run({ message: ['start must be a future date', 'email is invalid'] }), { message: 'Cal.com refused the request: start must be a future date; email is invalid' });
  await assert.rejects(run({ error: { message: 'bad Bearer cal_live_zzz and cal_live_abc123' } }), (error: unknown) => error instanceof CalComError && !/cal_live_/.test(error.message));
  await assert.rejects(run('not json'), { message: 'Cal.com refused the request' });
  await assert.rejects(run({ message: 'x'.repeat(2000) }), (error: unknown) => error instanceof CalComError && error.message.length < 260);
});

test('unsuccessful or empty payloads are rejected', async () => {
  const run = (response: Parameters<typeof fakeFetcher>[0][number]) =>
    CalComClient.create({ event_type_id: 1 }, 'k', { fetcher: fakeFetcher([response]).fetcher }).availableSlots(new Date(), new Date(), 'UTC');
  await assert.rejects(run({ body: { status: 'error', error: {} } }), /unsuccessful/);
  await assert.rejects(run({ body: { status: 'success' } }), /incomplete/);
  await assert.rejects(run({ body: [] }), /unsuccessful/);
});
