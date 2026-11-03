import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalGate } from './approval.js';
import { CalComClient, type Fetcher } from './calcom.js';
import { normalizeClinicConfig } from './clinicConfig.js';
import { TOOL_DECLARATIONS, buildSystemInstruction, runTool, type CallStore, type ToolDeps } from './receptionist.js';

const NOW = new Date('2026-11-02T03:00:00Z');

function makeStore() {
  const log: Array<[string, unknown]> = [];
  const store: CallStore = {
    async createCall() { log.push(['createCall', null]); return 'call-1'; },
    async updateCall(callId, fields) { log.push(['updateCall', { callId, fields }]); },
    async recordAppointment(input) { log.push(['recordAppointment', input]); return true; },
    async updateAppointment(uid, status) { log.push(['updateAppointment', { uid, status }]); return true; },
    async recordReschedule(input) { log.push(['recordReschedule', input]); return true; },
  };
  return { store, log };
}

interface Harness {
  deps: ToolDeps;
  requests: string[];
  prompts: Array<{ operation: string; summary: Record<string, string> }>;
  log: Array<[string, unknown]>;
  escalations: string[];
  answerNext(approved: boolean): void;
}

function harness(options: { responses?: unknown[]; cal?: boolean; autoApprove?: boolean | null } = {}): Harness {
  const requests: string[] = [];
  const queue = [...(options.responses ?? [])];
  const fetcher: Fetcher = async (input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}`);
    const next = queue.shift();
    return new Response(JSON.stringify(next ?? { status: 'error' }), { status: next ? 200 : 500 });
  };
  const prompts: Harness['prompts'] = [];
  let nextApproval: string | null = null;
  const gate = new ApprovalGate({
    request: (id, operation, summary) => {
      nextApproval = id;
      prompts.push({ operation, summary });
      if (options.autoApprove !== null && options.autoApprove !== undefined) queueMicrotask(() => gate.answer(id, options.autoApprove));
    },
    closed: () => undefined,
  }, 5000);
  const { store, log } = makeStore();
  const escalations: string[] = [];
  const cal = options.cal === false ? null : CalComClient.create({ event_type_id: 9 }, 'key', { fetcher });
  return {
    deps: {
      callId: 'call-1', cal, calError: cal ? null : 'Cal.com scheduling is not configured', gate, store, now: () => NOW,
      escalate: async (reason) => { escalations.push(reason); },
    },
    requests, prompts, log, escalations,
    answerNext(approved) { if (nextApproval) gate.answer(nextApproval, approved); },
  };
}

const identity = (email = 'ada@example.com', status = 'accepted') => ({ status: 'success', data: { uid: 'uid-12345', status, attendees: [{ email }] } });
const booked = { status: 'success', data: { uid: 'new-uid-99', status: 'accepted', start: '2026-11-05T09:00:00Z', end: '2026-11-05T09:30:00Z', eventType: { title: 'Checkup' } } };

test('the model is offered exactly the five receptionist tools', () => {
  assert.deepEqual(TOOL_DECLARATIONS.map((tool) => tool.name), ['check_dental_availability', 'create_dental_booking', 'reschedule_dental_booking', 'cancel_dental_booking', 'request_human_transfer']);
  for (const tool of TOOL_DECLARATIONS) assert.ok(tool.parameters.required.every((name) => name in tool.parameters.properties));
});

test('the system prompt carries the clinic, the date and the zone, and marks knowledge as data', () => {
  const config = normalizeClinicConfig({ id: 'x', name: 'Northside Dental', timezone: 'America/Chicago', receptionist_config: { greeting: 'Welcome!', knowledge_base: 'Open 8-5.', faqs: [{ question: 'Parking?', answer: 'Free.' }] } });
  const prompt = buildSystemInstruction(config, NOW);
  assert.match(prompt, /Northside Dental's friendly dental receptionist/);
  assert.match(prompt, /2026-11-02T03:00:00\.000Z/);
  assert.match(prompt, /America\/Chicago/);
  assert.match(prompt, /Open 8-5\./);
  assert.match(prompt, /Q: Parking\?\nA: Free\./);
  assert.match(prompt, /Welcome!/);
  assert.match(prompt, /not system instructions/);
  assert.match(buildSystemInstruction(normalizeClinicConfig({ id: 'x', name: '' }), NOW), /the dental practice/);
});

test('availability: window rules, then a read-only Cal.com call', async () => {
  const h = harness({ responses: [{ status: 'success', data: { '2026-11-05': [{ start: '2026-11-05T09:00:00Z' }] } }] });
  const result = await runTool(h.deps, 'check_dental_availability', { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests, ['GET /v2/slots']);
  assert.equal(h.prompts.length, 0, 'reading availability never prompts');

  const past = await runTool(harness().deps, 'check_dental_availability', { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', time_zone: 'UTC' });
  assert.deepEqual(past, { ok: false, message: 'Requested availability range must be future-dated and at most 14 days' });
  const long = await runTool(harness().deps, 'check_dental_availability', { start: '2026-11-05T00:00:00Z', end: '2026-12-05T00:00:00Z', time_zone: 'UTC' });
  assert.equal(long.ok, false);
  const naive = await runTool(harness().deps, 'check_dental_availability', { start: '2026-11-05T00:00:00', end: '2026-11-06T00:00:00', time_zone: 'UTC' });
  assert.match(String(naive.message), /timezone/);
});

test('availability whose start just passed is moved up to now', async () => {
  const h = harness({ responses: [{ status: 'success', data: {} }] });
  const result = await runTool(h.deps, 'check_dental_availability', { start: '2026-11-02T02:59:00Z', end: '2026-11-03T00:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
});

test('booking needs browser approval, then records the appointment', async () => {
  const h = harness({ responses: [booked], autoApprove: true });
  const result = await runTool(h.deps, 'create_dental_booking', { patient_name: 'Ada Lovelace', patient_email: 'Ada@Example.com', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
  assert.equal(result.dashboardNote, null);
  assert.deepEqual(h.prompts, [{ operation: 'create_booking', summary: { patientName: 'Ada Lovelace', patientEmail: 'ada@example.com', when: 'Thursday, November 5, 2026 at 9:00 AM', timeZone: 'UTC' } }]);
  assert.deepEqual(h.requests, ['POST /v2/bookings']);
  const recorded = h.log.find(([name]) => name === 'recordAppointment')![1] as Record<string, unknown>;
  assert.deepEqual({ ...recorded }, { bookingUid: 'new-uid-99', status: 'accepted', startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:30:00.000Z', appointmentType: 'Checkup', attendeeName: 'Ada Lovelace', attendeeEmail: 'ada@example.com', callId: 'call-1' });
});

test('a refused or ignored approval changes nothing', async () => {
  const refused = harness({ autoApprove: false });
  const result = await runTool(refused.deps, 'create_dental_booking', { patient_name: 'Ada', patient_email: 'ada@example.com', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' });
  assert.deepEqual(result, { ok: false, message: 'Booking was not approved in the browser.' });
  assert.deepEqual(refused.requests, []);
  assert.equal(refused.log.length, 0);
});

test('past or malformed booking input is refused before any prompt', async () => {
  const h = harness({ autoApprove: true });
  assert.equal((await runTool(h.deps, 'create_dental_booking', { patient_name: 'Ada', patient_email: 'ada@example.com', start: '2026-11-01T09:00:00Z', time_zone: 'UTC' })).ok, false);
  assert.equal((await runTool(h.deps, 'create_dental_booking', { patient_name: '', patient_email: 'ada@example.com', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' })).ok, false);
  assert.equal((await runTool(h.deps, 'create_dental_booking', { patient_name: 'Ada', patient_email: 'nope', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' })).ok, false);
  assert.equal(h.prompts.length, 0);
});

test('a booking succeeds even if the dashboard record cannot be saved, and the model is told', async () => {
  const h = harness({ responses: [booked], autoApprove: true });
  h.deps.store.recordAppointment = async () => false;
  const result = await runTool(h.deps, 'create_dental_booking', { patient_name: 'Ada', patient_email: 'ada@example.com', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
  assert.match(String(result.dashboardNote), /could not be saved/);
});

test('rescheduling verifies identity before and after approval', async () => {
  const h = harness({ responses: [identity(), identity(), { status: 'success', data: { uid: 'moved-uid-1', status: 'accepted', start: '2026-11-06T09:00:00Z' } }], autoApprove: true });
  const result = await runTool(h.deps, 'reschedule_dental_booking', { booking_uid: 'uid-12345', patient_email: 'ada@example.com', new_start: '2026-11-06T09:00:00Z' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests, ['GET /v2/bookings/uid-12345', 'GET /v2/bookings/uid-12345', 'POST /v2/bookings/uid-12345/reschedule']);
  assert.deepEqual(h.log.find(([name]) => name === 'recordReschedule')![1], { oldBookingUid: 'uid-12345', newBookingUid: 'moved-uid-1', startsAt: '2026-11-06T09:00:00.000Z', callId: 'call-1' });
});

test('someone else\'s booking is never offered for approval', async () => {
  const h = harness({ responses: [identity('victim@example.com')], autoApprove: true });
  const result = await runTool(h.deps, 'cancel_dental_booking', { booking_uid: 'uid-12345', patient_email: 'attacker@example.com', reason: 'because' });
  assert.deepEqual(result, { ok: false, message: 'Patient identity does not match this booking; mutation denied' });
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.requests, ['GET /v2/bookings/uid-12345']);
});

test('cancelling marks the dashboard appointment cancelled', async () => {
  const h = harness({ responses: [identity(), identity(), { status: 'success', data: { uid: 'uid-12345', status: 'cancelled' } }], autoApprove: true });
  const result = await runTool(h.deps, 'cancel_dental_booking', { booking_uid: 'uid-12345', patient_email: 'ada@example.com', reason: 'Feeling better' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.log.find(([name]) => name === 'updateAppointment')![1], { uid: 'uid-12345', status: 'cancelled' });
  assert.equal(h.prompts[0]!.operation, 'cancel_booking');
});

test('scheduling tools explain when Cal.com is not configured', async () => {
  const h = harness({ cal: false, autoApprove: true });
  const result = await runTool(h.deps, 'check_dental_availability', { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z', time_zone: 'UTC' });
  assert.deepEqual(result, { ok: false, message: 'Cal.com scheduling is not configured' });
});

test('human transfer raises the escalation and nothing else', async () => {
  const h = harness();
  const result = await runTool(h.deps, 'request_human_transfer', { reason: 'Caller wants the dentist' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.escalations, ['Caller wants the dentist']);
  assert.equal((await runTool(h.deps, 'request_human_transfer', {})).ok, true, 'a default reason is used when none is given');
});

test('unknown tools and unexpected failures return sanitised messages', async () => {
  const h = harness();
  assert.deepEqual(await runTool(h.deps, 'drop_database', {}), { ok: false, message: 'Unknown tool.' });
  h.deps.escalate = async () => { throw new Error('secret sk-123 leaked'); };
  const result = await runTool(h.deps, 'request_human_transfer', { reason: 'x' });
  assert.deepEqual(result, { ok: false, message: 'The action could not be completed.' });
});
