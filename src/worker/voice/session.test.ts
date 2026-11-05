import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalComClient, type Fetcher } from './calcom.js';
import { normalizeClinicConfig } from './clinicConfig.js';
import type { CallStore } from './receptionist.js';
import { GEMINI_REFUSED, SessionStartError, VoiceSession, type PreparedSession, type SessionDeps, type VoiceSocket } from './session.js';

type Listener = (event: any) => void;

class FakeSocket implements VoiceSocket {
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners: Record<string, Listener[]> = { message: [], close: [], error: [] };
  send(data: string | ArrayBuffer | ArrayBufferView) { this.sent.push(data); }
  close(code?: number, reason?: string) { this.closed ??= { code, reason }; }
  addEventListener(type: 'message' | 'close' | 'error', listener: Listener) { this.listeners[type]!.push(listener); }
  emit(type: 'message' | 'close' | 'error', event: unknown) { for (const listener of this.listeners[type]!) listener(event); }
  get json(): any[] { return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item)); }
  get binary(): Uint8Array[] { return this.sent.filter((item) => typeof item !== 'string').map((item) => new Uint8Array(item as ArrayBuffer)); }
  receive(message: unknown) { this.emit('message', { data: JSON.stringify(message) }); }
}

const NOW = new Date('2026-11-02T03:00:00Z');
const wait = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return;
    await wait(5);
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function makeStore() {
  const calls: Array<[string, any]> = [];
  const store: CallStore = {
    async createCall() { calls.push(['createCall', null]); return 'call-1'; },
    async updateCall(callId, fields) { calls.push(['updateCall', { callId, ...fields }]); },
    async recordAppointment(input) { calls.push(['recordAppointment', input]); return true; },
    async updateAppointment(uid, status) { calls.push(['updateAppointment', { uid, status }]); return true; },
    async recordReschedule(input) { calls.push(['recordReschedule', input]); return true; },
  };
  return { store, calls };
}

interface Rig {
  client: FakeSocket;
  gemini: FakeSocket;
  session: VoiceSession;
  done: Promise<void>;
  calls: Array<[string, any]>;
  calRequests: string[];
  connectedWith: string[];
}

