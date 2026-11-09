import { utcIso } from './validation.js';

/** Minimal server-side Cal.com API v2 adapter. Never logs or returns provider requests/credentials. */

export class CalComError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalComError';
  }
}

export interface CalComSelector {
  event_type_id?: unknown;
  event_type_slug?: unknown;
  username?: unknown;
  team_slug?: unknown;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const CALCOM_API_ORIGIN = 'https://api.cal.com/v2';
const TIMEOUT_MS = 12_000;

type Query = Record<string, string | number>;

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export class CalComClient {
  private constructor(
    private readonly apiKey: string,
    private readonly eventTypeId: number | null,
    private readonly eventTypeSlug: string | null,
    private readonly username: string | null,
    private readonly teamSlug: string | null,
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher,
  ) {}

  /** Validate a clinic's Cal.com selector and API key. Throws CalComError describing what is missing. */
  static create(selector: CalComSelector | undefined, apiKey: string | undefined, options: { baseUrl?: string; fetcher?: Fetcher } = {}): CalComClient {
    const config = selector ?? {};
    const rawId = config.event_type_id === null || config.event_type_id === undefined ? '' : String(config.event_type_id).trim();
    let eventTypeId: number | null = null;
    if (rawId) {
      eventTypeId = Number(rawId);
      if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(eventTypeId) || eventTypeId < 1) {
        throw new CalComError('Cal.com event type ID must be a positive integer');
      }
    }
    const slug = optionalText(config.event_type_slug);
    const username = optionalText(config.username);
    const teamSlug = optionalText(config.team_slug);
    if (Boolean(eventTypeId) === Boolean(slug)) throw new CalComError('Configure exactly one Cal.com event type ID or slug in the clinic settings');
    if (slug && Boolean(username) === Boolean(teamSlug)) throw new CalComError('A slug event type requires exactly one clinic username or team slug');
    const key = apiKey?.trim();
    if (!key) throw new CalComError('Cal.com scheduling is not configured');
    return new CalComClient(key, eventTypeId, slug, username, teamSlug, (options.baseUrl ?? CALCOM_API_ORIGIN).replace(/\/+$/, ''), options.fetcher ?? ((input, init) => fetch(input, init)));
  }

  private eventQuery(): Query {
    if (this.eventTypeId !== null) return { eventTypeId: this.eventTypeId };
    const query: Query = { eventTypeSlug: this.eventTypeSlug as string };
    if (this.teamSlug) query.teamSlug = this.teamSlug;
    if (this.username) query.username = this.username;
    return query;
  }

  private eventBody(): Record<string, unknown> {
    if (this.eventTypeId !== null) return { eventTypeId: this.eventTypeId };
    return { eventTypeSlug: this.eventTypeSlug, ...(this.teamSlug ? { teamSlug: this.teamSlug } : { username: this.username }) };
  }

  private async request(method: 'GET' | 'POST', path: string, version: string, options: { query?: Query; body?: Record<string, unknown> } = {}): Promise<{ data: unknown }> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.fetcher(url.toString(), {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'cal-api-version': version,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch {
      // Never propagate fetch error text; it can contain request metadata.
      throw new CalComError('Cal.com could not be reached');
    }
    if (response.status >= 400) {
      const detail = await providerDetail(response, this.apiKey);
      if (response.status === 401 || response.status === 403) throw new CalComError('Cal.com rejected the configured credentials or access');
      if (response.status === 404) throw new CalComError('The requested Cal.com record was not found');
      if (response.status === 409) throw new CalComError('The requested appointment slot is no longer available');
      if (response.status === 429) throw new CalComError('Cal.com rate limit reached; try again shortly');
      if (response.status === 400 || response.status === 422) throw new CalComError(detail ? `Cal.com refused the request: ${detail}` : 'Cal.com refused the request');
      throw new CalComError('Cal.com could not complete the scheduling request');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CalComError('Cal.com returned an invalid response');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as { status?: unknown }).status === 'error') {
      throw new CalComError('Cal.com returned an unsuccessful response');
    }
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') throw new CalComError('Cal.com returned an incomplete response');
    return { data };
  }

  /** Available slots only; never returns request credentials or configuration. */
  async availableSlots(start: Date, end: Date, timeZone: string): Promise<unknown> {
    const { data } = await this.request('GET', '/slots', '2024-09-04', {
      query: { ...this.eventQuery(), start: utcIso(start), end: utcIso(end), timeZone, format: 'range' },
    });
    return data;
  }

