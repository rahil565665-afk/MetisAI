import {
  parseAgentMessage,
  type ApprovalOperation,
  type ClientMessage,
  type EndReason,
} from '../../shared/voiceProtocol.js';
import type { VoiceStatus } from '../types.js';
import { MicrophoneError, startMicrophone, type Microphone } from './mic.js';
import { Player } from './player.js';

/** Must match VOICE_SUBPROTOCOL in the Worker (src/worker/voiceAuth.ts). */
const VOICE_SUBPROTOCOL = 'dentdesk-voice-v1';
/** Stop sending microphone audio if the connection falls this far behind. */
const MAX_BUFFERED_BYTES = 512 * 1024;

export interface ApprovalRequest {
  approvalId: string;
  operation: ApprovalOperation;
  summary: Record<string, string>;
  expiresInSeconds: number;
}

export interface VoiceClientEvents {
  status(status: VoiceStatus): void;
  transcript(role: 'user' | 'assistant', text: string, final: boolean): void;
  approval(request: ApprovalRequest): void;
  approvalClosed(approvalId: string): void;
  escalation(reason: string): void;
  notice(message: string): void;
  error(message: string): void;
  ended(reason: EndReason): void;
}

export interface StartOptions {
  /** `wss://…/agents/<clinic>/ws` */
  url: string;
  /** Called after the microphone is allowed, so a refused microphone never mints a token. */
  getToken(): Promise<string>;
}

/** Browser side of one test call: microphone in, assistant speech out, control messages both ways. */
export class VoiceClient {
  private context: AudioContext | null = null;
  private microphone: Microphone | null = null;
  private player: Player | null = null;
  private socket: WebSocket | null = null;
  private speakingPoll: number | undefined;
  private status: VoiceStatus = 'idle';
  private ready = false;
  private closing = false;
  private failed = false;
  private approvals = new Set<string>();

  constructor(private readonly events: VoiceClientEvents) {}

  get running(): boolean {
    return this.context !== null;
  }

  /** Call from a click handler: the audio engine must be created during a user gesture. */
  async start(options: StartOptions): Promise<void> {
    if (this.context) return;
    this.closing = false;
    this.failed = false;
    this.ready = false;
    this.setStatus('connecting');

    const AudioContextClass = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      this.fail('This browser does not support the Web Audio API.');
      return;
    }
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    this.context = context;
    void context.resume().catch(() => undefined);
    this.player = new Player(context);

    try {
      this.microphone = await startMicrophone(context, (chunk) => this.sendAudio(chunk));
      if (this.closing) return;
      const token = await options.getToken();
      if (this.closing) return;
      this.connect(options.url, token);
    } catch (cause) {
      if (this.closing) return;
      this.fail(cause instanceof MicrophoneError || cause instanceof Error ? cause.message : 'Could not start the voice test. Please try again.');
    }
  }

  /** Answer a pending approval prompt. */
  respond(approvalId: string, approved: boolean): void {
    if (!this.approvals.delete(approvalId)) return;
    this.sendControl({ type: 'approval_response', approvalId, approved });
  }

  /** End the call from the browser. */
  stop(): void {
    if (!this.context && !this.socket) return;
    this.closing = true;
    this.sendControl({ type: 'end' });
    this.teardown();
    this.setStatus(this.failed ? 'error' : 'disconnected');
  }

  private connect(url: string, token: string): void {
    const socket = new WebSocket(url, [VOICE_SUBPROTOCOL, `bearer.${token}`]);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => { /* The close event that follows carries the outcome. */ };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      if (!this.closing) {
        // The agent always says why a call ends before it closes; reaching here means the connection itself was lost.
        if (!this.failed) {
          this.events.error(this.ready
            ? 'The connection to the voice agent was lost. Check your internet connection and start a new test call.'
            : 'The voice agent refused the connection. Check that this clinic is active and try again.');
        }
        this.failed = true;
        this.teardown();
        this.setStatus('error');
      }
    };
    this.speakingPoll = window.setInterval(() => {
      if (this.status === 'speaking' && this.player && !this.player.speaking) this.setStatus('listening');
    }, 150);
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (!this.ready) return;
      this.player?.enqueue(data);
      if (this.status === 'listening' || this.status === 'processing') this.setStatus('speaking');
      return;
    }
    if (typeof data !== 'string') return;
    const message = parseAgentMessage(data);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.setStatus('listening');
        return;
      case 'transcript':
        this.events.transcript(message.role, message.text, message.final);
        return;
      case 'interrupted':
        this.player?.flush();
        if (this.status === 'speaking') this.setStatus('listening');
        return;
      case 'turn_complete':
        return;
      case 'approval_request':
        this.approvals.add(message.approvalId);
        this.setStatus('processing');
        this.events.approval(message);
        return;
      case 'approval_closed':
        this.approvals.delete(message.approvalId);
        this.events.approvalClosed(message.approvalId);
        if (this.status === 'processing' && this.approvals.size === 0) this.setStatus('listening');
        return;
      case 'escalation':
        this.events.escalation(message.reason);
        this.setStatus('transfer_requested');
        return;
      case 'notice':
        this.events.notice(message.message);
        return;
      case 'error':
        this.failed = true;
        this.events.error(message.message);
        return;
      case 'ended':
        this.closing = true;
        this.events.ended(message.reason);
        this.teardown();
        this.setStatus(this.failed ? 'error' : 'disconnected');
        return;
    }
  }

  private sendAudio(chunk: ArrayBuffer): void {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
    socket.send(chunk);
  }

  private sendControl(message: ClientMessage): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private fail(message: string): void {
    this.failed = true;
    this.events.error(message);
    this.teardown();
    this.setStatus('error');
  }

  private teardown(): void {
    window.clearInterval(this.speakingPoll);
    this.speakingPoll = undefined;
    this.microphone?.stop();
    this.microphone = null;
    this.player?.flush();
    this.player = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, 'Call ended');
    }
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    this.approvals.clear();
    this.ready = false;
  }

  private setStatus(next: VoiceStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.events.status(next);
  }
}
