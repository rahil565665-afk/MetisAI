import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError, awareIso, bookingStatus, cleanBookingUid, cleanEmail, cleanText, cleanTimeZone, utcIso } from './validation.js';

test('cleanText trims and rejects empty, long, non-string and control characters', () => {
  assert.equal(cleanText('  Ada  ', 'name', 10), 'Ada');
  for (const bad of ['', '   ', 'x'.repeat(11), 'a\nb', 'a\u0000b', 5, null, undefined]) {
    assert.throws(() => cleanText(bad, 'name', 10), ToolError);
  }
});

test('cleanEmail lowercases and requires a plausible address', () => {
  assert.equal(cleanEmail(' Ada@Example.COM '), 'ada@example.com');
  for (const bad of ['ada', 'ada@', '@example.com', 'a b@example.com', 'ada@example']) assert.throws(() => cleanEmail(bad), ToolError);
});

test('cleanBookingUid accepts Cal.com style ids only', () => {
  assert.equal(cleanBookingUid('abc123_-XYZ'), 'abc123_-XYZ');
  for (const bad of ['short', 'has space1', '../../etc/passwd', 'a'.repeat(129), 'uid?x=1']) assert.throws(() => cleanBookingUid(bad), ToolError);
});

test('bookingStatus maps unknown values to "unknown"', () => {
  assert.equal(bookingStatus('Accepted'), 'accepted');
  assert.equal(bookingStatus('exploded'), 'unknown');
  assert.equal(bookingStatus(undefined), 'unknown');
});

test('awareIso requires an explicit offset and returns the absolute instant', () => {
  assert.equal(awareIso('2026-11-05T10:00:00+05:30', 'start').toISOString(), '2026-11-05T04:30:00.000Z');
  assert.equal(awareIso('2026-11-05T10:00:00Z', 'start').toISOString(), '2026-11-05T10:00:00.000Z');
  assert.equal(awareIso('2026-11-05 10:00:00-0800', 'start').toISOString(), '2026-11-05T18:00:00.000Z');
  for (const bad of ['2026-11-05T10:00:00', '2026-11-05', 'tomorrow', '2026-13-45T10:00:00Z', 7]) assert.throws(() => awareIso(bad, 'start'), ToolError);
});

test('cleanTimeZone checks the IANA database and defaults to UTC', () => {
  assert.equal(cleanTimeZone('America/Chicago'), 'America/Chicago');
  assert.equal(cleanTimeZone(undefined), 'UTC');
  assert.throws(() => cleanTimeZone('Mars/Olympus'), ToolError);
});

test('utcIso drops milliseconds but keeps the Z', () => {
  assert.equal(utcIso(new Date('2026-11-05T04:30:00.000Z')), '2026-11-05T04:30:00Z');
  assert.equal(utcIso(new Date('2026-11-05T04:30:00.250Z')), '2026-11-05T04:30:00.250Z');
});
