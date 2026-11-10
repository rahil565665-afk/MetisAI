// Local stand-ins for Gemini Live (port 9912) and Cal.com (port 9913), used only by the end-to-end suites.
// The fake Gemini follows a script: greet, then after some microphone audio try to book with a badly
// transcribed email, retry with a good one, read the details back, hear "yes", and create the booking.
import http from 'node:http';
import { WebSocketServer } from '../lib/deps.mjs';

const EXPECTED_KEY = 'e2e-gemini-key';
const state = { geminiConnections: [], geminiMessages: [], calRequests: [], setups: [], toolResponses: [], retriedEmail: false };
const live = new Set();
const bookingStart = new Date(Math.floor((Date.now() + 3 * 86_400_000) / 3_600_000) * 3_600_000);
bookingStart.setUTCHours(9, 0, 0, 0);

// ---- Cal.com -------------------------------------------------------------------------------
const cal = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    state.calRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization, version: req.headers['cal-api-version'], body: raw ? JSON.parse(raw) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/v2/bookings') && req.method === 'POST') {
      const body = JSON.parse(raw);
      return res.end(JSON.stringify({ status: 'success', data: { uid: 'e2e-booking-1', status: 'accepted', start: body.start, end: new Date(Date.parse(body.start) + 30 * 60_000).toISOString(), eventType: { title: 'Service booking' } } }));
    }
    if (req.url.startsWith('/v2/slots')) {
      if (req.headers.authorization !== 'Bearer cal_live_good') { res.statusCode = 401; return res.end('{}'); }
      if (req.url.includes('eventTypeSlug=missing') || req.url.includes('eventTypeId=404')) { res.statusCode = 404; return res.end('{}'); }
      const url = new URL(req.url, 'http://mock');
      const start = Date.parse(url.searchParams.get('start') ?? '');
      const end = Date.parse(url.searchParams.get('end') ?? '');
      const timeZone = url.searchParams.get('timeZone') ?? 'UTC';
      const slot = (offsetMinutes) => ({ start: new Date(bookingStart.getTime() + offsetMinutes * 60_000).toISOString(), end: new Date(bookingStart.getTime() + (offsetMinutes + 30) * 60_000).toISOString() });
      const data = {};
      for (const candidate of [slot(0), slot(60), slot(120)]) {
        const at = Date.parse(candidate.start);
        if (!Number.isFinite(start) || !Number.isFinite(end) || at < start || at >= end) continue;
        const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        const day = `${values.year}-${values.month}-${values.day}`;
        (data[day] ??= []).push(candidate);
      }
      return res.end(JSON.stringify({ status: 'success', data }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
cal.listen(9913, '127.0.0.1');

// ---- Gemini Live ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.url === '/__state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(state)); }
  if (req.url === '/__reset') { state.geminiConnections = []; state.geminiMessages = []; state.calRequests = []; state.setups = []; state.toolResponses = []; state.retriedEmail = false; return res.end('ok'); }
  if (req.url.startsWith('/__trigger')) {
    const mode = new URL(req.url, 'http://mock').searchParams.get('mode');
    for (const ws of live) { if (mode === 'goaway') ws.send(JSON.stringify({ goAway: { timeLeft: '5s' } })); else ws.terminate(); }
    return res.end(String(live.size));
  }
  if (req.url.startsWith('/v1beta/models')) {
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-goog-api-key'] === EXPECTED_KEY) return res.end('{"models":[]}');
    res.statusCode = 400; return res.end('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key."}}');
  }
  res.statusCode = 404; res.end();
});
const wss = new WebSocketServer({ server, path: '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' });

function sendJson(ws, message) { ws.send(Buffer.from(JSON.stringify(message)), { binary: true }); }

function tone(seconds, hz = 330) {
  const samples = Math.round(24_000 * seconds);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / 24_000)), i * 2);
  return out;
}

function speak(ws, text) {
  const audio = tone(0.6);
  for (let offset = 0; offset < audio.length; offset += 4800) {
    sendJson(ws, { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: audio.subarray(offset, offset + 4800).toString('base64') } }] } } });
  }
  const words = text.split(' ');
  for (const [index, word] of words.entries()) sendJson(ws, { serverContent: { outputTranscription: { text: (index ? ' ' : '') + word } } });
  sendJson(ws, { serverContent: { turnComplete: true } });
}

