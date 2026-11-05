import {
  MAX_CLIENT_AUDIO_FRAME_BYTES,
  parseClientMessage,
  type AgentMessage,
  type EndReason,
} from '../../shared/voiceProtocol.js';
import { ApprovalGate, type ApprovalNotifier } from './approval.js';
import type { CalComClient } from './calcom.js';
import type { ClinicConfig } from './clinicConfig.js';
import { base64ToBytes, bytesToBase64, isBinary, toBytes } from './encoding.js';
import {
  audioChunkMessage,
  parseServerMessage,
  setupMessage,
  textInputMessage,
  toolResponseMessage,
  safeProviderText,
  type GeminiEvent,
  type ToolCall,
  type ToolResult,
} from './gemini.js';
import {
  GREETING_TRIGGER,
  TOOL_DECLARATIONS,
  buildSystemInstruction,
  runTool,
  type CallStore,
  type ToolDeps,
} from './receptionist.js';

/** Minimal WebSocket surface the session needs; satisfied by Workers' WebSocket and by test fakes. */
export interface VoiceSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** Thrown by `prepare` / `connectGemini` when the message is safe to show the person at the browser. */
export class SessionStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStartError';
  }
}

export interface PreparedSession {
  config: ClinicConfig;
  geminiApiKey: string;
  cal: CalComClient | null;
  calError: string | null;
  store: CallStore;
}

export interface SessionLimits {
  /** Hard cap on one test call. Keeps cost and free-plan usage bounded. */
  maxDurationMs: number;
  /** End the call after this long without speech, transcripts or approvals. */
  idleMs: number;
  /** How long Gemini may take to accept the setup message. */
  setupTimeoutMs: number;
  /** Granularity of the idle check. */
  tickMs: number;
  /** How long to wait for the call-log update when ending. */
  logTimeoutMs: number;
  /** The person is told this long before the time limit or the idle limit ends the call. */
  warnMs: number;
  /** How many times a dropped Gemini connection is re-opened (resuming the same conversation). */
  maxReconnects: number;
  /** Base pause between reconnect attempts; grows with each attempt. */
  reconnectDelayMs: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxDurationMs: 30 * 60_000,
  idleMs: 180_000,
  setupTimeoutMs: 15_000,
  tickMs: 5_000,
  logTimeoutMs: 5_000,
  warnMs: 30_000,
  maxReconnects: 3,
  reconnectDelayMs: 500,
};

export interface SessionDeps {
  client: VoiceSocket;
  prepare(): Promise<PreparedSession>;
  connectGemini(apiKey: string): Promise<VoiceSocket>;
  model: string;
  voiceName: string;
  now?: () => Date;
  limits?: Partial<SessionLimits>;
  approvalTimeoutMs?: number;
  newApprovalId?: () => string;
}

const NORMAL_CLOSE = 1000;
const SERVICE_CLOSE = 1011;
export const GEMINI_REFUSED = 'The Gemini Live service refused the connection. Check the clinic\'s Gemini API key and that it has Live API access.';
const IDLE_NOTICE = 'No one has spoken for a while. The test call will end soon unless someone speaks.';
const LIMIT_NOTICE = 'This test call is about to reach its time limit. Start a new test call to keep going.';
const ENDING_NOTICE = 'The voice service will end this session shortly.';
const RECONNECT_NOTICE = 'The voice connection dropped. Reconnecting…';

