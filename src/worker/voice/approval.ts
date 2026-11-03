import type { ApprovalOperation } from '../../shared/voiceProtocol.js';

export const APPROVAL_TIMEOUT_MS = 60_000;

export interface ApprovalNotifier {
  request(approvalId: string, operation: ApprovalOperation, summary: Record<string, string>, expiresInSeconds: number): void;
  closed(approvalId: string): void;
}

/**
 * In-memory rendezvous between a tool call and the person at the browser. Appointment changes
 * only proceed after an explicit browser approval; spoken consent alone never counts. Nothing is
 * persisted, and every request fails closed (denied) on timeout, interruption or disconnect.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly notifier: ApprovalNotifier,
    private readonly timeoutMs: number = APPROVAL_TIMEOUT_MS,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  request(operation: ApprovalOperation, summary: Record<string, string>): Promise<boolean> {
    const approvalId = this.newId();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(approvalId, false), this.timeoutMs);
      this.pending.set(approvalId, { resolve, timer });
      this.notifier.request(approvalId, operation, summary, Math.round(this.timeoutMs / 1000));
    });
  }

  /** Apply the browser's answer. Returns false for unknown, expired or malformed answers. */
  answer(approvalId: unknown, approved: unknown): boolean {
    if (typeof approvalId !== 'string' || typeof approved !== 'boolean' || !this.pending.has(approvalId)) return false;
    this.settle(approvalId, approved);
    return true;
  }

  denyAll(): void {
    for (const approvalId of [...this.pending.keys()]) this.settle(approvalId, false);
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(approvalId: string, approved: boolean): void {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    this.pending.delete(approvalId);
    clearTimeout(entry.timer);
    this.notifier.closed(approvalId);
    entry.resolve(approved);
  }
}
