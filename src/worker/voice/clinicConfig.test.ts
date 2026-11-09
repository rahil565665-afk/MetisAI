import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUSINESS_TEMPLATE_IDS } from '../../shared/businessTemplates.js';
import { normalizeClinicConfig } from './clinicConfig.js';

const base = { id: 'b1f05d7f-923b-4a9c-80bf-1c1b21e2b7c4', name: ' Northside Dental ', business_type: 'dental_clinic' };

test('well-formed business settings are carried over, trimmed, and normalized', () => {
  const config = normalizeClinicConfig({
    ...base,
    timezone: 'America/Chicago',
    receptionist_config: {
      greeting: ' Hello! ', persona_name: ' Alex ', tone: ' Warm and clear ', services: [' Cleanings ', 'Consults'],
      opening_hours: 'Mon–Fri, 9–5', safety_rules: ' Do not diagnose. ', booking_language: ' Call it an appointment. ',
      knowledge_base: 'We open at 8.', faqs: [{ question: 'Parking?', answer: 'Free.' }],
      enabled_actions: { booking: false, take_messages: true, hand_off: false },
      calcom: { event_type_id: 12, event_type_slug: null, username: ' dr-lee ', team_slug: '' },
    },
  });
  assert.equal(config.businessName, 'Northside Dental');
  assert.equal(config.businessType, 'dental');
  assert.equal(config.timezone, 'America/Chicago');
  assert.equal(config.greeting, 'Hello!');
  assert.equal(config.personaName, 'Alex');
  assert.equal(config.tone, 'Warm and clear');
  assert.deepEqual(config.services, ['Cleanings', 'Consults']);
  assert.equal(config.openingHours, 'Mon–Fri, 9–5');
  assert.equal(config.safetyRules, 'Do not diagnose.');
  assert.equal(config.bookingLanguage, 'Call it an appointment.');
  assert.deepEqual(config.enabledActions, { booking: false, take_messages: true, hand_off: false });
  assert.deepEqual(config.faqs, [{ question: 'Parking?', answer: 'Free.' }]);
  assert.deepEqual(config.calcom, { event_type_id: 12, event_type_slug: null, username: 'dr-lee', team_slug: null });
});

test('missing, malformed and oversized settings degrade safely', () => {
  const config = normalizeClinicConfig({
    ...base,
    receptionist_config: {
      greeting: 'x'.repeat(5000), knowledge_base: 42,
      faqs: [{ question: 'ok', answer: '' }, 'junk', ...Array.from({ length: 80 }, (_, index) => ({ question: `q${index}`, answer: 'a' }))],
      calcom: 'nope', services: ['x'.repeat(500)], tone: 'y'.repeat(900), enabled_actions: { booking: 'yes', hand_off: 0 },
    },
  });
  assert.equal(config.timezone, 'UTC');
  assert.equal(config.greeting.length, 800);
  assert.equal(config.knowledge, '');
  assert.equal(config.faqs.length, 48);
  assert.deepEqual(config.calcom, { event_type_id: undefined, event_type_slug: null, username: null, team_slug: null });
  assert.equal(config.services[0].length, 120);
  assert.equal(config.tone.length, 500);
  assert.deepEqual(config.enabledActions, { booking: true, take_messages: true, hand_off: true });
  assert.ok(normalizeClinicConfig({ ...base, receptionist_config: null }).greeting.startsWith('Thank you for calling'));
});

test('text containing control characters is dropped rather than passed to the model', () => {
  const config = normalizeClinicConfig({ ...base, receptionist_config: { greeting: 'hi\u0000there', knowledge_base: 'line one\nline two\ttabbed' } });
  assert.match(config.greeting, /Thank you for calling/);
  assert.equal(config.knowledge, 'line one\nline two\ttabbed');
});

test('knowledge from an uploaded PDF is kept, tidied and cut to the limit', () => {
  const kept = normalizeClinicConfig({ ...base, receptionist_config: { knowledge_base: 'Hours\u0000 8-5\r\n\r\n\r\n\r\nClosed Sundays' } });
  assert.equal(kept.knowledge, 'Hours  8-5\n\nClosed Sundays');
  const long = normalizeClinicConfig({ ...base, receptionist_config: { knowledge_base: 'x'.repeat(100_000) } });
  assert.equal(long.knowledge.length, 60_000);
});

test('all business templates supply safe defaults while legacy dental_clinic remains dental', () => {
  for (const id of BUSINESS_TEMPLATE_IDS) {
    const config = normalizeClinicConfig({ ...base, business_type: id, name: 'Example', receptionist_config: {} });
    assert.equal(config.businessType, id);
    assert.ok(config.greeting.startsWith('Thank you for calling'));
    assert.ok(config.personaName.length > 0);
    assert.ok(config.tone.length > 0);
    assert.ok(config.services.length > 0);
    assert.ok(config.openingHours.length > 0);
    assert.ok(config.safetyRules.length > 0);
    assert.ok(config.bookingLanguage.length > 0);
    assert.ok(config.faqs.length > 0);
    assert.deepEqual(config.enabledActions, { booking: true, take_messages: true, hand_off: true });
  }
  const legacy = normalizeClinicConfig({ ...base, receptionist_config: { transfer_enabled: false } });
  assert.equal(legacy.businessType, 'dental');
  assert.match(legacy.safetyRules, /Do not diagnose/);
  assert.equal(legacy.enabledActions.hand_off, false);
});
