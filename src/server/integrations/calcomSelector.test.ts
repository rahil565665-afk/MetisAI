import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../http.js';
import { parseCalSelector, selectorIsComplete } from './calcomSelector.js';

const fails = (input: Parameters<typeof parseCalSelector>[0], pattern: RegExp) =>
  assert.throws(() => parseCalSelector(input), (error: unknown) => error instanceof HttpError && error.status === 400 && pattern.test(error.message));

test('an event type ID wins and the other fields are ignored with a note, not an error', () => {
  const parsed = parseCalSelector({ eventTypeId: 7768457, eventTypeSlug: 'https://cal.com/rahil-fjf4vl', username: 'rahil-fjf4vl', teamSlug: 'https://cal.com/rahil-fjf4vl' });
  assert.deepEqual(parsed?.selector, { event_type_id: 7768457, event_type_slug: null, username: null, team_slug: null });
  assert.match(parsed?.note ?? '', /ignored/);
  assert.equal(parseCalSelector({ eventTypeId: 12 })?.note, undefined);
});

test('a pasted event link supplies the username and slug', () => {
  assert.deepEqual(parseCalSelector({ eventLink: 'https://cal.com/rahil-fjf4vl/30min' })?.selector, { event_type_id: null, event_type_slug: '30min', username: 'rahil-fjf4vl', team_slug: null });
  assert.deepEqual(parseCalSelector({ eventLink: 'cal.com/rahil/new-patient?date=2026-11-10' })?.selector, { event_type_id: null, event_type_slug: 'new-patient', username: 'rahil', team_slug: null });
});

test('a team link supplies the team slug', () => {
  assert.deepEqual(parseCalSelector({ eventLink: 'https://cal.com/team/north-dental/checkup' })?.selector, { event_type_id: null, event_type_slug: 'checkup', username: null, team_slug: 'north-dental' });
});

test('separate fields still work, and may hold pasted links', () => {
  assert.deepEqual(parseCalSelector({ eventTypeSlug: '30min', username: 'rahil' })?.selector, { event_type_id: null, event_type_slug: '30min', username: 'rahil', team_slug: null });
  assert.deepEqual(parseCalSelector({ eventTypeSlug: '30min', teamSlug: 'north' })?.selector.team_slug, 'north');
  assert.deepEqual(parseCalSelector({ eventTypeSlug: 'https://cal.com/rahil/30min' })?.selector.username, 'rahil');
});

test('nothing supplied means no change', () => {
  assert.equal(parseCalSelector({}), null);
  assert.equal(parseCalSelector({ eventTypeId: null, eventLink: '  ' }), null);
});

test('problems are explained in plain words', () => {
  fails({ eventLink: 'https://cal.com/rahil-fjf4vl' }, /does not name an event type/);
  fails({ eventTypeSlug: '30min' }, /username or a team slug/);
  fails({ eventTypeSlug: '30min', username: 'a', teamSlug: 'b' }, /not both/);
  fails({ eventTypeId: -4 }, /positive whole number/);
  fails({ eventTypeSlug: 'bad slug!', username: 'rahil' }, /not valid/);
  fails({ eventLink: 'https://' }, /could not be read/);
});

test('a selector is complete with an ID, or a slug plus an owner', () => {
  assert.equal(selectorIsComplete({ event_type_id: 5 }), true);
  assert.equal(selectorIsComplete({ event_type_slug: 'x', username: 'u' }), true);
  assert.equal(selectorIsComplete({ event_type_slug: 'x' }), false);
  assert.equal(selectorIsComplete(undefined), false);
  assert.equal(selectorIsComplete({ event_type_id: null, event_type_slug: null }), false);
});
