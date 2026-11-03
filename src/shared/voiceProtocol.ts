/**
 * Wire protocol between the dashboard's voice tester and a clinic's ClinicAgent Durable Object.
 *
 * Audio travels as raw binary WebSocket frames (signed 16-bit little-endian mono PCM). Everything
 * else is a small JSON text frame described by the types below. Shared by browser and Worker code.
 */

/** Browser microphone audio sent to the agent. */
export const CLIENT_AUDIO_SAMPLE_RATE = 16_000;
/** Agent speech audio sent to the browser (Gemini Live native output rate). */
export const AGENT_AUDIO_SAMPLE_RATE = 24_000;
/** The browser sends microphone audio in chunks of this length. Larger chunks mean fewer WebSocket messages. */
export const CLIENT_CHUNK_MS = 100;
/** The agent rejects any single audio frame larger than this. */
export const MAX_CLIENT_AUDIO_FRAME_BYTES = 64 * 1024;

export type ApprovalOperation = 'create_booking' | 'reschedule_booking' | 'cancel_booking';
export type EndReason = 'client' | 'time_limit' | 'idle' | 'admin' | 'service';

export type AgentMessage =
  | { type: 'ready' }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'approval_request'; approvalId: string; operation: ApprovalOperation; summary: Record<string, string>; expiresInSeconds: number }
  | { type: 'approval_closed'; approvalId: string }
  | { type: 'escalation'; reason: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string }
  | { type: 'ended'; reason: EndReason };

export type ClientMessage =
  | { type: 'approval_response'; approvalId: string; approved: boolean }
  | { type: 'end' };

const OPERATIONS: readonly string[] = ['create_booking', 'reschedule_booking', 'cancel_booking'];
const END_REASONS: readonly string[] = ['client', 'time_limit', 'idle', 'admin', 'service'];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseJson(text: string): Record<string, unknown> | null {
  if (text.length > 64 * 1024) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Validate a JSON text frame sent by the agent. Returns null for anything unrecognised. */
export function parseAgentMessage(text: string): AgentMessage | null {
  const data = parseJson(text);
  if (!data || typeof data.type !== 'string') return null;
  switch (data.type) {
    case 'ready':
    case 'interrupted':
    case 'turn_complete':
      return { type: data.type };
    case 'transcript':
      if ((data.role === 'user' || data.role === 'assistant') && typeof data.text === 'string' && typeof data.final === 'boolean') {
        return { type: 'transcript', role: data.role, text: data.text, final: data.final };
      }
      return null;
    case 'approval_request': {
      const summary = record(data.summary);
      if (typeof data.approvalId !== 'string' || typeof data.operation !== 'string' || !OPERATIONS.includes(data.operation) || !summary) return null;
      const safe: Record<string, string> = {};
      for (const [key, value] of Object.entries(summary)) safe[key] = String(value);
      const expires = typeof data.expiresInSeconds === 'number' && Number.isFinite(data.expiresInSeconds) ? data.expiresInSeconds : 60;
      return { type: 'approval_request', approvalId: data.approvalId, operation: data.operation as ApprovalOperation, summary: safe, expiresInSeconds: expires };
    }
    case 'approval_closed':
      return typeof data.approvalId === 'string' ? { type: 'approval_closed', approvalId: data.approvalId } : null;
    case 'escalation':
      return { type: 'escalation', reason: typeof data.reason === 'string' ? data.reason : '' };
    case 'notice':
    case 'error':
      return typeof data.message === 'string' ? { type: data.type, message: data.message } : null;
    case 'ended':
      return typeof data.reason === 'string' && END_REASONS.includes(data.reason) ? { type: 'ended', reason: data.reason as EndReason } : null;
    default:
      return null;
  }
}

/** Validate a JSON text frame sent by the browser. Returns null for anything unrecognised. */
export function parseClientMessage(text: string): ClientMessage | null {
  const data = parseJson(text);
  if (!data || typeof data.type !== 'string') return null;
  if (data.type === 'end') return { type: 'end' };
  if (data.type === 'approval_response' && typeof data.approvalId === 'string' && data.approvalId.length <= 128 && typeof data.approved === 'boolean') {
    return { type: 'approval_response', approvalId: data.approvalId, approved: data.approved };
  }
  return null;
}
