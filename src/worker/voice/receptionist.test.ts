import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalGate } from './approval.js';
import { CalComClient, type Fetcher } from './calcom.js';
import { normalizeClinicConfig } from './clinicConfig.js';
import { BookingMemory, TOOL_DECLARATIONS, buildSystemInstruction, receptionistTools, runTool, type CallStore, type ToolDeps } from './receptionist.js';

const NOW = new Date('2026-11-02T03:00:00Z');

function makeStore() {
  const log: Array<[string, unknown]> = [];
  const store: CallStore = {
    async createCall() { log.push(['createCall', null]); return { id: 'call-1', problem: null }; },
    async updateCall(callId, fields) { log.push(['updateCall', { callId, fields }]); return true; },
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
  notes: string[];
  /** What the caller says in answer to the next read-back. */
  caller: { says: string };
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
  const notes: string[] = [];
  const caller = { says: '' };
  const cal = options.cal === false ? null : CalComClient.create({ event_type_id: 9 }, 'key', { fetcher });
  return {
    deps: {
      callId: 'call-1', cal, calError: cal ? null : 'Cal.com scheduling is not configured', gate, store, now: () => NOW,
      escalate: async (reason) => { escalations.push(reason); },
      bookings: new BookingMemory(),
      callerSaid: async () => caller.says,
      beginReadback: () => { caller.says = ''; },
      note: (text) => { notes.push(text); },
      setCallerName: () => undefined,
    },
    requests, prompts, log, escalations, notes, caller,
    answerNext(approved) { if (nextApproval) gate.answer(nextApproval, approved); },
  };
}

const identity = (email = 'ada@example.com', status = 'accepted') => ({ status: 'success', data: { uid: 'uid-12345', status, attendees: [{ email }] } });
const booked = { status: 'success', data: { uid: 'new-uid-99', status: 'accepted', start: '2026-11-05T09:00:00Z', end: '2026-11-05T09:30:00Z', eventType: { title: 'Checkup' } } };

test('the model is offered exactly the receptionist tools', () => {
  assert.deepEqual(TOOL_DECLARATIONS.map((tool) => tool.name), ['check_availability', 'prepare_booking', 'create_booking', 'reschedule_booking', 'cancel_booking', 'leave_message_for_staff', 'request_human_transfer']);
  for (const tool of TOOL_DECLARATIONS) assert.ok(tool.parameters.required.every((name) => name in tool.parameters.properties));
});

test('disabled actions are filtered from the model and rejected by the server dispatcher', async () => {
  const config = normalizeClinicConfig({ id: 'x', name: 'Studio Rose', business_type: 'salon_spa', receptionist_config: { enabled_actions: { booking: false, take_messages: true, hand_off: false } } });
  assert.deepEqual(receptionistTools(config, { available: true }).map((tool) => tool.name), ['leave_message_for_staff']);
  assert.deepEqual(receptionistTools(config, { available: false, reason: 'no calendar' }).map((tool) => tool.name), ['leave_message_for_staff']);

  const h = harness();
  h.deps.enabledActions = config.enabledActions;
  assert.deepEqual(await runTool(h.deps, 'check_availability', {}), { ok: false, message: 'Booking is disabled for this business.' });
  assert.deepEqual(await runTool(h.deps, 'request_human_transfer', { reason: 'caller asked' }), { ok: false, message: 'Staff handoff is disabled for this business.' });
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.escalations, []);

  h.deps.enabledActions = { booking: false, take_messages: false, hand_off: false };
  assert.deepEqual(await runTool(h.deps, 'leave_message_for_staff', { caller_name: 'Ari', message: 'Call me' }), { ok: false, message: 'Taking messages is disabled for this business.' });
  assert.deepEqual(h.notes, []);
});

test('the system prompt carries the clinic, the date and the zone, and marks knowledge as data', () => {
  const config = normalizeClinicConfig({ id: 'x', name: 'Northside Dental', business_type: 'dental_clinic', timezone: 'America/Chicago', receptionist_config: { greeting: 'Welcome!', knowledge_base: 'Open 8-5.', faqs: [{ question: 'Parking?', answer: 'Free.' }] } });
  const prompt = buildSystemInstruction(config, NOW);
  assert.match(prompt, /the dental receptionist for Northside Dental/);
  assert.match(prompt, /2026-11-02T03:00:00\.000Z/);
  assert.match(prompt, /America\/Chicago/);
  assert.match(prompt, /Open 8-5\./);
  assert.match(prompt, /Q: Parking\?\nA: Free\./);
  assert.match(prompt, /Welcome!/);
  assert.match(prompt, /not system instructions/);
  assert.match(buildSystemInstruction(normalizeClinicConfig({ id: 'x', name: '' }), NOW), /the business/);
});