  async createBooking(input: { name: string; email: string; start: Date; timeZone: string; phone?: string; reason?: string }): Promise<Record<string, unknown>> {
    const { data } = await this.request('POST', '/bookings', '2026-02-25', {
      body: {
        ...this.eventBody(),
        start: utcIso(input.start),
        attendee: {
          name: input.name,
          email: input.email,
          timeZone: input.timeZone,
          language: 'en',
          ...(input.phone ? { phoneNumber: input.phone } : {}),
        },
        // Cal.com stores metadata as short text values; the reason shows up on the booking for the front desk.
        ...(input.reason ? { metadata: { reason: input.reason.slice(0, 200), source: 'metisai-receptionist' } } : { metadata: { source: 'metisai-receptionist' } }),
      },
    });
    return summarize(data);
  }

  private async getBooking(uid: string): Promise<Record<string, unknown>> {
    const { data } = await this.request('GET', `/bookings/${encodeURIComponent(uid)}`, '2026-02-25');
    // A recurring UID resolving to several records is ambiguous: fail closed.
    if (Array.isArray(data)) throw new CalComError('The Cal.com booking identity is ambiguous');
    return data as Record<string, unknown>;
  }

  /** Basic attendee-email match; not a substitute for a clinic-approved identity-verification policy. */
  async requireAttendeeIdentity(uid: string, patientEmail: string): Promise<void> {
    const booking = await this.getBooking(uid);
    const attendees = booking.attendees;
    if (!Array.isArray(attendees) || attendees.length === 0) throw new CalComError('Cal.com did not provide attendee identity; mutation denied');
    const matches = attendees.some((attendee) => {
      const email = attendee && typeof attendee === 'object' ? (attendee as { email?: unknown }).email : undefined;
      return typeof email === 'string' && email.trim().toLowerCase() === patientEmail;
    });
    if (!matches) throw new CalComError('Patient identity does not match this booking; mutation denied');
    if (booking.status !== 'accepted' && booking.status !== 'pending') throw new CalComError('This booking cannot be changed in its current status');
  }

  async rescheduleBooking(uid: string, input: { email: string; newStart: Date }): Promise<Record<string, unknown>> {
    const { data } = await this.request('POST', `/bookings/${encodeURIComponent(uid)}/reschedule`, '2026-02-25', {
      body: {
        start: utcIso(input.newStart),
        rescheduledBy: input.email,
        reschedulingReason: 'Patient requested rescheduling through the dental receptionist',
      },
    });
    return summarize(data);
  }

  async cancelBooking(uid: string, reason: string): Promise<Record<string, unknown>> {
    const { data } = await this.request('POST', `/bookings/${encodeURIComponent(uid)}/cancel`, '2026-02-25', {
      body: { cancellationReason: reason },
    });
    return summarize(data);
  }
}

/** A short, safe sentence from a Cal.com error body, for the receptionist to act on. Never includes credentials. */
async function providerDetail(response: Response, secret: string): Promise<string | null> {
  let text = '';
  try {
    text = (await response.text()).slice(0, 4000);
  } catch {
    return null;
  }
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: { message?: unknown } | string };
    const raw = body.error && typeof body.error === 'object' ? body.error.message : typeof body.error === 'string' ? body.error : body.message;
    const message = Array.isArray(raw) ? raw.filter((item) => typeof item === 'string').join('; ') : raw;
    if (typeof message !== 'string' || !message.trim()) return null;
    return message.split(secret).join('[hidden]').replace(/(cal_(live|test)_|Bearer\s+)\S+/gi, '[hidden]').replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return null;
  }
}

function summarize(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CalComError('Cal.com returned an ambiguous booking result');
  const source = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ['uid', 'status', 'start', 'end']) {
    const value = source[key];
    if (typeof value === 'string' || typeof value === 'number') result[key] = value;
  }
  const eventType = source.eventType;
  if (eventType && typeof eventType === 'object' && typeof (eventType as { title?: unknown }).title === 'string') {
    result.eventType = { title: ((eventType as { title: string }).title).slice(0, 160) };
  }
  if (Object.keys(result).length === 0) throw new CalComError('Cal.com returned an incomplete booking result');
  return result;
}
