import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalGate } from './approval.js';

function gate(timeoutMs = 1000) {
  const events: string[] = [];
  let n = 0;
  const instance = new ApprovalGate({
    request: (id, operation, summary, expires) => events.push(`request:${id}:${operation}:${JSON.stringify(summary)}:${expires}`),
    closed: (id) => events.push(`closed:${id}`),
  }, timeoutMs, () => `id${++n}`);
  return { instance, events };
}

test('an explicit approval resolves true and closes the prompt', async () => {
  const { instance, events } = gate();
  const result = instance.request('create_booking', { start: 'x' });
  assert.equal(instance.answer('id1', true), true);
  assert.equal(await result, true);
  assert.deepEqual(events, ['request:id1:create_booking:{"start":"x"}:1', 'closed:id1']);
  assert.equal(instance.size, 0);
});

test('a refusal resolves false', async () => {
  const { instance } = gate();
  const result = instance.request('cancel_booking', {});
  instance.answer('id1', false);
  assert.equal(await result, false);
});

test('silence fails closed', async () => {
  const { instance, events } = gate(20);
  assert.equal(await instance.request('reschedule_booking', {}), false);
  assert.ok(events.includes('closed:id1'));
});

test('denyAll rejects every pending request', async () => {
  const { instance } = gate();
  const first = instance.request('create_booking', {});
  const second = instance.request('cancel_booking', {});
  instance.denyAll();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(instance.size, 0);
});

test('unknown, repeated and malformed answers are ignored', async () => {
  const { instance } = gate();
  const result = instance.request('create_booking', {});
  assert.equal(instance.answer('nope', true), false);
  assert.equal(instance.answer('id1', 'true'), false);
  assert.equal(instance.answer(undefined, true), false);
  assert.equal(instance.size, 1);
  assert.equal(instance.answer('id1', true), true);
  assert.equal(instance.answer('id1', false), false, 'a second answer must not flip the outcome');
  assert.equal(await result, true);
});
