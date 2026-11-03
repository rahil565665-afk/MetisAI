import { frameToText, type FrameData } from './encoding.js';

/**
 * Gemini Live API (raw WebSocket, v1beta BidiGenerateContent) message builders and parser.
 * Field names follow the wire format the official Google SDK emits: generation settings live under
 * `setup.generationConfig`, audio goes in `realtimeInput.audio`, and tool results in `toolResponse`.
 */

export const DEFAULT_GEMINI_LIVE_MODEL = 'models/gemini-3.8-live';
export const DEFAULT_VOICE_NAME = 'Charon';
export const GEMINI_LIVE_ORIGIN = 'https://generativelanguage.googleapis.com';
const GEMINI_LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const INPUT_AUDIO_MIME = 'audio/pcm;rate=16000';
export const OUTPUT_AUDIO_RATE = 24_000;

/** URL to `fetch()` with `Upgrade: websocket`. The API key goes in a header, never in the URL. */
export function geminiLiveUrl(origin: string = GEMINI_LIVE_ORIGIN): string {
  return `${origin.replace(/\/+$/, '')}${GEMINI_LIVE_PATH}`;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: { type: 'OBJECT'; properties: Record<string, { type: 'STRING'; description?: string }>; required: string[] };
}

export interface SetupOptions {
  model: string;
  voiceName: string;
  systemInstruction: string;
  tools: FunctionDeclaration[];
}

export function setupMessage(options: SetupOptions): Record<string, unknown> {
  return {
    setup: {
      model: options.model,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } } },
      },
      systemInstruction: { parts: [{ text: options.systemInstruction }] },
      tools: [{ functionDeclarations: options.tools }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function audioChunkMessage(base64: string): Record<string, unknown> {
  return { realtimeInput: { audio: { data: base64, mimeType: INPUT_AUDIO_MIME } } };
}

export function textInputMessage(text: string): Record<string, unknown> {
  return { realtimeInput: { text } };
}

export interface ToolResult {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export function toolResponseMessage(results: ToolResult[]): Record<string, unknown> {
  return { toolResponse: { functionResponses: results.map(({ id, name, response }) => ({ id, name, response })) } };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type GeminiEvent =
  | { kind: 'setupComplete' }
  | { kind: 'interrupted' }
  | { kind: 'audio'; data: string }
  | { kind: 'badAudioFormat'; mimeType: string }
  | { kind: 'inputTranscript'; text: string }
  | { kind: 'outputTranscript'; text: string }
  | { kind: 'turnComplete' }
  | { kind: 'toolCall'; calls: ToolCall[] }
  | { kind: 'toolCancel'; ids: string[] }
  | { kind: 'goAway' }
  | { kind: 'error' };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function audioRate(mimeType: string): number | null {
  const match = /^audio\/pcm(?:;\s*rate=(\d+))?$/i.exec(mimeType.trim());
  if (!match) return null;
  return match[1] ? Number(match[1]) : OUTPUT_AUDIO_RATE;
}

/**
 * Turn one raw server frame into zero or more events. Several can arrive in a single message, and
 * they are returned in the order they must be handled: interruption first, then audio and
 * transcripts, then end-of-turn, then tool calls.
 */
export function parseServerMessage(data: FrameData): GeminiEvent[] {
  let message: Record<string, unknown> | null;
  try {
    message = record(JSON.parse(frameToText(data)));
  } catch {
    return [{ kind: 'error' }];
  }
  if (!message) return [{ kind: 'error' }];
  if (message.error !== undefined) return [{ kind: 'error' }];

  const events: GeminiEvent[] = [];
  if (message.setupComplete !== undefined) events.push({ kind: 'setupComplete' });

  const content = record(message.serverContent);
  if (content) {
    if (content.interrupted === true) events.push({ kind: 'interrupted' });
    const parts = record(content.modelTurn)?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = record(record(part)?.inlineData);
        if (!inline || typeof inline.data !== 'string') continue;
        const mimeType = typeof inline.mimeType === 'string' ? inline.mimeType : '';
        if (audioRate(mimeType) === OUTPUT_AUDIO_RATE) events.push({ kind: 'audio', data: inline.data });
        else events.push({ kind: 'badAudioFormat', mimeType: mimeType.slice(0, 40) });
      }
    }
    const input = record(content.inputTranscription);
    if (typeof input?.text === 'string' && input.text) events.push({ kind: 'inputTranscript', text: input.text });
    const output = record(content.outputTranscription);
    if (typeof output?.text === 'string' && output.text) events.push({ kind: 'outputTranscript', text: output.text });
    if (content.turnComplete === true) events.push({ kind: 'turnComplete' });
  }

  const toolCall = record(message.toolCall);
  if (toolCall && Array.isArray(toolCall.functionCalls)) {
    const calls: ToolCall[] = [];
    for (const item of toolCall.functionCalls) {
      const call = record(item);
      if (!call || typeof call.id !== 'string' || typeof call.name !== 'string') continue;
      calls.push({ id: call.id, name: call.name, args: record(call.args) ?? {} });
    }
    if (calls.length) events.push({ kind: 'toolCall', calls });
  }

  const cancellation = record(message.toolCallCancellation);
  if (cancellation && Array.isArray(cancellation.ids)) {
    events.push({ kind: 'toolCancel', ids: cancellation.ids.filter((id): id is string => typeof id === 'string') });
  }
  if (message.goAway !== undefined) events.push({ kind: 'goAway' });
  return events;
}

const MODEL_PATTERN = /^models\/[A-Za-z0-9._-]{1,80}$/;
const VOICE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,29}$/;

/** Optional, non-secret overrides so a model or voice rename never needs a code change. */
export function geminiSettings(source: Record<string, string | undefined>): { model: string; voiceName: string } {
  const model = source.GEMINI_LIVE_MODEL?.trim();
  const voice = source.GEMINI_VOICE_NAME?.trim();
  return {
    model: model && MODEL_PATTERN.test(model) ? model : DEFAULT_GEMINI_LIVE_MODEL,
    voiceName: voice && VOICE_PATTERN.test(voice) ? voice : DEFAULT_VOICE_NAME,
  };
}
