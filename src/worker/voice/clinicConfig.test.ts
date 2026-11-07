import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeClinicConfig } from './clinicConfig.js';

const base = { id: 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4', name: ' Northside Dental ' };

test('well-formed settings are carried over and trimmed', () => {
  const config = normalizeClinicConfig({
    ...base,
    timezone: 'America/Chicago',
    receptionist_config: {
      greeting: ' Hello! ',
      knowledge_base: 'We open at 8.',
      faqs: [{ question: 'Walk-ins?', answer: 'Book ahead.' }],
      calcom: { event_type_id: 12, event_type_slug: null, username: ' dr-lee ', team_slug: '' },
    },
  });
  assert.equal(config.clinicName, 'Northside Dental');
  assert.equal(config.timezone, 'America/Chicago');
  assert.equal(config.greeting, 'Hello!');
  assert.deepEqual(config.faqs, [{ question: 'Walk-ins?', answer: 'Book ahead.' }]);
  assert.deepEqual(config.calcom, { event_type_id: 12, event_type_slug: null, username: 'dr-lee', team_slug: null });
});

test('missing, malformed and oversized settings degrade safely', () => {
  const config = normalizeClinicConfig({
    ...base,
    receptionist_config: {
      greeting: 'x'.repeat(5000),
      knowledge_base: 42,
      // Only the first 50 entries are considered; two of those are invalid, so 48 survive.
      faqs: [{ question: 'ok', answer: '' }, 'junk', ...Array.from({ length: 80 }, (_, index) => ({ question: `q${index}`, answer: 'a' }))],
      calcom: 'nope',
    },
  });
  assert.equal(config.timezone, 'UTC');
  assert.equal(config.greeting.length, 800);
  assert.equal(config.knowledge, '');
  assert.equal(config.faqs.length, 48);
  assert.deepEqual(config.calcom, { event_type_id: undefined, event_type_slug: null, username: null, team_slug: null });
  assert.equal(normalizeClinicConfig({ ...base, receptionist_config: null }).greeting, '');
});

test('text containing control characters is dropped rather than passed to the model', () => {
  const config = normalizeClinicConfig({ ...base, receptionist_config: { greeting: 'hi\u0000there', knowledge_base: 'line one\nline two\ttabbed' } });
  assert.equal(config.greeting, '');
  assert.equal(config.knowledge, 'line one\nline two\ttabbed');
});

test('knowledge from an uploaded PDF is kept, tidied and cut to the limit', () => {
  const kept = normalizeClinicConfig({ ...base, receptionist_config: { knowledge_base: 'Hours\u0000 8-5\r\n\r\n\r\n\r\nClosed Sundays' } });
  assert.equal(kept.knowledge, 'Hours  8-5\n\nClosed Sundays');
  const long = normalizeClinicConfig({ ...base, receptionist_config: { knowledge_base: 'x'.repeat(100_000) } });
  assert.equal(long.knowledge.length, 60_000);
});
