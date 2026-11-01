import { DurableObject } from 'cloudflare:workers';
import { afterFailure, isBlocked, type AttemptState } from '../server/auth/loginRateLimit.js';

const STATE_KEY = 'attempts';

/**
 * One Durable Object per hashed client address, so sign-in attempts are counted across every
 * Worker instance. State deletes itself when the attempt window ends.
 */
export class LoginLimiter extends DurableObject {
  async isBlocked(): Promise<boolean> {
    return isBlocked(await this.ctx.storage.get<AttemptState>(STATE_KEY), Date.now());
  }

  async recordFailure(): Promise<void> {
    const next = afterFailure(await this.ctx.storage.get<AttemptState>(STATE_KEY), Date.now());
    await this.ctx.storage.put(STATE_KEY, next);
    await this.ctx.storage.setAlarm(next.resetAt);
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<AttemptState>(STATE_KEY);
    if (!state || state.resetAt <= Date.now()) await this.ctx.storage.deleteAll();
  }
}
