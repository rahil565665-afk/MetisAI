import { HttpError } from '../http.js';

/** The Cal.com event a clinic books into, as stored in the clinic's settings. */
export interface CalSelector {
  event_type_id: number | null;
  event_type_slug: string | null;
  username: string | null;
  team_slug: string | null;
}

export interface CalSelectorInput {
  eventTypeId?: number | null;
  /** A pasted Cal.com link such as https://cal.com/yourname/30min or https://cal.com/team/yourteam/30min. */
  eventLink?: string;
  /** Older, separate fields. Each may also contain a pasted link. */
  eventTypeSlug?: string;
  username?: string;
  teamSlug?: string;
}

export interface ParsedCalSelector {
  selector: CalSelector;
  /** Something worth telling the administrator, such as fields that were ignored. */
  note?: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const LINK_HELP = 'Use a link like https://cal.com/yourname/30min (or https://cal.com/team/yourteam/30min for a team), or enter the event type ID instead.';

interface LinkParts { username?: string; team?: string; slug?: string }

function looksLikeLink(value: string): boolean {
  return /^https?:\/\//i.test(value) || /(^|\.)cal\.com\//i.test(value) || value.includes('/');
}

function partsFromLink(text: string): LinkParts {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new HttpError(400, `That Cal.com link could not be read. ${LINK_HELP}`);
  }
  const segments = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (segments[0]?.toLowerCase() === 'team') return { team: segments[1], slug: segments[2] };
  return { username: segments[0], slug: segments[1] };
}

function checkName(value: string, label: string): string {
  if (!NAME.test(value)) throw new HttpError(400, `The Cal.com ${label} “${value.slice(0, 60)}” is not valid. Use only letters, numbers, dots, dashes and underscores.`);
  return value;
}

/**
 * Work out which Cal.com event a clinic books into. A numeric event type ID always wins and makes the
 * other fields unnecessary; otherwise an event link (or slug plus username or team) is needed.
 * Returns null when nothing about the event was supplied, so partial updates leave the old value alone.
 */
export function parseCalSelector(input: CalSelectorInput): ParsedCalSelector | null {
  const link = input.eventLink?.trim() ?? '';
  const slugField = input.eventTypeSlug?.trim() ?? '';
  const usernameField = input.username?.trim() ?? '';
  const teamField = input.teamSlug?.trim() ?? '';
  const hasId = typeof input.eventTypeId === 'number';
  const others = [link, slugField, usernameField, teamField].filter(Boolean);

  if (hasId) {
    const id = input.eventTypeId as number;
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'The Cal.com event type ID must be a positive whole number, like 7768457.');
    return {
      selector: { event_type_id: id, event_type_slug: null, username: null, team_slug: null },
      ...(others.length ? { note: `Using event type ID ${id}. The link, slug, username and team fields were not needed and were ignored.` } : {}),
    };
  }
  if (!others.length) return null;

  const found: LinkParts = {};
  for (const [value, role] of [[link, 'link'], [slugField, 'slug'], [usernameField, 'username'], [teamField, 'team']] as const) {
    if (!value) continue;
    if (looksLikeLink(value)) {
      const parts = partsFromLink(value);
      found.username ||= parts.username;
      found.team ||= parts.team;
      found.slug ||= parts.slug;
    } else if (role === 'slug') found.slug ||= value;
    else if (role === 'username') found.username ||= value;
    else if (role === 'team') found.team ||= value;
    else throw new HttpError(400, `That does not look like a Cal.com link. ${LINK_HELP}`);
  }

  if (!found.slug) throw new HttpError(400, `That Cal.com link does not name an event type. ${LINK_HELP}`);
  if (found.username && found.team) throw new HttpError(400, 'Enter either a Cal.com username or a team slug, not both.');
  if (!found.username && !found.team) throw new HttpError(400, `Cal.com also needs the owner’s username or a team slug. ${LINK_HELP}`);
  return {
    selector: {
      event_type_id: null,
      event_type_slug: checkName(found.slug, 'event slug'),
      username: found.username ? checkName(found.username, 'username') : null,
      team_slug: found.team ? checkName(found.team, 'team slug') : null,
    },
  };
}

export function selectorIsComplete(selector: Partial<Record<keyof CalSelector, unknown>> | undefined): boolean {
  if (!selector) return false;
  if (typeof selector.event_type_id === 'number' && selector.event_type_id > 0) return true;
  return Boolean(selector.event_type_slug && (selector.username || selector.team_slug));
}