function rig(options: { cal?: Array<unknown>; limits?: SessionDeps['limits']; prepare?: () => Promise<PreparedSession>; connect?: () => Promise<VoiceSocket>; more?: FakeSocket[]; approvalTimeoutMs?: number } = {}): Rig {
  const client = new FakeSocket();
  const gemini = new FakeSocket();
  const { store, calls } = makeStore();
  const calRequests: string[] = [];
  const queue = [...(options.cal ?? [])];
  const fetcher: Fetcher = async (input, init) => {
    calRequests.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}`);
    const next = queue.shift();
    return new Response(JSON.stringify(next ?? { status: 'error' }), { status: next ? 200 : 500 });
  };
  const config = normalizeClinicConfig({ id: 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4', name: 'Northside Dental', timezone: 'UTC', receptionist_config: { greeting: 'Welcome!' } });
  const connectedWith: string[] = [];
  const session = new VoiceSession({
    client,
    prepare: options.prepare ?? (async () => ({ config, geminiApiKey: 'gem-key', cal: CalComClient.create({ event_type_id: 9 }, 'k', { fetcher }), calError: null, store })),
    connectGemini: options.connect ?? (async (key) => { connectedWith.push(key); return connectedWith.length === 1 ? gemini : (options.more?.shift() ?? gemini); }),
    model: 'models/test-live',
    voiceName: 'Puck',
    now: () => NOW,
    limits: { tickMs: 10, logTimeoutMs: 200, reconnectDelayMs: 1, ...options.limits },
    approvalTimeoutMs: options.approvalTimeoutMs ?? 2000,
    newApprovalId: (() => { let n = 0; return () => `approval-${++n}`; })(),
  });
  return { client, gemini, session, done: session.run(), calls, calRequests, connectedWith };
}

async function ready(r: Rig) {
  await until(() => r.gemini.json.length > 0, 'setup message');
  r.gemini.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'ready'), 'ready');
}

const pcm = (samples: number) => new Uint8Array(samples * 2).fill(1).buffer;
const audioFrom = (bytes: number[]) => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.from(bytes).toString('base64') } }] } } });

test('connects with the clinic key, sends setup, then greets once Gemini is ready', async () => {
  const r = rig();
  await until(() => r.gemini.json.length > 0, 'setup message');
  assert.deepEqual(r.connectedWith, ['gem-key']);
  const setup = r.gemini.json[0].setup;
  assert.equal(setup.model, 'models/test-live');
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.match(setup.systemInstruction.parts[0].text, /Northside Dental/);
  assert.equal(setup.tools[0].functionDeclarations.length, 5);
  assert.equal(r.client.json.some((message) => message.type === 'ready'), false, 'not ready before Gemini accepts the setup');

  r.gemini.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'ready'), 'ready');
  assert.match(r.gemini.json[1].realtimeInput.text, /Greet them now/);
  r.client.emit('close', { code: 1000, reason: '' });
  await r.done;
});

test('microphone audio is forwarded only once ready, and Gemini audio comes back as binary', async () => {
  const r = rig();
  await until(() => r.gemini.json.length > 0, 'setup');
  r.client.emit('message', { data: pcm(160) });
  assert.equal(r.gemini.json.filter((message) => message.realtimeInput?.audio).length, 0, 'early audio is dropped');
  r.gemini.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'ready'), 'ready');

  r.client.emit('message', { data: pcm(1600) });
  const chunks = r.gemini.json.filter((message) => message.realtimeInput?.audio);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].realtimeInput.audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(chunks[0].realtimeInput.audio.data, 'base64').length, 3200);

  r.gemini.receive(audioFrom([1, 2, 3, 4]));
  assert.deepEqual(r.client.binary.map((bytes) => [...bytes]), [[1, 2, 3, 4]]);
  await r.session.end('client');
  await r.done;
});

test('invalid audio frames end the session with an error', async () => {
  const odd = rig();
  await ready(odd);
  odd.client.emit('message', { data: new ArrayBuffer(3) });
  await odd.done;
  assert.ok(odd.client.json.some((message) => message.type === 'error'));
  assert.equal(odd.client.closed?.code, 1011);

  const huge = rig();
  await ready(huge);
  huge.client.emit('message', { data: new ArrayBuffer(70_000) });
  await huge.done;
  assert.equal(huge.client.closed?.code, 1011);
});

test('transcript fragments accumulate per speaker and are finalised on turn end', async () => {
  const r = rig();
  await ready(r);
  r.gemini.receive({ serverContent: { inputTranscription: { text: 'I need ' } } });
  r.gemini.receive({ serverContent: { inputTranscription: { text: 'a cleaning' } } });
  r.gemini.receive({ serverContent: { outputTranscription: { text: 'Sure, ' } } });
  r.gemini.receive({ serverContent: { outputTranscription: { text: 'when?' }, turnComplete: true } });
  const transcripts = r.client.json.filter((message) => message.type === 'transcript').map((message) => `${message.role}|${message.text}|${message.final}`);
  assert.deepEqual(transcripts, [
    'user|I need |false',
    'user|I need a cleaning|false',
    'user|I need a cleaning|true',
    'assistant|Sure, |false',
    'assistant|Sure, when?|false',
    'assistant|Sure, when?|true',
  ]);
  assert.ok(r.client.json.some((message) => message.type === 'turn_complete'));
  await r.session.end('client');
});

test('an interruption flushes the transcript and tells the browser to stop playback', async () => {
  const r = rig();
  await ready(r);
  r.gemini.receive({ serverContent: { outputTranscription: { text: 'Our hours are' } } });
  r.gemini.receive({ serverContent: { interrupted: true } });
  const types = r.client.json.map((message) => message.type);
  assert.deepEqual(types.slice(-2), ['transcript', 'interrupted']);
  assert.equal(r.client.json.at(-2).final, true);
  await r.session.end('client');
});

const booking = { status: 'success', data: { uid: 'new-uid-99', status: 'accepted', start: '2026-11-05T09:00:00Z', end: '2026-11-05T09:30:00Z', eventType: { title: 'Checkup' } } };
const bookCall = (id = 'call-a') => ({ toolCall: { functionCalls: [{ id, name: 'create_dental_booking', args: { patient_name: 'Ada', patient_email: 'ada@example.com', start: '2026-11-05T09:00:00Z', time_zone: 'UTC' } }] } });

test('an approved booking prompts the browser, books, logs it, and answers the model', async () => {
  const r = rig({ cal: [booking] });
  await ready(r);
  r.gemini.receive(bookCall());
  await until(() => r.client.json.some((message) => message.type === 'approval_request'), 'approval prompt');
  const prompt = r.client.json.find((message) => message.type === 'approval_request');
  assert.equal(prompt.approvalId, 'approval-1');
  assert.equal(prompt.operation, 'create_booking');
  assert.equal(r.calRequests.length, 0, 'nothing is booked before approval');

  r.client.emit('message', { data: JSON.stringify({ type: 'approval_response', approvalId: 'approval-1', approved: true }) });
  await until(() => r.gemini.json.some((message) => message.toolResponse), 'tool response');
  const response = r.gemini.json.find((message) => message.toolResponse).toolResponse.functionResponses[0];
  assert.equal(response.id, 'call-a');
  assert.equal(response.name, 'create_dental_booking');
  assert.equal(response.response.ok, true);
  assert.deepEqual(r.calRequests, ['POST /v2/bookings']);
  assert.ok(r.calls.some(([name]) => name === 'recordAppointment'));
  assert.ok(r.client.json.some((message) => message.type === 'approval_closed' && message.approvalId === 'approval-1'));
  await r.session.end('client');
});

test('a refused booking tells the model it was not approved and books nothing', async () => {
  const r = rig({ cal: [booking] });
  await ready(r);
  r.gemini.receive(bookCall());
  await until(() => r.client.json.some((message) => message.type === 'approval_request'), 'approval prompt');
  r.client.emit('message', { data: JSON.stringify({ type: 'approval_response', approvalId: 'approval-1', approved: false }) });
  await until(() => r.gemini.json.some((message) => message.toolResponse), 'tool response');
  assert.equal(r.gemini.json.find((message) => message.toolResponse).toolResponse.functionResponses[0].response.ok, false);
  assert.deepEqual(r.calRequests, []);
  await r.session.end('client');
});

test('an approval nobody answers fails closed', async () => {
  const r = rig({ cal: [booking], approvalTimeoutMs: 30 });
  await ready(r);
  r.gemini.receive(bookCall());
  await until(() => r.gemini.json.some((message) => message.toolResponse), 'tool response after timeout');
  assert.match(r.gemini.json.find((message) => message.toolResponse).toolResponse.functionResponses[0].response.message, /not approved/);
  assert.deepEqual(r.calRequests, []);
  await r.session.end('client');
});

test('a cancelled tool call closes its prompt and gets no answer', async () => {
  const r = rig({ cal: [booking] });
  await ready(r);
  r.gemini.receive(bookCall());
  await until(() => r.client.json.some((message) => message.type === 'approval_request'), 'approval prompt');
  r.gemini.receive({ toolCallCancellation: { ids: ['call-a'] } });
  await until(() => r.client.json.some((message) => message.type === 'approval_closed'), 'prompt closed');
  await wait(30);
  assert.equal(r.gemini.json.some((message) => message.toolResponse), false);
  assert.deepEqual(r.calRequests, []);
  await r.session.end('client');
});

test('an approval answered after the prompt closed is ignored', async () => {
  const r = rig({ cal: [booking], approvalTimeoutMs: 20 });
  await ready(r);
  r.gemini.receive(bookCall());
  await until(() => r.client.json.some((message) => message.type === 'approval_closed'), 'timeout');
  r.client.emit('message', { data: JSON.stringify({ type: 'approval_response', approvalId: 'approval-1', approved: true }) });
  await wait(30);
  assert.deepEqual(r.calRequests, []);
  await r.session.end('client');
});

test('escalation notifies the browser, marks the call, and keeps that status when the call ends', async () => {
  const r = rig();
  await ready(r);
  r.gemini.receive({ toolCall: { functionCalls: [{ id: 'esc-1', name: 'request_human_transfer', args: { reason: 'Wants the dentist' } }] } });
  await until(() => r.client.json.some((message) => message.type === 'escalation'), 'escalation');
  assert.equal(r.client.json.find((message) => message.type === 'escalation').reason, 'Wants the dentist');
  await until(() => r.gemini.json.some((message) => message.toolResponse), 'tool response');
  r.client.emit('close', { code: 1000, reason: '' });
  await r.done;
  const updates = r.calls.filter(([name]) => name === 'updateCall').map(([, fields]) => fields);
  assert.deepEqual(updates[0], { callId: 'call-1', status: 'transfer_requested', transfer_requested: true, transfer_reason: 'Wants the dentist' });
  assert.equal(updates.at(-1).status, undefined);
  assert.ok(updates.at(-1).ended_at);
});

test('hanging up from the browser closes Gemini and completes the call log', async () => {
  const r = rig();
  await ready(r);
  r.client.emit('message', { data: JSON.stringify({ type: 'end' }) });
  await r.done;
  assert.deepEqual(r.client.json.at(-1), { type: 'ended', reason: 'client' });
  assert.equal(r.client.closed?.code, 1000);
  assert.equal(r.gemini.closed?.code, 1000);
  const final = r.calls.filter(([name]) => name === 'updateCall').at(-1)![1];
  assert.equal(final.status, 'completed');
  assert.equal(final.ended_at, NOW.toISOString());
  assert.equal(r.session.active, false);
});

test('a dropped browser connection ends the call too', async () => {
  const r = rig();
  await ready(r);
  r.client.emit('error', {});
  await r.done;
  assert.equal(r.gemini.closed?.code, 1000);
});

test('a dashboard stop ends the call with the admin reason', async () => {
  const r = rig();
  await ready(r);
  await r.session.end('admin');
  assert.deepEqual(r.client.json.at(-1), { type: 'ended', reason: 'admin' });
});

test('the time limit and the idle limit end the call', async () => {
  const limited = rig({ limits: { maxDurationMs: 40, idleMs: 60_000 } });
  await ready(limited);
  await limited.done;
  assert.deepEqual(limited.client.json.at(-1), { type: 'ended', reason: 'time_limit' });

  const idle = rig({ limits: { maxDurationMs: 60_000, idleMs: 40 } });
  await ready(idle);
  await idle.done;
  assert.deepEqual(idle.client.json.at(-1), { type: 'ended', reason: 'idle' });
});

test('speech keeps an otherwise quiet call alive', async () => {
  const r = rig({ limits: { maxDurationMs: 60_000, idleMs: 80 } });
  await ready(r);
  for (let index = 0; index < 6; index += 1) {
    r.gemini.receive({ serverContent: { inputTranscription: { text: 'x' } } });
    await wait(25);
  }
  assert.equal(r.session.active, true);
  await r.session.end('client');
});

test('a refused setup is retried without the long-call settings, then reported with what the service said', async () => {
  const second = new FakeSocket();
  const r = rig({ more: [second] });
  await until(() => r.gemini.json.length > 0, 'setup');
  assert.deepEqual(r.gemini.json[0].setup.sessionResumption, {});
  assert.deepEqual(r.gemini.json[0].setup.contextWindowCompression, { slidingWindow: {} });
  r.gemini.emit('close', { code: 1007, reason: 'Unknown name "sessionResumption"' });
  await until(() => second.json.length > 0, 'retry setup');
  assert.equal(second.json[0].setup.sessionResumption, undefined);
  assert.equal(second.json[0].setup.contextWindowCompression, undefined);
  assert.equal(r.client.json.some((message) => message.type === 'error'), false, 'nothing is reported while the retry is pending');

  second.emit('close', { code: 1008, reason: 'API key not valid. Please pass a valid API key.' });
  await r.done;
  const errors = r.client.json.filter((message) => message.type === 'error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].message.startsWith(GEMINI_REFUSED));
  assert.match(errors[0].message, /code 1008: API key not valid/);
  assert.equal(r.client.closed?.code, 1011);
  assert.equal(r.calls.filter(([name]) => name === 'updateCall').at(-1)![1].status, 'error');
});

test('a setup that works on the retry carries on as a normal call', async () => {
  const second = new FakeSocket();
  const r = rig({ more: [second] });
  await until(() => r.gemini.json.length > 0, 'setup');
  r.gemini.emit('close', { code: 1007, reason: 'bad field' });
  await until(() => second.json.length > 0, 'retry setup');
  second.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'ready'), 'ready');
  assert.equal(r.client.json.filter((message) => message.type === 'ready').length, 1);
  assert.match(second.json[1].realtimeInput.text, /Greet them now/);
  r.client.emit('message', { data: pcm(1600) });
  assert.equal(second.json.filter((message) => message.realtimeInput?.audio).length, 1);
  await r.session.end('client');
});

test('Gemini going quiet during setup times out', async () => {
  const r = rig({ limits: { setupTimeoutMs: 30 } });
  await r.done;
  assert.match(r.client.json.find((message) => message.type === 'error').message, /did not respond in time/);
});

test('Gemini disconnecting mid-call, with nothing to resume from, ends it with the reason', async () => {
  const r = rig();
  await ready(r);
  r.gemini.emit('close', { code: 1011, reason: 'internal' });
  await r.done;
  assert.deepEqual(r.client.json.at(-1), { type: 'ended', reason: 'service' });
  assert.match(r.client.json.find((message) => message.type === 'error').message, /could not be restored \(code 1011: internal\)/);
});

const resumable = (r: Rig, handle = 'handle-1') => r.gemini.receive({ sessionResumptionUpdate: { newHandle: handle, resumable: true } });

test('a dropped connection is resumed with the latest handle, without a second greeting or ready', async () => {
  const second = new FakeSocket();
  const r = rig({ more: [second] });
  await ready(r);
  resumable(r);
  r.gemini.receive({ sessionResumptionUpdate: { resumable: false } });
  r.gemini.emit('close', { code: 1011, reason: 'internal' });

  await until(() => second.json.length > 0, 'resume setup');
  assert.deepEqual(second.json[0].setup.sessionResumption, { handle: 'handle-1' });
  const notices = () => r.client.json.filter((message) => message.type === 'notice').map((message) => message.message);
  assert.match(notices().at(-1), /Reconnecting/);
  r.client.emit('message', { data: pcm(1600) });
  assert.equal(second.json.filter((message) => message.realtimeInput?.audio).length, 0, 'microphone audio is not queued while reconnecting');

  second.receive({ setupComplete: {} });
  await until(() => notices().at(-1) === '', 'reconnect banner cleared');
  assert.equal(r.client.json.filter((message) => message.type === 'ready').length, 1);
  assert.equal(second.json.length, 1, 'no second greeting is requested');
  r.client.emit('message', { data: pcm(1600) });
  assert.equal(second.json.filter((message) => message.realtimeInput?.audio).length, 1);
  second.receive(audioFrom([5, 6]));
  assert.deepEqual(r.client.binary.map((bytes) => [...bytes]), [[5, 6]]);
  assert.equal(r.session.active, true);
  await r.session.end('client');
});

test('when the service announces it is going away, the call moves to a fresh connection without a gap', async () => {
  const second = new FakeSocket();
  const r = rig({ more: [second] });
  await ready(r);
  resumable(r, 'handle-7');
  r.gemini.receive({ goAway: { timeLeft: '30s' } });
  await until(() => second.json.length > 0, 'resume setup');
  assert.deepEqual(second.json[0].setup.sessionResumption, { handle: 'handle-7' });

  r.client.emit('message', { data: pcm(1600) });
  assert.equal(r.gemini.json.filter((message) => message.realtimeInput?.audio).length, 1, 'the old connection keeps the call going until the new one is ready');
  const oldClose = () => r.gemini.closed;
  assert.equal(oldClose(), null);

  second.receive({ setupComplete: {} });
  await until(() => oldClose() !== null, 'old connection retired');
  assert.equal(oldClose()?.code, 1000);
  r.client.emit('message', { data: pcm(1600) });
  assert.equal(second.json.filter((message) => message.realtimeInput?.audio).length, 1);
  r.gemini.emit('close', { code: 1000, reason: 'Replaced' });
  assert.equal(r.session.active, true, 'closing the retired connection does not end the call');
  await r.session.end('client');
});

test('a goAway with nothing to resume from only warns the caller', async () => {
  const r = rig();
  await ready(r);
  r.gemini.receive({ goAway: { timeLeft: '30s' } });
  assert.match(r.client.json.filter((message) => message.type === 'notice').at(-1).message, /will end this session shortly/);
  assert.equal(r.session.active, true);
  await r.session.end('client');
});

test('when every reconnect attempt fails the call ends with an explanation', async () => {
  let connects = 0;
  const gemini = new FakeSocket();
  const r = rig({ limits: { maxReconnects: 2 }, connect: async () => { connects += 1; if (connects === 1) return gemini; throw new SessionStartError('down'); } });
  (r as { gemini: FakeSocket }).gemini = gemini;
  await until(() => gemini.json.length > 0, 'setup');
  gemini.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'ready'), 'ready');
  gemini.receive({ sessionResumptionUpdate: { newHandle: 'h', resumable: true } });
  gemini.emit('close', { code: 1006, reason: '' });
  await r.done;
  assert.equal(connects, 3, 'the first connection plus two attempts');
  assert.match(r.client.json.find((message) => message.type === 'error').message, /could not be restored \(code 1006\)/);
  assert.deepEqual(r.client.json.at(-1), { type: 'ended', reason: 'service' });
});

test('a replacement that never accepts its setup is dropped and the call fails clearly', async () => {
  const silent = new FakeSocket();
  const r = rig({ more: [silent], limits: { maxReconnects: 1, setupTimeoutMs: 40 } });
  await ready(r);
  resumable(r);
  r.gemini.emit('close', { code: 1011, reason: '' });
  await r.done;
  assert.ok(silent.closed, 'the silent replacement is closed');
  assert.match(r.client.json.find((message) => message.type === 'error').message, /could not be restored/);
});

test('an answer to a tool call from a replaced connection is dropped, and its prompt is closed', async () => {
  const second = new FakeSocket();
  const r = rig({ cal: [booking], more: [second] });
  await ready(r);
  resumable(r);
  r.gemini.receive(bookCall());
  await until(() => r.client.json.some((message) => message.type === 'approval_request'), 'approval prompt');
  r.gemini.receive({ goAway: { timeLeft: '10s' } });
  await until(() => second.json.length > 0, 'resume setup');
  second.receive({ setupComplete: {} });
  await until(() => r.client.json.some((message) => message.type === 'approval_closed'), 'prompt closed');
  await wait(40);
  assert.equal(r.gemini.json.some((message) => message.toolResponse), false);
  assert.equal(second.json.some((message) => message.toolResponse), false);
  assert.deepEqual(r.calRequests, [], 'nothing was booked');
  await r.session.end('client');
});

test('a quiet call is warned before it ends, and the warning clears when someone speaks', async () => {
  const r = rig({ limits: { maxDurationMs: 60_000, idleMs: 400, warnMs: 300 } });
  await ready(r);
  const notices = () => r.client.json.filter((message) => message.type === 'notice').map((message) => message.message);
  await until(() => notices().some((message) => /No one has spoken/.test(message)), 'idle warning');
  assert.equal(r.session.active, true);
  r.gemini.receive({ serverContent: { inputTranscription: { text: 'hello' } } });
  await until(() => notices().at(-1) === '', 'warning cleared');
  assert.equal(r.session.active, true);
  await r.session.end('client');
});

test('the caller is told shortly before the time limit', async () => {
  const r = rig({ limits: { maxDurationMs: 300, idleMs: 60_000, warnMs: 250 } });
  await ready(r);
  await r.done;
  assert.ok(r.client.json.some((message) => message.type === 'notice' && /time limit/.test(message.message)));
  assert.deepEqual(r.client.json.at(-1), { type: 'ended', reason: 'time_limit' });
});



test('unsupported audio from Gemini ends the call instead of playing noise', async () => {
  const r = rig();
  await ready(r);
  r.gemini.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=48000', data: 'AAAA' } }] } } });
  await r.done;
  assert.match(r.client.json.find((message) => message.type === 'error').message, /unsupported format/);
});

test('start-up problems with a safe message reach the browser verbatim; others are generic', async () => {
  const safe = rig({ prepare: async () => { throw new SessionStartError('This clinic is unavailable.'); } });
  await safe.done;
  assert.deepEqual(safe.client.json, [{ type: 'error', message: 'This clinic is unavailable.' }, { type: 'ended', reason: 'service' }]);

  const unsafe = rig({ prepare: async () => { throw new Error('connection string postgres://user:pass@host'); } });
  await unsafe.done;
  assert.deepEqual(unsafe.client.json[0], { type: 'error', message: 'The voice session could not be started.' });
});

test('hanging up while Gemini is still connecting closes the late socket', async () => {
  const late = new FakeSocket();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const r = rig({ connect: async () => { await gate; return late; } });
  await wait(10);
  r.client.emit('close', { code: 1000, reason: '' });
  release();
  await r.done;
  await until(() => late.closed !== null, 'late socket closed');
  assert.equal(late.sent.length, 0, 'no setup is sent for a call that already ended');
});

test('a second end request is harmless', async () => {
  const r = rig();
  await ready(r);
  await Promise.all([r.session.end('admin'), r.session.end('client')]);
  assert.equal(r.client.json.filter((message) => message.type === 'ended').length, 1);
});
