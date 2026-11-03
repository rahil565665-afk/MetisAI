import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_VOICE_NAME,
  audioChunkMessage,
  geminiLiveUrl,
  geminiSettings,
  parseServerMessage,
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
});

test('tool calls and cancellations are extracted; malformed calls are dropped', () => {
  const frame = JSON.stringify({ toolCall: { functionCalls: [{ id: 'c1', name: 'check_dental_availability', args: { start: 'x' } }, { name: 'no-id' }, { id: 'c3', name: 'request_human_transfer' }] } });
  const [event] = parseServerMessage(frame);
  assert.deepEqual(event, { kind: 'toolCall', calls: [{ id: 'c1', name: 'check_dental_availability', args: { start: 'x' } }, { id: 'c3', name: 'request_human_transfer', args: {} }] });
  assert.deepEqual(parseServerMessage('{"toolCallCancellation":{"ids":["c1",7]}}'), [{ kind: 'toolCancel', ids: ['c1'] }]);
});

test('errors, goAway and garbage', () => {
  assert.deepEqual(parseServerMessage('{"goAway":{"timeLeft":"10s"}}'), [{ kind: 'goAway' }]);
  assert.deepEqual(parseServerMessage('{"error":{"message":"nope"}}'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('not json'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('[]'), [{ kind: 'error' }]);
  assert.deepEqual(parseServerMessage('{"usageMetadata":{}}'), []);
});

test('model and voice overrides are validated', () => {
  assert.deepEqual(geminiSettings({}), { model: DEFAULT_GEMINI_LIVE_MODEL, voiceName: DEFAULT_VOICE_NAME });
  assert.deepEqual(geminiSettings({ GEMINI_LIVE_MODEL: 'models/gemini-next-live', GEMINI_VOICE_NAME: 'Puck' }), { model: 'models/gemini-next-live', voiceName: 'Puck' });
  assert.deepEqual(geminiSettings({ GEMINI_LIVE_MODEL: 'gemini-without-prefix', GEMINI_VOICE_NAME: 'not a voice!' }), { model: DEFAULT_GEMINI_LIVE_MODEL, voiceName: DEFAULT_VOICE_NAME });
});
