import { jwtVerify } from 'jose';
import { UUID_PATTERN } from '../server/http.js';

export { UUID_PATTERN };

/** Request authentication helpers for clinic voice routes. Pure functions so they can be unit tested. */

export const TOKEN_PATTERN = /^[A-Za-z0-9._-]{32,4096}$/;
export const TOKEN_MAX_LIFETIME_SECONDS = 180;

export interface VoiceClaims {
  tenantId?: unknown;
  purpose?: unknown;
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

/** Subprotocol the browser offers, and the server selects, on the voice WebSocket. */
export const VOICE_SUBPROTOCOL = 'dentdesk-voice-v1';
const TOKEN_SUBPROTOCOL_PREFIX = 'bearer.';

/**
 * Browsers cannot set an Authorization header on a WebSocket, and a token in the URL would end up in
 * request logs. The voice token therefore travels as a second offered subprotocol: `bearer.<jwt>`.
 */
export function subprotocolToken(request: Request): string | null {
  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((value) => value.trim());
  if (!offered.includes(VOICE_SUBPROTOCOL)) return null;
  const entry = offered.find((value) => value.startsWith(TOKEN_SUBPROTOCOL_PREFIX));
  const token = entry?.slice(TOKEN_SUBPROTOCOL_PREFIX.length) ?? '';
  return TOKEN_PATTERN.test(token) ? token : null;
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
    return claims;
  } catch {
    return null;
  }
}
