import { CalComClient, CalComError } from '../../worker/voice/calcom.js';
import { GEMINI_LIVE_ORIGIN } from '../../worker/voice/gemini.js';
import { developmentUrl } from '../devOverrides.js';
import type { CalSelector } from './calcomSelector.js';

/**
 * Cheap, read-only checks run when credentials are saved, so a wrong key is reported then and
 * not in the middle of a call. Only a clear rejection blocks saving; any other failure (a network
 * blip, a provider outage) leaves the result "unknown" and the credentials are saved anyway.
 */
export type CheckResult = 'ok' | 'rejected' | 'unknown';

export async function checkGeminiKey(apiKey: string): Promise<CheckResult> {
  const origin = (developmentUrl('GEMINI_LIVE_ORIGIN') ?? GEMINI_LIVE_ORIGIN).replace(/\/+$/, '');
  try {
    const response = await fetch(`${origin}/v1beta/models?pageSize=1`, {
      headers: { 'x-goog-api-key': apiKey },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.ok) return 'ok';
    // A listing request has no other way to fail with these codes than a key Google will not accept.
    if (response.status === 400 || response.status === 401 || response.status === 403) return 'rejected';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export type CalCheckResult = CheckResult | 'not_found';

export async function checkCalCom(selector: CalSelector, apiKey: string): Promise<CalCheckResult> {
  try {
    const client = CalComClient.create(selector, apiKey, { baseUrl: developmentUrl('CALCOM_API_URL') });
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await client.availableSlots(start, new Date(start.getTime() + 24 * 60 * 60 * 1000), 'UTC');
    return 'ok';
  } catch (error) {
    if (error instanceof CalComError) {
      if (/rejected the configured credentials/i.test(error.message)) return 'rejected';
      if (/not found/i.test(error.message)) return 'not_found';
    }
    return 'unknown';
  }
}
