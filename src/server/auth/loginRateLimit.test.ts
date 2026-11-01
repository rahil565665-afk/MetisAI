import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ATTEMPTS, MemoryLoginRateLimiter, WINDOW_MS, afterFailure, isBlocked, type AttemptState } from './loginRateLimit.js';

test('blocks only after the maximum number of failures inside the window', () => {
  const now = 1_000_000;
  let state: AttemptState | undefined;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    state = afterFailure(state, now);
    assert.equal(isBlocked(state, now), false, `attempt ${attempt} must not block`);
  }
  state = afterFailure(state, now);
  assert.equal(isBlocked(state, now), true);
});

test('the block lifts when the window ends and the count restarts', () => {
  const now = 1_000_000;
  let state: AttemptState | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) state = afterFailure(state, now);
  assert.equal(isBlocked(state, now + WINDOW_MS - 1), true);
  assert.equal(isBlocked(state, now + WINDOW_MS), false);
  assert.deepEqual(afterFailure(state, now + WINDOW_MS), { count: 1, resetAt: now + 2 * WINDOW_MS });
});

test('failures do not extend the window', () => {
  const now = 1_000_000;
  const first = afterFailure(undefined, now);
  const second = afterFailure(first, now + 60_000);
  assert.equal(second.resetAt, first.resetAt);
});

test('the in-memory limiter tracks keys independently and clears on success', async () => {
  const limiter = new MemoryLoginRateLimiter();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) await limiter.recordFailure('client-a');
  assert.equal(await limiter.isBlocked('client-a'), true);
  assert.equal(await limiter.isBlocked('client-b'), false);
  await limiter.clear('client-a');
  assert.equal(await limiter.isBlocked('client-a'), false);
});
