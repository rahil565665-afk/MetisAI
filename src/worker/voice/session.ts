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
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxDurationMs: 10 * 60_000,
  idleMs: 90_000,
  setupTimeoutMs: 15_000,
  tickMs: 5_000,
  logTimeoutMs: 5_000,
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

/**
 * One browser test call: the browser's microphone audio goes to Gemini Live, Gemini's spoken reply
 * comes back, and the receptionist's tools (Cal.com scheduling, escalation) run in between.
 * Appointment changes wait for an explicit approval from the browser; nothing else is trusted.
 */
export class VoiceSession {
  private readonly limits: SessionLimits;
  private readonly now: () => Date;
  private gemini: VoiceSocket | null = null;
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
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > this.limits.idleMs) void this.finish('idle');
    }, this.limits.tickMs);
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

    const callIdPromise = prepared.store.createCall();
    const socket = await this.deps.connectGemini(prepared.geminiApiKey);
    this.callId = await callIdPromise;
    if (this.finished) {
      this.closeQuietly(socket, NORMAL_CLOSE, 'Call ended');
      return;
    }
    this.gemini = socket;
    this.attachGemini(socket);
    this.setupTimer = setTimeout(
      () => void this.finish('service', 'The voice service did not respond in time. Try again.'),
      this.limits.setupTimeoutMs,
    );
    socket.send(JSON.stringify(setupMessage({
      model: this.deps.model,
      voiceName: this.deps.voiceName,
      systemInstruction: buildSystemInstruction(prepared.config, this.now()),
      tools: TOOL_DECLARATIONS,
    })));
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
    socket.addEventListener('message', (event) => this.onGeminiMessage(event.data));
    socket.addEventListener('close', (event) => {
      if (this.finished) return;
      console.error('[voice-session] gemini closed', event.code);
      if (!this.ready) void this.finish('service', GEMINI_REFUSED);
      else void this.finish('service', event.code === NORMAL_CLOSE ? undefined : 'The voice service disconnected.');
    });
    socket.addEventListener('error', () => {
      if (!this.finished) void this.finish('service', this.ready ? 'The voice service disconnected.' : GEMINI_REFUSED);
    });
  }

  private sendGemini(message: Record<string, unknown>): void {
    try {
      this.gemini?.send(JSON.stringify(message));
    } catch {
      // A failed send means the socket is closing; its close handler ends the session.
    }
  }

  private onGeminiMessage(data: unknown): void {
    if (this.finished) return;
    if (typeof data !== 'string' && !isBinary(data)) {
      this.warnUnsupportedFrame();
      return;
    }
    for (const event of parseServerMessage(data)) {
      if (this.finished) return;
      this.onGeminiEvent(event);
    }
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
      case 'toolCall':
        this.touch();
        this.toolChain = this.toolChain.then(() => this.handleToolCalls(event.calls)).catch(() => undefined);
        return;
      case 'toolCancel':
        for (const id of event.ids) this.cancelledCalls.add(id);
        // Tool calls run one at a time, so any pending approval belongs to a cancelled call.
        this.gate.denyAll();
        return;
      case 'goAway':
        this.send({ type: 'notice', message: 'The voice service will end this session shortly.' });
        return;
      case 'error':
        console.error('[voice-session] gemini reported an error');
        void this.finish('service', 'The voice service reported an error.');
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

  private async handleToolCalls(calls: ToolCall[]): Promise<void> {
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
      if (this.finished) return;
      if (this.cancelledCalls.has(call.id)) continue;
      const response = await runTool(deps, call.name, call.args);
      // A call the model cancelled (the caller interrupted) gets no answer.
      if (this.finished || this.cancelledCalls.has(call.id)) continue;
      results.push({ id: call.id, name: call.name, response });
    }
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
