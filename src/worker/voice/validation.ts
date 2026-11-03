/** Input validation for model-supplied tool arguments. The model is untrusted input. */

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function cleanText(value: unknown, label: string, maxLength = 300): string {
  if (typeof value !== 'string') throw new ToolError(`${label} must be text`);
  const result = value.trim();
  // eslint-disable-next-line no-control-regex
  if (!result || result.length > maxLength || /[\u0000-\u001f]/.test(result)) throw new ToolError(`${label} is empty or invalid`);
  return result;
}

export function cleanEmail(value: unknown, label = 'patient_email'): string {
  const email = cleanText(value, label, 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ToolError(`${label} must be a valid email address`);
  return email.toLowerCase();
}

export function cleanBookingUid(value: unknown): string {
  const uid = cleanText(value, 'booking_uid', 128);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new ToolError('booking_uid has an invalid format');
  return uid;
}

const BOOKING_STATUSES = new Set(['accepted', 'pending', 'cancelled', 'rescheduled', 'rejected']);

export function bookingStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return BOOKING_STATUSES.has(status) ? status : 'unknown';
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** Parse an ISO-8601 date-time that carries an explicit offset. Returns an absolute instant. */
export function awareIso(value: unknown, label: string): Date {
  const text = cleanText(value, label, 64);
  if (!ISO_WITH_ZONE.test(text)) throw new ToolError(`${label} must be an ISO-8601 datetime with a timezone`);
  const normalised = text.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) throw new ToolError(`${label} must be an ISO-8601 datetime`);
  return parsed;
}

export function cleanTimeZone(value: unknown): string {
  const name = cleanText(value ?? 'UTC', 'time_zone', 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
  } catch {
    throw new ToolError('time_zone must be a valid IANA timezone');
  }
  return name;
}

/** Cal.com expects UTC instants like 2026-11-05T04:30:00Z. */
export function utcIso(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
