import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_VOICE_NAME,
  audioChunkMessage,
  geminiLiveUrl,
  geminiSettings,
  parseServerMessage,
  safeProviderText,
  setupMessage,
  textInputMessage,
  toolResponseMessage,
} from './gemini.js';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

test('the connection URL targets the v1beta BidiGenerateContent service and carries no key', () => {
  const url = geminiLiveUrl();
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/ws\/google\.ai\.generativelanguage\.v1beta\.GenerativeService\.BidiGenerateContent$/);
  assert.equal(geminiLiveUrl('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent');
});

test('setup message nests generation settings under generationConfig', () => {
  const message = setupMessage({ model: 'models/m', voiceName: 'Puck', systemInstruction: 'be nice', tools: [] }) as { setup: Record<string, any> };
  assert.equal(message.setup.model, 'models/m');
  assert.deepEqual(message.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(message.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
  assert.equal(message.setup.systemInstruction.parts[0].text, 'be nice');
  assert.deepEqual(message.setup.inputAudioTranscription, {});
  assert.deepEqual(message.setup.outputAudioTranscription, {});
  assert.equal(message.setup.responseModalities, undefined);
});

test('long-call settings are on by default, carry a resume handle, and can be left out', () => {
  const base = { model: 'models/m', voiceName: 'Puck', systemInstruction: 's', tools: [] };
  const fresh = setupMessage(base) as { setup: Record<string, any> };
  assert.deepEqual(fresh.setup.sessionResumption, {});
  assert.deepEqual(fresh.setup.contextWindowCompression, { slidingWindow: {} });
  const resumed = setupMessage({ ...base, resumeHandle: 'handle-1' }) as { setup: Record<string, any> };
  assert.deepEqual(resumed.setup.sessionResumption, { handle: 'handle-1' });
  const plain = setupMessage({ ...base, longSession: false }) as { setup: Record<string, any> };
  assert.equal(plain.setup.sessionResumption, undefined);
  assert.equal(plain.setup.contextWindowCompression, undefined);
});

test('client message builders match the wire format', () => {
  assert.deepEqual(audioChunkMessage('AAAA'), { realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } });
  assert.deepEqual(textInputMessage('hi'), { realtimeInput: { text: 'hi' } });
  assert.deepEqual(toolResponseMessage([{ id: '1', name: 'f', response: { ok: true } }]), { toolResponse: { functionResponses: [{ id: '1', name: 'f', response: { ok: true } }] } });
});

test('setupComplete, audio, transcripts and turnComplete arrive in handling order', () => {
  const frame = JSON.stringify({
    serverContent: {
      interrupted: true,
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: b64([1, 2]) } }] },
      inputTranscription: { text: 'hello' },
      outputTranscription: { text: 'hi there' },
      turnComplete: true,
    },
  });
  assert.deepEqual(parseServerMessage(frame).map((event) => event.kind), ['interrupted', 'audio', 'inputTranscript', 'outputTranscript', 'turnComplete']);
  assert.deepEqual(parseServerMessage('{"setupComplete":{}}'), [{ kind: 'setupComplete' }]);
});

test('binary frames are decoded as JSON text', () => {
  const bytes = new TextEncoder().encode('{"setupComplete":{}}');
  assert.deepEqual(parseServerMessage(bytes), [{ kind: 'setupComplete' }]);
  assert.deepEqual(parseServerMessage(bytes.buffer as ArrayBuffer), [{ kind: 'setupComplete' }]);
});

test('audio at an unexpected sample rate is reported, not played', () => {
  const frame = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=16000', data: b64([1, 2]) } }] } } });
  assert.deepEqual(parseServerMessage(frame), [{ kind: 'badAudioFormat', mimeType: 'audio/pcm;rate=16000' }]);
  const bare = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm', data: b64([1, 2]) } }] } } });
  assert.deepEqual(parseServerMessage(bare).map((event) => event.kind), ['audio']);
  for (const mimeType of ['audio/pcm;rate=24000;channels=1', 'audio/pcm; rate=24000', 'AUDIO/PCM;rate=24000', 'audio/l16;rate=24000']) {
    const frame = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType, data: b64([1, 2]) } }] } } });
    assert.deepEqual(parseServerMessage(frame).map((event) => event.kind), ['audio'], mimeType);
  }
  const other = JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/ogg', data: b64([1, 2]) } }] } } });
  assert.deepEqual(parseServerMessage(other).map((event) => event.kind), ['badAudioFormat']);
});

test('tool calls and cancellations are extracted; malformed calls are dropped', () => {
  const frame = JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'check_availability', args: { start: 'x' } }, { name: 'no-id' }, { id: 'c3', name: 'request_human_transfer' }] } });
  const [event] = parseServerMessage(frame);
  assert.deepEqual(event, { kind: 'toolCall', calls: [{ id: 'c1', name: 'check_availability', args: { start: 'x' } }, { id: 'c3', name: 'request_human_transfer', args: {} }] });
  assert.deepEqual(parseServerMessage('{"toolCallCancellation":{"ids":["c1",7]}}'), [{ kind: 'toolCancel', ids: ['c1'] }]);
});

test('errors, goAway and garbage', () => {
  assert.deepEqual(parseServerMessage('{"goAway":{"timeLeft":"10s"}}'), [{ kind: 'goAway' }]);
  assert.deepEqual(parseServerMessage('{"error":{"message":"nope"}}'), [{ kind: 'error', detail: 'nope' }]);
  assert.deepEqual(parseServerMessage('{"error":{}}'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('not json'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('[]'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('{"usageMetadata":{}}'), []);
});

test('model and voice overrides are validated', () => {
  assert.deepEqual(geminiSettings({}), { model: DEFAULT_GEMINI_LIVE_MODEL, voiceName: DEFAULT_VOICE_NAME });
  assert.deepEqual(geminiSettings({ GEMINI_LIVE_MODEL: 'models/gemini-next-live', GEMINI_VOICE_NAME: 'Puck' }), { model: 'models/gemini-next-live', voiceName: 'Puck' });
  assert.deepEqual(geminiSettings({ GEMINI_LIVE_MODEL: 'gemini-without-prefix', GEMINI_VOICE_NAME: 'not a voice!' }), { model: DEFAULT_GEMINI_LIVE_MODEL, voiceName: DEFAULT_VOICE_NAME });
});

test('resumption updates carry the newest handle, and only count as resumable with one', () => {
  assert.deepEqual(parseServerMessage('{"sessionResumptionUpdate":{"newHandle":"h2","resumable":true}}'), [{ kind: 'resumption', handle: 'h2', resumable: true }]);
  assert.deepEqual(parseServerMessage('{"sessionResumptionUpdate":{"resumable":false}}'), [{ kind: 'resumption', handle: null, resumable: false }]);
  assert.deepEqual(parseServerMessage('{"sessionResumptionUpdate":{"resumable":true}}'), [{ kind: 'resumption', handle: null, resumable: false }]);
});

test('provider text shown to people is cleaned and bounded', () => {
  assert.equal(safeProviderText('API key not valid.\n Please pass a valid key.'), 'API key not valid. Please pass a valid key.');
  assert.equal(safeProviderText('bad AIzaSyA1234567890abcdefghijklmnopqrstuv key'), 'bad [key] key');
  assert.equal(safeProviderText('x'.repeat(500)).length, 160);
  assert.equal(safeProviderText(42), '');
});
