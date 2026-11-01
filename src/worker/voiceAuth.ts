import { jwtVerify } from 'jose';
import { UUID_PATTERN } from '../server/http.js';
import type { TenantProviderSecrets } from '../server/integrations/tenantProviderSecrets.js';

export { UUID_PATTERN };

/** Request authentication helpers for clinic voice routes. Pure functions so they can be unit tested. */

export const TOKEN_PATTERN = /^[A-Za-z0-9._-]{32,4096}$/;
export const TOKEN_MAX_LIFETIME_SECONDS = 180;
export const AGENT_PORT = 10000;

export interface VoiceClaims {
  tenantId?: unknown;
  purpose?: unknown;
  voiceOutputMode?: unknown;
  iat?: unknown;
  exp?: unknown;
}

export function canonicalOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Browsers always send Origin on WebSocket upgrades, so those requests must carry it. Same-origin
 * GET fetches may omit it; then the request URL's own origin must match.
 */
export function validOrigin(request: Request, expectedOrigin: string, requireHeader: boolean): boolean {
  const expected = canonicalOrigin(expectedOrigin);
  if (!expected) return false;
  const supplied = request.headers.get('origin');
  if (requireHeader && !supplied) return false;
  if (supplied) return canonicalOrigin(supplied) === expected && supplied === canonicalOrigin(supplied);
  return request.method === 'GET' && canonicalOrigin(new URL(request.url).origin) === expected;
}

export function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9._-]{32,4096})$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

export async function verifyVoiceToken(token: string | null, tenantId: string, signingSecretHex: string): Promise<VoiceClaims | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(signingSecretHex), {
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'tenantId', 'purpose'],
      clockTolerance: 5,
    });
    const claims = payload as VoiceClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.tenantId !== tenantId || claims.purpose !== 'voice') return null;
    if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
    if (claims.iat > now + 5 || claims.exp <= now || claims.exp - claims.iat > TOKEN_MAX_LIFETIME_SECONDS) return null;
    if (claims.voiceOutputMode !== 'native' && claims.voiceOutputMode !== 'cartesia') return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Environment handed to one clinic's Container. It receives only that clinic's own provider keys
 * and a tenant-scoped signing key; the central Supabase secret and Twilio values never go in.
 */
export function agentEnv(
  tenantId: string,
  signingSecretHex: string,
  dashboardOrigin: string,
  voiceOutputMode: 'native' | 'cartesia',
  secrets: TenantProviderSecrets,
): Record<string, string> {
  const env: Record<string, string> = {
    TENANT_ID: tenantId,
    VOICE_TOKEN_SIGNING_SECRET: signingSecretHex,
    DASHBOARD_ORIGIN: dashboardOrigin,
    VOICE_OUTPUT_MODE: voiceOutputMode,
    PORT: String(AGENT_PORT),
    TWILIO_ENABLED: 'false',
    GEMINI_API_KEY: secrets.geminiApiKey ?? '',
  };
  if (secrets.cartesiaApiKey?.trim()) env.CARTESIA_API_KEY = secrets.cartesiaApiKey;
  if (secrets.calcomApiKey?.trim()) env.CALCOM_API_KEY = secrets.calcomApiKey;
  return env;
}
