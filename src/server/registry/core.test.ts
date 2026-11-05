import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistryCore, memoryStore } from './core.js';

const input = (slug: string) => ({ slug, name: `Clinic ${slug}`, business_type: 'dental_clinic', timezone: 'UTC', receptionist_config: { greeting: 'Hello' } });

test('clinics are created, listed newest first, and updated without changing their identity', async () => {
  let tick = 0;
  const registry = new RegistryCore(memoryStore(), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
  const first = await registry.createCompany(input('north'));
  const second = await registry.createCompany(input('south'));
  assert.ok(first.ok && second.ok);
  assert.equal(first.company.agent_status, 'not_created');
  assert.equal(first.company.is_active, true);

  assert.deepEqual((await registry.listCompanies()).map((company) => company.slug), ['south', 'north']);

  const updated = await registry.updateCompany(first.company.id, { name: 'North Dental', agent_status: 'live', slug: 'hacked', id: 'other' } as never);
  assert.ok(updated);
  assert.equal(updated.name, 'North Dental');
  assert.equal(updated.agent_status, 'live');
  assert.equal(updated.slug, 'north');
  assert.equal(updated.id, first.company.id);
  assert.equal(updated.created_at, first.company.created_at);
  assert.notEqual(updated.updated_at, first.company.updated_at);

  assert.equal(await registry.updateCompany('missing', { name: 'x' }), null);
  assert.equal(await registry.getCompany('missing'), null);
});

test('a service slug can only be used once, and a chosen id is kept', async () => {
  const registry = new RegistryCore(memoryStore());
  const created = await registry.createCompany({ ...input('north'), id: '11111111-1111-4111-8111-111111111111' });
  assert.ok(created.ok);
  assert.equal(created.company.id, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(await registry.createCompany(input('north')), { ok: false, reason: 'slug_taken' });
});

test('stored copies cannot be changed by mutating a returned object', async () => {
  const registry = new RegistryCore(memoryStore());
  const created = await registry.createCompany(input('north'));
  assert.ok(created.ok);
  created.company.name = 'Changed in memory';
  assert.equal((await registry.getCompany(created.company.id))?.name, 'Clinic north');
});

test('secret records keep their creation time, are replaced on update, and can be deleted', async () => {
  let tick = 0;
  const registry = new RegistryCore(memoryStore(), () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
  assert.equal(await registry.getSecretRecord('a'), null);
  await registry.putSecretRecord('a', { ciphertext: 'one', nonce: 'n1', key_version: 1 });
  const first = await registry.getSecretRecord('a');
  await registry.putSecretRecord('a', { ciphertext: 'two', nonce: 'n2', key_version: 1 });
  const second = await registry.getSecretRecord('a');
  assert.equal(second?.ciphertext, 'two');
  assert.equal(second?.created_at, first?.created_at);
  assert.notEqual(second?.updated_at, first?.updated_at);
  await registry.deleteSecretRecord('a');
  assert.equal(await registry.getSecretRecord('a'), null);
});

test('secrets and clinics do not collide in the same store', async () => {
  const registry = new RegistryCore(memoryStore());
  await registry.putSecretRecord('x', { ciphertext: 'c', nonce: 'n', key_version: 1 });
  assert.deepEqual(await registry.listCompanies(), []);
});
