/** Pure sign-in throttling rules, shared by the in-memory limiter and the Durable Object limiter. */
export const MAX_ATTEMPTS = 8;
export const WINDOW_MS = 15 * 60 * 1000;

export interface AttemptState {
  count: number;
  resetAt: number;
}

export function isBlocked(state: AttemptState | undefined, now: number): boolean {
  return Boolean(state && state.resetAt > now && state.count >= MAX_ATTEMPTS);
}

export function afterFailure(state: AttemptState | undefined, now: number): AttemptState {
  if (!state || state.resetAt <= now) return { count: 1, resetAt: now + WINDOW_MS };
  return { count: state.count + 1, resetAt: state.resetAt };
}

export interface LoginRateLimiter {
  isBlocked(key: string): Promise<boolean>;
  recordFailure(key: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/** Per-process limiter for local development. Production installs a Durable Object limiter. */
export class MemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly attempts = new Map<string, AttemptState>();

  async isBlocked(key: string): Promise<boolean> {
    const now = Date.now();
    for (const [oldKey, state] of this.attempts) if (state.resetAt <= now) this.attempts.delete(oldKey);
    return isBlocked(this.attempts.get(key), now);
  }

  async recordFailure(key: string): Promise<void> {
    this.attempts.set(key, afterFailure(this.attempts.get(key), Date.now()));
  }

  async clear(key: string): Promise<void> {
    this.attempts.delete(key);
  }
}