/** " (code 1007: reason)" with the service's own wording cleaned up, or nothing if it said nothing. */
function closeDetail(code: number, reason: string): string {
  const text = safeProviderText(reason, 120);
  if (!code && !text) return '';
  return ` (${code ? `code ${code}` : 'no code'}${text ? `: ${text}` : ''})`;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One browser test call: the browser's microphone audio goes to Gemini Live, Gemini's spoken reply
 * comes back, and the receptionist's tools (Cal.com scheduling, escalation) run in between.
 * Appointment changes wait for an explicit approval from the browser; nothing else is trusted.
 */
export class VoiceSession {
  private readonly limits: SessionLimits;
  private readonly now: () => Date;
  private gemini: VoiceSocket | null = null;
  /** A replacement connection that has been opened but has not yet accepted its setup message. */
  private pending: VoiceSocket | null = null;
  private pendingSettled: ((ok: boolean) => void) | null = null;
  private resumeHandle: string | null = null;
  private longSession = true;
  private setupRetried = false;
  private reconnecting = false;
  /** Bumped whenever the Gemini connection is replaced, so answers meant for the old one are dropped. */
  private epoch = 0;
  private startedAt = Date.now();
  private warnedIdle = false;
  private warnedLimit = false;
  private endingSoon = false;
  private shownNotice = '';
  private gate: ApprovalGate;
  private prepared: PreparedSession | null = null;
  private callId: string | null = null;
  private ready = false;
  private finished = false;
  private transferRequested = false;
  private lastActivity = Date.now();
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private current: { role: 'user' | 'assistant'; text: string } | null = null;
  private readonly cancelledCalls = new Set<string>();
  private toolChain: Promise<void> = Promise.resolve();
  private resolveDone!: () => void;
  private readonly done = new Promise<void>((resolve) => { this.resolveDone = resolve; });

  constructor(private readonly deps: SessionDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.now = deps.now ?? (() => new Date());
    const notifier: ApprovalNotifier = {
      request: (approvalId, operation, summary, expiresInSeconds) => {
        this.touch();
        this.send({ type: 'approval_request', approvalId, operation, summary, expiresInSeconds });
      },
      closed: (approvalId) => {
        this.touch();
        this.send({ type: 'approval_closed', approvalId });
      },
    };
    this.gate = new ApprovalGate(notifier, deps.approvalTimeoutMs, deps.newApprovalId);
  }

  get active(): boolean {
    return !this.finished;
  }

  /** Runs until the call ends for any reason. Never rejects. */
  async run(): Promise<void> {
    this.attachClient();
    this.deadlineTimer = setTimeout(() => void this.finish('time_limit'), this.limits.maxDurationMs);
    this.startedAt = Date.now();
    this.idleTimer = setInterval(() => this.tick(), this.limits.tickMs);
    try {
      await this.start();
    } catch (error) {
      const message = error instanceof SessionStartError ? error.message : 'The voice session could not be started.';
      if (!(error instanceof SessionStartError)) console.error('[voice-session] start failed', error instanceof Error ? error.name : 'unknown');
      await this.finish('service', message);
    }
    await this.done;
  }

  /** Dashboard-initiated stop (for example when credentials change). */
  end(reason: EndReason = 'admin'): Promise<void> {
    void this.finish(reason);
    return this.done;
  }

  private async start(): Promise<void> {
    const prepared = await this.deps.prepare();
    if (this.finished) return;
    this.prepared = prepared;

    const callIdPromise = prepared.store.createCall().catch(() => null);
    try {
      await this.openInitial();
    } finally {
      this.callId = await callIdPromise;
    }
  }

  private setup(resumeHandle: string | null): string {
    const prepared = this.prepared as PreparedSession;
    return JSON.stringify(setupMessage({
      model: this.deps.model,
      voiceName: this.deps.voiceName,
      systemInstruction: buildSystemInstruction(prepared.config, this.now()),
      tools: TOOL_DECLARATIONS,
      resumeHandle,
      longSession: this.longSession,
    }));
  }

  /** Open the first Gemini connection and send the setup message. Also used for the one fallback retry. */
  private async openInitial(): Promise<void> {
    const prepared = this.prepared as PreparedSession;
    const socket = await this.deps.connectGemini(prepared.geminiApiKey);
    if (this.finished) {
      this.closeQuietly(socket, NORMAL_CLOSE, 'Call ended');
      return;
    }
    this.gemini = socket;
    this.attachGemini(socket);
    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(
      () => void this.finish('service', 'The voice service did not respond in time. Try again.'),
      this.limits.setupTimeoutMs,
    );
    socket.send(this.setup(null));
  }

  // --- browser side -------------------------------------------------------------------------

  private attachClient(): void {
    const { client } = this.deps;
    client.addEventListener('message', (event) => this.onClientMessage(event.data));
    client.addEventListener('close', () => void this.finish('client'));
    client.addEventListener('error', () => void this.finish('client'));
  }

  private onClientMessage(data: unknown): void {
    if (this.finished) return;
    if (typeof data === 'string') {
      const message = parseClientMessage(data);
      if (!message) return;
      if (message.type === 'end') void this.finish('client');
      else this.gate.answer(message.approvalId, message.approved);
      return;
    }
    if (!isBinary(data)) {
      this.warnUnsupportedFrame();
      return;
    }
    const bytes = toBytes(data);
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_CLIENT_AUDIO_FRAME_BYTES) {
      void this.finish('service', 'The browser sent an invalid audio frame.');
      return;
    }
    // Audio sent before Gemini accepts the setup message is dropped, never queued.
    if (this.ready && this.gemini) this.sendGemini(audioChunkMessage(bytesToBase64(bytes)));
  }

  private warnedFrames = false;

  /** Frames that are neither text nor ArrayBuffers (for example Blobs) mean binaryType was not set. */
  private warnUnsupportedFrame(): void {
    if (this.warnedFrames) return;
    this.warnedFrames = true;
    console.error('[voice-session] ignoring a WebSocket frame of an unsupported type');
  }

  private send(message: AgentMessage): void {
    const { client } = this.deps;
    try {
      client.send(JSON.stringify(message));
    } catch {
      // The browser is gone; the close handler ends the session.
    }
  }

  private sendAudio(base64: string): void {
    try {
      const bytes = base64ToBytes(base64);
      if (bytes.byteLength === 0) return;
      this.deps.client.send(bytes.buffer as ArrayBuffer);
    } catch {
      // Ignore malformed audio or a closed browser socket.
    }
  }

  // --- Gemini side --------------------------------------------------------------------------

  private attachGemini(socket: VoiceSocket): void {
    socket.addEventListener('message', (event) => this.onGeminiMessage(socket, event.data));
    socket.addEventListener('close', (event) => this.onGeminiClosed(socket, event.code, event.reason));
    socket.addEventListener('error', () => this.onGeminiClosed(socket, 0, ''));
  }

  private sendGemini(message: Record<string, unknown>): void {
    try {
      this.gemini?.send(JSON.stringify(message));
    } catch {
      // A failed send means the socket is closing; its close handler deals with it.
    }
  }

  private onGeminiMessage(socket: VoiceSocket, data: unknown): void {
    if (this.finished) return;
    if (typeof data !== 'string' && !isBinary(data)) {
      this.warnUnsupportedFrame();
      return;
    }
    for (const event of parseServerMessage(data)) {
      if (this.finished) return;
      if (socket === this.pending) {
        if (event.kind === 'setupComplete') this.promote(socket);
        else if (event.kind === 'error') this.dropPending(socket);
      }
      // Connections that have been replaced or dropped are ignored.
      if (socket === this.gemini) this.onGeminiEvent(event);
    }
  }

  private onGeminiClosed(socket: VoiceSocket, code: number, reason: string): void {
    if (this.finished) return;
    if (socket === this.pending) {
      this.dropPending(socket);
      return;
    }
    if (socket !== this.gemini) return;
    this.gemini = null;
    console.error('[voice-session] gemini closed', code);
    if (!this.ready) {
      this.setupFailed(code, reason);
      return;
    }
    void this.reconnect(`code ${code || 'none'}`, closeDetail(code, reason));
  }

  /**
   * The service refused the setup message. The long-call settings are the only optional part of it, so
   * try once more without them before giving up, and say what the service said.
   */
  private setupFailed(code: number, reason: string): void {
    if (this.longSession && !this.setupRetried) {
      this.setupRetried = true;
      this.longSession = false;
      console.error('[voice-session] retrying setup without long-call settings', code);
      this.openInitial().catch((error: unknown) => {
        const message = error instanceof SessionStartError ? error.message : 'The voice session could not be started.';
        void this.finish('service', message);
      });
      return;
    }
    void this.finish('service', `${GEMINI_REFUSED}${closeDetail(code, reason)}`);
  }

  /**
   * Open a replacement connection that continues the same conversation, then switch to it. Used when the
   * service announces it is about to end the connection and when the connection drops unexpectedly.
   */
  private async reconnect(cause: string, detail = ''): Promise<void> {
    if (this.reconnecting || this.finished) return;
    this.reconnecting = true;
    try {
      this.updateNotice();
      for (let attempt = 1; attempt <= this.limits.maxReconnects && !this.finished; attempt += 1) {
        const handle = this.resumeHandle;
        if (!handle) break;
        if (attempt > 1) await pause(this.limits.reconnectDelayMs * attempt);
        if (this.finished) return;
        if (await this.openResumed(handle)) return;
        console.error('[voice-session] reconnect attempt failed', attempt, cause);
      }
      if (!this.finished && !this.gemini) {
        await this.finish('service', `The voice service connection was lost and could not be restored${detail}.`);
      }
    } finally {
      this.reconnecting = false;
      this.updateNotice();
    }
  }

  private async openResumed(handle: string): Promise<boolean> {
    const prepared = this.prepared;
    if (!prepared) return false;
    let socket: VoiceSocket;
    try {
      socket = await this.deps.connectGemini(prepared.geminiApiKey);
    } catch {
      return false;
    }
    if (this.finished) {
      this.closeQuietly(socket, NORMAL_CLOSE, 'Call ended');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.dropPending(socket), this.limits.setupTimeoutMs);
      this.pending = socket;
      this.pendingSettled = (ok) => { clearTimeout(timer); resolve(ok); };
      this.attachGemini(socket);
      try {
        socket.send(this.setup(handle));
      } catch {
        this.dropPending(socket);
      }
    });
  }

  private settlePending(ok: boolean): void {
    const settled = this.pendingSettled;
    this.pendingSettled = null;
    settled?.(ok);
  }

  private dropPending(socket: VoiceSocket): void {
    if (this.pending !== socket) return;
    this.pending = null;
    this.closeQuietly(socket, NORMAL_CLOSE, 'Replacement failed');
    this.settlePending(false);
  }

  /** The replacement accepted its setup: switch over and retire the old connection. */
  private promote(socket: VoiceSocket): void {
    const old = this.gemini;
    this.gemini = socket;
    this.pending = null;
    this.epoch += 1;
    // Anything the old connection was waiting on can no longer be answered.
    this.gate.denyAll();
    this.touch();
    this.settlePending(true);
    if (old) this.closeQuietly(old, NORMAL_CLOSE, 'Replaced');
    this.endingSoon = false;
    this.updateNotice();
  }

  private onGeminiEvent(event: GeminiEvent): void {
    switch (event.kind) {
      case 'setupComplete':
        if (this.ready) return;
        this.ready = true;
        clearTimeout(this.setupTimer);
        this.touch();
        this.send({ type: 'ready' });
        this.sendGemini(textInputMessage(GREETING_TRIGGER));
        return;
      case 'interrupted':
        this.flushTranscript();
        this.send({ type: 'interrupted' });
        return;
      case 'audio':
        this.touch();
        this.sendAudio(event.data);
        return;
      case 'badAudioFormat':
        console.error('[voice-session] unexpected audio format', event.mimeType);
        void this.finish('service', 'The voice service returned audio in an unsupported format.');
        return;
      case 'inputTranscript':
        this.touch();
        this.appendTranscript('user', event.text);
        return;
      case 'outputTranscript':
        this.touch();
        this.appendTranscript('assistant', event.text);
        return;
      case 'turnComplete':
        this.flushTranscript();
        this.send({ type: 'turn_complete' });
        return;
      case 'resumption':
        if (event.resumable && event.handle) this.resumeHandle = event.handle;
        return;
      case 'toolCall': {
        this.touch();
        const epoch = this.epoch;
        this.toolChain = this.toolChain.then(() => this.handleToolCalls(event.calls, epoch)).catch(() => undefined);
        return;
      }
      case 'toolCancel':
        for (const id of event.ids) this.cancelledCalls.add(id);
        // Tool calls run one at a time, so any pending approval belongs to a cancelled call.
        this.gate.denyAll();
        return;
      case 'goAway':
        if (this.resumeHandle) {
          void this.reconnect('goAway');
        } else {
          this.endingSoon = true;
          this.updateNotice();
        }
        return;
      case 'error':
        console.error('[voice-session] gemini reported an error');
        void this.finish('service', `The voice service reported an error${event.detail ? `: ${event.detail}` : ''}.`);
        return;
    }
  }

  private appendTranscript(role: 'user' | 'assistant', fragment: string): void {
    if (this.current && this.current.role !== role) this.flushTranscript();
    this.current = { role, text: `${this.current?.text ?? ''}${fragment}` };
    this.send({ type: 'transcript', role, text: this.current.text, final: false });
  }

  private flushTranscript(): void {
    if (!this.current) return;
    const { role, text } = this.current;
    this.current = null;
    if (text.trim()) this.send({ type: 'transcript', role, text, final: true });
  }

  private async handleToolCalls(calls: ToolCall[], epoch: number): Promise<void> {
    const prepared = this.prepared;
    if (!prepared) return;
    const deps: ToolDeps = {
      callId: this.callId,
      cal: prepared.cal,
      calError: prepared.calError,
      gate: this.gate,
      store: prepared.store,
      now: this.now,
      escalate: (reason) => this.escalate(reason),
    };
    const results: ToolResult[] = [];
    for (const call of calls) {
      if (this.finished || epoch !== this.epoch) return;
      if (this.cancelledCalls.has(call.id)) continue;
      const response = await runTool(deps, call.name, call.args);
      // A call the model cancelled (the caller interrupted) gets no answer.
      if (this.finished || this.cancelledCalls.has(call.id)) continue;
      results.push({ id: call.id, name: call.name, response });
    }
    // The connection was replaced while the tools ran; the new one knows nothing of these calls.
    if (epoch !== this.epoch) return;
    if (results.length > 0 && !this.finished) {
      this.touch();
      this.sendGemini(toolResponseMessage(results));
    }
  }

  private async escalate(reason: string): Promise<void> {
    this.transferRequested = true;
    this.send({ type: 'escalation', reason });
    await this.prepared?.store.updateCall(this.callId, { status: 'transfer_requested', transfer_requested: true, transfer_reason: reason });
  }

  // --- lifecycle ----------------------------------------------------------------------------

  private touch(): void {
    this.lastActivity = Date.now();
    if (this.warnedIdle) {
      this.warnedIdle = false;
      this.updateNotice();
    }
  }

  private tick(): void {
    const now = Date.now();
    const quiet = now - this.lastActivity;
    if (quiet > this.limits.idleMs) {
      void this.finish('idle');
      return;
    }
    if (!this.warnedLimit && now - this.startedAt > this.limits.maxDurationMs - this.limits.warnMs) this.warnedLimit = true;
    if (!this.warnedIdle && quiet > this.limits.idleMs - this.limits.warnMs) this.warnedIdle = true;
    this.updateNotice();
  }

  /** One banner at a time in the browser; the most urgent applies. An empty message clears it. */
  private updateNotice(): void {
    if (this.finished) return;
    let message = '';
    if (this.ready && !this.gemini) message = RECONNECT_NOTICE;
    else if (this.warnedLimit) message = LIMIT_NOTICE;
    else if (this.endingSoon) message = ENDING_NOTICE;
    else if (this.warnedIdle) message = IDLE_NOTICE;
    if (message === this.shownNotice) return;
    this.shownNotice = message;
    this.send({ type: 'notice', message });
  }

  private closeQuietly(socket: VoiceSocket | null, code: number, reason: string): void {
    try {
      socket?.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private async finish(reason: EndReason, failure?: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.deadlineTimer);
    clearTimeout(this.setupTimer);
    clearInterval(this.idleTimer);
    if (this.pending) this.closeQuietly(this.pending, NORMAL_CLOSE, 'Call ended');
    this.pending = null;
    this.settlePending(false);
    this.gate.denyAll();
    this.flushTranscript();
    if (failure) this.send({ type: 'error', message: failure });
    this.send({ type: 'ended', reason });
    this.closeQuietly(this.deps.client, failure ? SERVICE_CLOSE : NORMAL_CLOSE, failure ? 'Voice session failed' : 'Call ended');
    this.closeQuietly(this.gemini, NORMAL_CLOSE, 'Call ended');
    try {
      await this.writeCallLog(Boolean(failure));
    } finally {
      this.resolveDone();
    }
  }

  private async writeCallLog(failed: boolean): Promise<void> {
    const store = this.prepared?.store;
    if (!store || !this.callId) return;
    const fields = {
      ended_at: this.now().toISOString(),
      // A requested human handoff keeps its status; only the end time is added.
      ...(this.transferRequested ? {} : { status: failed ? 'error' as const : 'completed' as const }),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.limits.logTimeoutMs); });
    try {
      await Promise.race([store.updateCall(this.callId, fields), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