wss.on('connection', (ws, req) => {
  const key = req.headers['x-goog-api-key'];
  state.geminiConnections.push({ key, urlHasKey: req.url.includes('key=') });
  if (key !== EXPECTED_KEY) { ws.close(1007, 'API key not valid. Please pass a valid API key.'); return; }
  let audioChunks = 0;
  let toolSent = false;
  let awaitingYes = null;
  let resumed = false;
  let announced = false;
  live.add(ws);
  ws.on('close', () => live.delete(ws));
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    if (message.realtimeInput?.audio) {
      audioChunks += 1;
      if (audioChunks % 5 === 0) sendJson(ws, { sessionResumptionUpdate: { newHandle: `handle-${state.setups.length}-${audioChunks}`, resumable: true } });
      if (resumed && audioChunks === 5 && !announced) { announced = true; speak(ws, 'I am still here after the reconnect.'); }
      state.geminiMessages.push({ kind: 'audio', bytes: Buffer.from(message.realtimeInput.audio.data, 'base64').length, mime: message.realtimeInput.audio.mimeType });
      if (audioChunks === 12 && !toolSent) {
        toolSent = true;
        sendJson(ws, { serverContent: { inputTranscription: { text: "I'd like to book " } } });
        sendJson(ws, { serverContent: { inputTranscription: { text: 'a haircut, please.' } } });
        // The first attempt carries an email the way a speech-to-text mistake would write it.
        sendJson(ws, { toolCall: { functionCalls: [{ id: 'fc-prep-1', name: 'prepare_booking', args: { caller_name: 'Ada Lovelace', caller_email: 'Ahorita.gmail.com', caller_phone: '+1 415 555 0123', request_details: 'Haircut', start: bookingStart.toISOString(), time_zone: 'UTC' } }] } });
      }
      if (awaitingYes && audioChunks >= awaitingYes.at) {
        const ref = awaitingYes.ref;
        awaitingYes = null;
        sendJson(ws, { serverContent: { inputTranscription: { text: 'Yes, that is all correct.' } } });
        sendJson(ws, { toolCall: { functionCalls: [{ id: 'fc-create-1', name: 'create_booking', args: { booking_ref: ref } }] } });
      }
      return;
    }
    state.geminiMessages.push({ kind: Object.keys(message)[0], message: message.setup ? { model: message.setup.model, voice: message.setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName, tools: message.setup.tools?.[0]?.functionDeclarations?.length, instruction: message.setup.systemInstruction?.parts?.[0]?.text } : message });
    if (message.setup) {
      const handle = message.setup.sessionResumption?.handle ?? null;
      resumed = Boolean(handle);
      state.setups.push({ resumeHandle: handle, resumption: message.setup.sessionResumption !== undefined, compression: message.setup.contextWindowCompression !== undefined });
      sendJson(ws, { setupComplete: {} });
    }
    else if (message.realtimeInput?.text) speak(ws, 'Thank you for calling. How can I help you today?');
    else if (message.toolResponse) {
      const { name, response } = message.toolResponse.functionResponses[0];
      state.toolResponses.push({ name, response });
      if (name === 'prepare_booking' && !response.ok && !state.retriedEmail) {
        state.retriedEmail = true;
        sendJson(ws, { toolCall: { functionCalls: [{ id: 'fc-prep-2', name: 'prepare_booking', args: { caller_name: 'Ada Lovelace', caller_email: 'ada at example dot com', caller_phone: '+1 415 555 0123', request_details: 'Haircut', start: bookingStart.toISOString(), time_zone: 'UTC' } }] } });
      } else if (name === 'prepare_booking' && response.ok) {
        speak(ws, `Let me read that back. Email ${response.read_back.email_spelled}. Is all of that correct?`);
        awaitingYes = { ref: response.booking_ref, at: audioChunks + 6 };
      } else if (name === 'create_booking') {
        speak(ws, response.ok ? 'Your booking is confirmed.' : 'I could not complete that booking.');
      } else {
        speak(ws, 'I could not do that.');
      }
    }
  });
});
server.listen(9912, '127.0.0.1', () => console.log('mocks up'));
