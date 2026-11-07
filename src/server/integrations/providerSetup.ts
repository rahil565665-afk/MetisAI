import { HttpError } from '../http.js';
import type { IntegrationState } from '../types.js';
import { parseCalSelector, selectorIsComplete, type CalSelector, type CalSelectorInput } from './calcomSelector.js';
import { checkClinicDatabase, cleanSupabaseKey, connectClinicDatabase, normalizeSupabaseUrl } from './clinicDatabase.js';
import { checkCalCom, checkGeminiKey } from './providerChecks.js';
import type { ProviderSecretUpdate } from './tenantProviderSecrets.js';

/**
 * Saving a provider's credentials. The rule throughout: save what the administrator entered, check it,
 * and report what is wrong. A failed check never stops the save and never stops a clinic being created;
 * it is recorded as a `problem` on that provider so the dashboard shows what to fix. The only input that
 * is not saved is input that cannot be stored safely at all (a URL that is not a Supabase project, a
 * value that is not a key); that throws an HttpError whose message says what to enter.
 */

export const GEMINI_REJECTED = 'Google rejected that Gemini API key, so voice calls will not work until it is replaced. Create a key in Google AI Studio and paste all of it.';
export const CALCOM_REJECTED = 'Cal.com rejected that API key, so scheduling will not work until it is replaced. Create a new API key in Cal.com (Settings → Developer → API keys).';
export const CALCOM_NOT_FOUND = 'Cal.com could not find that event. Check the event type ID (the number in the event’s address in Cal.com) or the link.';

export interface ProviderResult {
  secrets: ProviderSecretUpdate;
  status: IntegrationState;
  /** What to tell the administrator about a saved-but-not-working connection. */
  warning?: string;
  /** What to tell the administrator after a normal save. */
  message: string;
  /** The Cal.com event to keep in the clinic's settings, when one was given. */
  calendar?: CalSelector;
}

const SAVED = 'Saved. Secret values are not shown again. Changes apply the next time you start a voice test.';
const savedButBroken = (problem: string) => `Saved, but it is not working yet. ${problem}`;

export async function setupGemini(apiKey: string): Promise<ProviderResult> {
  const key = apiKey.trim();
  if (!key) throw new HttpError(400, 'Enter a Gemini API key.');
  const updatedAt = new Date().toISOString();
  const rejected = await checkGeminiKey(key) === 'rejected';
  return {
    secrets: { geminiApiKey: key },
    status: rejected ? { configured: false, updatedAt, note: 'Stored encrypted', problem: GEMINI_REJECTED } : { configured: true, updatedAt, note: 'Stored encrypted' },
    ...(rejected ? { warning: GEMINI_REJECTED } : {}),
    message: rejected ? savedButBroken(GEMINI_REJECTED) : SAVED,
  };
}

export async function setupDatabase(tenantId: string, urlInput: string, keyInput: string): Promise<ProviderResult> {
  const url = normalizeSupabaseUrl(urlInput);
  const key = cleanSupabaseKey(keyInput);
  const updatedAt = new Date().toISOString();
  let problem = '';
  try {
    await checkClinicDatabase(connectClinicDatabase(url, key), tenantId);
  } catch (error) {
    problem = error instanceof HttpError ? error.message : 'Could not check this database right now. Try saving it again in a moment.';
  }
  const note = 'Stored encrypted; call history is written to the clinic’s own project';
  return {
    secrets: { supabaseUrl: url, supabaseSecretKey: key },
    status: problem ? { configured: false, updatedAt, note, problem } : { configured: true, updatedAt, note },
    ...(problem ? { warning: problem } : {}),
    message: problem ? savedButBroken(problem) : 'Connected. Call history and appointments will now be saved to this Supabase project.',
  };
}

export interface CalendarInput extends CalSelectorInput {
  apiKey?: string;
}

/** Event type IDs arrive as numbers or as whatever was typed; anything that is not a whole number is explained. */
export function parseEventTypeId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,12}$/.test(text)) throw new HttpError(400, 'The Cal.com event type ID is the number at the end of the event’s address in Cal.com, like 7768457. Leave it empty if you pasted the event link instead.');
  return Number(text);
}

export async function setupCalendar(input: CalendarInput, stored: { apiKey?: string; selector?: Partial<CalSelector> }): Promise<ProviderResult> {
  const parsed = parseCalSelector(input);
  const newKey = input.apiKey?.trim() ?? '';
  if (!newKey && !parsed) throw new HttpError(400, 'Enter a Cal.com API key, an event type ID, or an event link.');
  const apiKey = newKey || stored.apiKey || '';
  const selector = parsed?.selector ?? (stored.selector as CalSelector | undefined);
  const complete = selectorIsComplete(selector);
  const updatedAt = new Date().toISOString();

  let problem = '';
  let unreachable = false;
  if (apiKey && complete && selector) {
    const result = await checkCalCom(selector, apiKey);
    if (result === 'rejected') problem = CALCOM_REJECTED;
    else if (result === 'not_found') problem = CALCOM_NOT_FOUND;
    else if (result === 'unknown') unreachable = true;
  }
  const missing = !apiKey ? 'Add the API key' : !complete ? 'Add the event type ID or an event link' : '';
  let message = SAVED;
  if (problem) message = savedButBroken(problem);
  else if (missing) message = `Saved. ${missing} to turn scheduling on.`;
  else if (unreachable) message = 'Saved, but Cal.com could not be reached to confirm it just now. Try a voice test to check.';
  if (parsed?.note) message = `${message} ${parsed.note}`;

  const note = 'API key stored encrypted; event is clinic configuration';
  return {
    secrets: newKey ? { calcomApiKey: newKey } : {},
    status: problem ? { configured: false, updatedAt, note, problem } : { configured: Boolean(apiKey) && complete, updatedAt, note },
    ...(problem ? { warning: problem } : {}),
    message,
    ...(parsed ? { calendar: parsed.selector } : {}),
  };
}
