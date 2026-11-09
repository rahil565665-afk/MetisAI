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

/** Domains that are almost always a typing or hearing slip for a common provider. */
const DOMAIN_SLIPS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmaill.com': 'gmail.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com', 'yahooo.com': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.con': 'icloud.com',
};

const EMAIL_HELP = 'ask the caller to spell it slowly, letter by letter, saying "at" and "dot" (for example "j a c o b, at, g mail, dot com")';

/**
 * Turn what was heard into an email address. Speech transcripts often write an address the way it sounds
 * ("jacob at gmail dot com") or drop the "@", so those spoken forms are accepted, and anything that is still
 * not a plausible address is refused with advice the model can act on.
 */
export function normalizeSpokenEmail(raw: string, label = 'patient_email'): string {
  let text = raw.trim().toLowerCase();
  if (!text.includes('@')) text = text.replace(/\s+at\s+/, '@');
  text = text
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+(?:dash|hyphen)\s+/g, '-')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+/g, '');
  const at = text.indexOf('@');
  if (at < 1 || at !== text.lastIndexOf('@')) {
    throw new ToolError(`${label} is not an email address: it has no single "@". Do not guess; ${EMAIL_HELP}.`);
  }
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const goodLocal = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
  const goodDomain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}$/.test(domain);
  if (!goodLocal || !goodDomain || text.length > 254) {
    throw new ToolError(`${label} is not a valid email address. Do not guess; ${EMAIL_HELP}.`);
  }
  const slip = DOMAIN_SLIPS[domain];
  if (slip) throw new ToolError(`${label} ends in "${domain}", which looks like a mistake for "${slip}". Ask the caller to confirm the ending of their address.`);
  return text;
}

export function cleanEmail(value: unknown, label = 'patient_email'): string {
  return normalizeSpokenEmail(cleanText(value, label, 300), label);
}

const SPOKEN_PROVIDERS: Record<string, string> = {
  'gmail.com': 'gmail dot com', 'yahoo.com': 'yahoo dot com', 'outlook.com': 'outlook dot com',
  'hotmail.com': 'hotmail dot com', 'icloud.com': 'i cloud dot com', 'aol.com': 'a o l dot com',
};
const SPOKEN_CHARS: Record<string, string> = { '.': 'dot', '-': 'dash', _: 'underscore', '+': 'plus' };

/** An address written out the way it should be read back to the caller: letters one by one, symbols as words. */
export function spellEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const spell = (part: string) => [...part].map((char) => SPOKEN_CHARS[char] ?? char).join(', ');
  return `${spell(local)}, at, ${SPOKEN_PROVIDERS[domain] ?? spell(domain)}`;
}

export interface CleanPhone {
  /** Digits (and a leading +) as the caller gave them, for display. */
  display: string;
  /** International form for Cal.com, when it can be worked out with confidence. */
  e164: string | null;
  /** Digit by digit, for reading back. */
  spoken: string;
}

/** A phone number from speech: seven to fifteen digits. A bare US number is only completed for US time zones. */
export function cleanPhone(value: unknown, timeZone: string, label = 'patient_phone'): CleanPhone {
  const text = cleanText(value, label, 40);
  const plus = text.trim().startsWith('+');
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new ToolError(`${label} must have 7 to 15 digits. Ask the caller to say the number again, digit by digit.`);
  }
  let e164: string | null = null;
  if (plus) e164 = `+${digits}`;
  else if (timeZone.startsWith('America/') && digits.length === 10) e164 = `+1${digits}`;
  else if (timeZone.startsWith('America/') && digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  const grouped = digits.length === 10 ? [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)] : [digits];
  return { display: plus ? `+${digits}` : digits, e164, spoken: grouped.map((group) => [...group].join(' ')).join(', ') };
}

/** A person's name: at least two letters, no digits or symbols that a name never has. */
export function cleanPersonName(value: unknown, label = 'patient_name'): string {
  const name = cleanText(value, label, 120).replace(/\s+/g, ' ');
  if (!/^[\p{L}][\p{L}\p{M}'’. -]*$/u.test(name) || (name.match(/\p{L}/gu) ?? []).length < 2) {
    throw new ToolError(`${label} must be the caller's real name. Ask for their full name.`);
  }
  return name;
}

const NEGATIVE = /\b(?:no|nope|nah|not|wrong|incorrect|isn'?t|wasn'?t|don'?t|doesn'?t|change|different|actually|wait|hold on|mistake|mispronounced|misspelled)\b/i;
const AFFIRMATIVE = /\b(?:yes|yeah|yep|yup|yea|ya|correct|right|exactly|sure|okay|ok|confirm(?:ed)?|go ahead|sounds good|all good|that'?s (?:it|fine|good)|perfect|please do|do it|book it)\b/i;

/** Whether what the caller said after a read-back is a clear "yes, that is all correct". */
export function callerConfirmed(text: string): boolean {
  return AFFIRMATIVE.test(text) && !NEGATIVE.test(text);
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