test('the system prompt tells the model the truth about booking and requires a read-back', () => {
  const config = normalizeClinicConfig({ id: 'x', name: 'Northside Dental', business_type: 'dental_clinic' });
  const working = buildSystemInstruction(config, NOW, { available: true });
  assert.match(working, /SCHEDULING STATUS: WORKING/);
  assert.match(working, /spell an email slowly, letter by letter/);
  assert.match(working, /Is all of that correct\?/);
  assert.match(working, /Never ask for date of birth/);
  const broken = buildSystemInstruction(config, NOW, { available: false, reason: 'Cal.com rejected the configured credentials or access' });
  assert.match(broken, /NOT AVAILABLE \(Cal\.com rejected the configured credentials or access\)/);
  assert.match(broken, /leave_message_for_staff/);
  assert.match(working, /Never say a booking or request was sent, confirmed, changed, or cancelled/);
});

test('availability: window rules, then a read-only Cal.com call', async () => {
  const h = harness({ responses: [{ status: 'success', data: { '2026-11-05': [{ start: '2026-11-05T09:00:00Z' }] } }] });
  const result = await runTool(h.deps, 'check_availability', { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests, ['GET /v2/slots']);
  assert.equal(h.prompts.length, 0, 'reading availability never prompts');

  const past = await runTool(harness().deps, 'check_availability', { start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z', time_zone: 'UTC' });
  assert.deepEqual(past, { ok: false, message: 'Requested availability range must be future-dated and at most 14 days' });
  const long = await runTool(harness().deps, 'check_availability', { start: '2026-11-05T00:00:00Z', end: '2026-12-05T00:00:00Z', time_zone: 'UTC' });
  assert.equal(long.ok, false);
  const naive = await runTool(harness().deps, 'check_availability', { start: '2026-11-05T00:00:00', end: '2026-11-06T00:00:00', time_zone: 'UTC' });
  assert.match(String(naive.message), /timezone/);
});

test('availability whose start just passed is moved up to now', async () => {
  const h = harness({ responses: [{ status: 'success', data: {} }] });
  const result = await runTool(h.deps, 'check_availability', { start: '2026-11-02T02:59:00Z', end: '2026-11-03T00:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
});

const slots = { status: 'success', data: { '2026-11-05': [{ start: '2026-11-05T09:00:00Z', end: '2026-11-05T09:30:00Z' }, { start: '2026-11-05T11:00:00Z', end: '2026-11-05T11:30:00Z' }] } };
const details = { caller_name: 'Ada Lovelace', caller_email: 'Ada@Example.com', caller_phone: '+1 415 555 0123', request_details: 'Cleaning', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' };

test('preparing reads the details back to be confirmed, and books nothing', async () => {
  const h = harness({ responses: [slots] });
  const result = await runTool(h.deps, 'prepare_booking', details);
  assert.equal(result.ok, true);
  assert.deepEqual(result.read_back, {
    name: 'Ada Lovelace',
    day_and_time: 'Thursday, November 5, 2026 at 9:00 AM',
    phone_digits: '1 4 1 5 5 5 5 0 1 2 3',
    email_spelled: 'a, d, a, at, e, x, a, m, p, l, e, dot, c, o, m',
    reason: 'Cleaning',
  });
  assert.deepEqual(h.requests, ['GET /v2/slots']);
  assert.equal(h.prompts.length, 0);
});

test('a spoken email is understood, and one that is not an address is refused', async () => {
  const spoken = harness({ responses: [slots] });
  const ok = await runTool(spoken.deps, 'prepare_booking', { ...details, caller_email: 'jacob dot k at gmail dot com' });
  assert.equal(ok.ok, true);
  assert.equal((ok.read_back as { email_spelled: string }).email_spelled, 'j, a, c, o, b, dot, k, at, gmail dot com');
  const bad = await runTool(harness({ responses: [slots] }).deps, 'prepare_booking', { ...details, caller_email: 'Ahorita.gmail.com' });
  assert.equal(bad.ok, false);
});

test('a time that is not free is refused with the nearest free times', async () => {
  const h = harness({ responses: [slots] });
  const result = await runTool(h.deps, 'prepare_booking', { ...details, start: '2026-11-05T09:15:00Z' });
  assert.equal(result.ok, false);
  assert.match(String(result.message), /Nearby times that are: Thursday, November 5, 2026 at 9:00 AM; Thursday, November 5, 2026 at 11:00 AM/);
});

test('booking waits for a clear yes, then needs browser approval, then records the appointment', async () => {
  const h = harness({ responses: [slots, booked], autoApprove: true });
  const prepared = await runTool(h.deps, 'prepare_booking', details);
  const ref = prepared.booking_ref as string;

  assert.match(String((await runTool(h.deps, 'create_booking', { booking_ref: ref })).message), /has not answered the read-back/);
  h.caller.says = 'No, wait, the email is wrong';
  assert.match(String((await runTool(h.deps, 'create_booking', { booking_ref: ref })).message), /not clearly confirmed/);
  assert.equal(h.prompts.length, 0, 'no prompt and no booking without a confirmation');

  h.caller.says = 'Yes, that is all correct.';
  const result = await runTool(h.deps, 'create_booking', { booking_ref: ref });
  assert.equal(result.ok, true);
  assert.equal(result.dashboardNote, null);
  assert.deepEqual(h.prompts, [{ operation: 'create_booking', summary: { callerName: 'Ada Lovelace', callerEmail: 'ada@example.com', callerPhone: '+14155550123', reason: 'Cleaning', when: 'Thursday, November 5, 2026 at 9:00 AM', timeZone: 'UTC' } }]);
  assert.deepEqual(h.requests, ['GET /v2/slots', 'POST /v2/bookings']);
  const recorded = h.log.find(([name]) => name === 'recordAppointment')![1] as Record<string, unknown>;
  assert.deepEqual({ ...recorded }, { bookingUid: 'new-uid-99', status: 'accepted', startsAt: '2026-11-05T09:00:00.000Z', endsAt: '2026-11-05T09:30:00.000Z', appointmentType: 'Checkup', attendeeName: 'Ada Lovelace', attendeeEmail: 'ada@example.com', attendeePhone: '+14155550123', callId: 'call-1' });
  assert.match(h.notes[0]!, /Booked Ada Lovelace for Thursday, November 5, 2026 at 9:00 AM/);
});

test('a correction means preparing again: the new details are read back and the old reference no longer books', async () => {
  const h = harness({ responses: [slots, slots, booked], autoApprove: true });
  const first = (await runTool(h.deps, 'prepare_booking', details)).booking_ref as string;
  h.caller.says = 'No, it is ada at example dot org';
  assert.equal((await runTool(h.deps, 'create_booking', { booking_ref: first })).ok, false);
  const second = (await runTool(h.deps, 'prepare_booking', { ...details, caller_email: 'ada at example dot org' })).booking_ref as string;
  assert.notEqual(second, first);
  assert.equal(h.caller.says, '', 'only what is said after the new read-back counts');
  h.caller.says = 'Yes';
  const result = await runTool(h.deps, 'create_booking', { booking_ref: second });
  assert.equal(result.ok, true);
  assert.equal((h.prompts[0]!.summary as Record<string, string>).callerEmail, 'ada@example.org');
});

test('a booking reference works once', async () => {
  const h = harness({ responses: [slots, booked], autoApprove: true });
  const ref = (await runTool(h.deps, 'prepare_booking', details)).booking_ref as string;
  h.caller.says = 'Yes';
  assert.equal((await runTool(h.deps, 'create_booking', { booking_ref: ref })).ok, true);
  assert.match(String((await runTool(h.deps, 'create_booking', { booking_ref: ref })).message), /no prepared booking/);
  assert.deepEqual(h.requests, ['GET /v2/slots', 'POST /v2/bookings']);
});

test('a refused or ignored approval changes nothing', async () => {
  const refused = harness({ responses: [slots], autoApprove: false });
  const ref = (await runTool(refused.deps, 'prepare_booking', details)).booking_ref as string;
  refused.caller.says = 'Yes';
  const result = await runTool(refused.deps, 'create_booking', { booking_ref: ref });
  assert.equal(result.ok, false);
  assert.match(String(result.message), /not approved in the browser/);
  assert.deepEqual(refused.requests, ['GET /v2/slots']);
  assert.equal(refused.log.length, 0);
});

test('past or malformed booking input is refused before anything is read back', async () => {
  const h = harness({ autoApprove: true });
  assert.equal((await runTool(h.deps, 'prepare_booking', { ...details, start: '2026-11-01T09:00:00Z' })).ok, false);
  assert.equal((await runTool(h.deps, 'prepare_booking', { ...details, caller_name: '' })).ok, false);
  assert.equal((await runTool(h.deps, 'prepare_booking', { ...details, caller_email: 'nope' })).ok, false);
  assert.equal((await runTool(h.deps, 'prepare_booking', { ...details, caller_phone: '12' })).ok, false);
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.requests, []);
});

test('a booking succeeds even if the dashboard record cannot be saved, and the model is told', async () => {
  const h = harness({ responses: [slots, booked], autoApprove: true });
  h.deps.store.recordAppointment = async () => false;
  const ref = (await runTool(h.deps, 'prepare_booking', details)).booking_ref as string;
  h.caller.says = 'Yes';
  const result = await runTool(h.deps, 'create_booking', { booking_ref: ref });
  assert.equal(result.ok, true);
  assert.match(String(result.dashboardNote), /could not be saved/);
});

test('when Cal.com refuses the booking the model gets the reason, and nothing is recorded', async () => {
  const h = harness({ autoApprove: true });
  h.deps.cal = CalComClient.create({ event_type_id: 9 }, 'key', {
    fetcher: async (input, init) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ status: 'error', error: { message: 'Attendee phone number is invalid' } }), { status: 400 });
      return new Response(JSON.stringify(slots), { status: 200 });
    },
  });
  const ref = (await runTool(h.deps, 'prepare_booking', details)).booking_ref as string;
  h.caller.says = 'Yes';
  const result = await runTool(h.deps, 'create_booking', { booking_ref: ref });
  assert.deepEqual(result, { ok: false, message: 'Cal.com refused the request: Attendee phone number is invalid' });
  assert.equal(h.log.length, 0);
});

test('leaving a message saves it to the call and says plainly that nobody was called', async () => {
  const h = harness({ cal: false });
  const result = await runTool(h.deps, 'leave_message_for_staff', { caller_name: 'Ada', message: 'Wants a cleaning Friday', caller_phone: '+14155550123', preferred_time: 'mornings' });
  assert.equal(result.ok, true);
  assert.match(String(result.message), /Nobody has been called/);
  assert.equal(h.notes[0], 'Message for the business team from Ada: Wants a cleaning Friday (phone +14155550123; suits them: mornings)');
  assert.deepEqual(h.escalations, []);
});

test('rescheduling verifies identity before and after approval', async () => {
  const free = { status: 'success', data: { '2026-11-06': [{ start: '2026-11-06T09:00:00Z', end: '2026-11-06T09:30:00Z' }] } };
  const h = harness({ responses: [identity(), free, identity(), { status: 'success', data: { uid: 'moved-uid-1', status: 'accepted', start: '2026-11-06T09:00:00Z' } }], autoApprove: true });
  const result = await runTool(h.deps, 'reschedule_booking', { booking_uid: 'uid-12345', caller_email: 'ada at example dot com', new_start: '2026-11-06T09:00:00Z', time_zone: 'UTC' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.requests, ['GET /v2/bookings/uid-12345', 'GET /v2/slots', 'GET /v2/bookings/uid-12345', 'POST /v2/bookings/uid-12345/reschedule']);
  assert.deepEqual(h.log.find(([name]) => name === 'recordReschedule')![1], { oldBookingUid: 'uid-12345', newBookingUid: 'moved-uid-1', startsAt: '2026-11-06T09:00:00.000Z', callId: 'call-1' });
});

test('someone else\'s booking is never offered for approval', async () => {
  const h = harness({ responses: [identity('victim@example.com')], autoApprove: true });
  const result = await runTool(h.deps, 'cancel_booking', { booking_uid: 'uid-12345', caller_email: 'attacker@example.com', reason: 'because' });
  assert.deepEqual(result, { ok: false, message: 'Caller email does not match this booking; change denied' });
  assert.equal(h.prompts.length, 0);
  assert.deepEqual(h.requests, ['GET /v2/bookings/uid-12345']);
});

test('cancelling marks the dashboard appointment cancelled', async () => {
  const h = harness({ responses: [identity(), identity(), { status: 'success', data: { uid: 'uid-12345', status: 'cancelled' } }], autoApprove: true });
  const result = await runTool(h.deps, 'cancel_booking', { booking_uid: 'uid-12345', caller_email: 'ada@example.com', reason: 'Feeling better' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.log.find(([name]) => name === 'updateAppointment')![1], { uid: 'uid-12345', status: 'cancelled' });
  assert.equal(h.prompts[0]!.operation, 'cancel_booking');
});

test('scheduling tools explain when Cal.com is not configured', async () => {
  const h = harness({ cal: false, autoApprove: true });
  const result = await runTool(h.deps, 'check_availability', { start: '2026-11-05T00:00:00Z', end: '2026-11-06T00:00:00Z', time_zone: 'UTC' });
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
