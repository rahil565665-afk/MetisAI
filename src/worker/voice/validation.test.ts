import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolError, awareIso, bookingStatus, callerConfirmed, cleanBookingUid, cleanEmail, cleanPersonName, cleanPhone, cleanText, cleanTimeZone, localDateRange, spellEmail, utcIso } from './validation.js';

test('cleanText trims and rejects empty, long, non-string and control characters', () => {
  assert.equal(cleanText('  Ada  ', 'name', 10), 'Ada');
  for (const bad of ['', '   ', 'x'.repeat(11), 'a\nb', 'a\u0000b', 5, null, undefined]) {
    assert.throws(() => cleanText(bad, 'name', 10), ToolError);
  }
});

test('cleanEmail lowercases and requires a plausible address', () => {
  assert.equal(cleanEmail(' Ada@Example.COM '), 'ada@example.com');
  for (const bad of ['ada', 'ada@', '@example.com', 'ada@example', 'Ahorita.gmail.com', 'ada..lovelace@example.com', '.ada@example.com', 'ada@@example.com', 'ada@exam_ple.com']) {
    assert.throws(() => cleanEmail(bad), ToolError, bad);
  }
});

test('cleanEmail understands an address as it is spoken or spelled out', () => {
  assert.equal(cleanEmail('jacob at gmail dot com'), 'jacob@gmail.com');
  assert.equal(cleanEmail('Jacob Kennedy at Gmail dot com'), 'jacobkennedy@gmail.com');
  assert.equal(cleanEmail('j a c o b at g mail dot com'), 'jacob@gmail.com');
  assert.equal(cleanEmail('jacob dot kennedy underscore 20 at example dot co dot uk'), 'jacob.kennedy_20@example.co.uk');
  assert.equal(cleanEmail('ada dash lovelace@example.com'), 'ada-lovelace@example.com');
});

test('an address with no @ is refused with advice to have it spelled, not guessed', () => {
  assert.throws(() => cleanEmail('Ahorita.gmail.com'), (error: unknown) => error instanceof ToolError && /no single "@"/.test(error.message) && /spell/.test(error.message));
});

test('a domain that is almost certainly a slip for a common provider is questioned', () => {
  for (const slip of ['jacob@gmial.com', 'jacob@gmail.con', 'jacob@yahooo.com']) {
    assert.throws(() => cleanEmail(slip), (error: unknown) => error instanceof ToolError && /looks like a mistake/.test(error.message), slip);
  }
});

test('spellEmail reads an address back letter by letter, with common providers as words', () => {
  assert.equal(spellEmail('jacob.k_2@gmail.com'), 'j, a, c, o, b, dot, k, underscore, 2, at, gmail dot com');
  assert.equal(spellEmail('ada@clinic.example'), 'a, d, a, at, c, l, i, n, i, c, dot, e, x, a, m, p, l, e');
});

test('cleanPhone needs 7 to 15 digits and only completes a bare US number for US time zones', () => {
  assert.deepEqual(cleanPhone('(555) 123-4567', 'America/Chicago'), { display: '5551234567', e164: '+15551234567', spoken: '5 5 5, 1 2 3, 4 5 6 7' });
  assert.equal(cleanPhone('1 555 123 4567', 'America/New_York').e164, '+15551234567');
  assert.equal(cleanPhone('+44 20 7946 0958', 'Europe/London').e164, '+442079460958');
  assert.equal(cleanPhone('5551234567', 'Europe/London').e164, null);
  for (const bad of ['12345', 'call me', '1'.repeat(16)]) assert.throws(() => cleanPhone(bad, 'UTC'), ToolError, bad);
});

test('cleanPersonName wants a real name', () => {
  assert.equal(cleanPersonName('  Jacob   Kennedy '), 'Jacob Kennedy');
  assert.equal(cleanPersonName("Siobhán O'Neil-Smith Jr."), "Siobhán O'Neil-Smith Jr.");
  for (const bad of ['J', '12345', 'a@b.com', '   ', 'DROP TABLE;']) assert.throws(() => cleanPersonName(bad), ToolError, bad);
});

test('callerConfirmed needs a clear yes and no hint of a correction', () => {
  for (const yes of ['Yes', 'yeah that is correct', 'Yes, go ahead', 'right', 'Sounds good', 'ok']) assert.equal(callerConfirmed(yes), true, yes);
  for (const no of ['', 'No', 'no that is wrong', 'yes but actually the email is different', 'hmm', 'wait', 'the name is spelled differently']) assert.equal(callerConfirmed(no), false, no);
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

test('local calendar dates convert to full business days across DST changes', () => {
  const fallBack = localDateRange('2026-11-01', '2026-11-01', 'America/Los_Angeles');
  assert.equal(fallBack.start.toISOString(), '2026-11-01T07:00:00.000Z');
  assert.equal(fallBack.end.toISOString(), '2026-11-02T08:00:00.000Z');
  const springForward = localDateRange('2026-03-08', '2026-03-08', 'America/Los_Angeles');
  assert.equal(springForward.start.toISOString(), '2026-03-08T08:00:00.000Z');
  assert.equal(springForward.end.toISOString(), '2026-03-09T07:00:00.000Z');
});

test('local date ranges reject invalid dates, reversed windows, and more than 14 days', () => {
  for (const [start, end] of [['2026-02-30', undefined], ['2026-11-02', '2026-11-01'], ['2026-11-01', '2026-11-15']]) {
    assert.throws(() => localDateRange(start, end, 'UTC'), ToolError);
  }
});

test('utcIso drops milliseconds but keeps the Z', () => {
  assert.equal(utcIso(new Date('2026-11-05T04:30:00.000Z')), '2026-11-05T04:30:00Z');
  assert.equal(utcIso(new Date('2026-11-05T04:30:00.250Z')), '2026-11-05T04:30:00.250Z');
});
