import { hkdfSync, randomBytes } from 'node:crypto';
import type { CookieOptions } from 'express';
import { assertTenantProviderSecretEncryptionKey } from './integrations/tenantProviderSecrets.js';

export const PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 3000);
export const SESSION_COOKIE = 'dentdesk_admin_session';

let developmentSessionSecret: Buffer | undefined;

/**
 * Only an explicit local-development run may fall back to a throwaway key. Every other
 * environment (including Cloudflare Workers, where NODE_ENV is normally unset) fails closed,
 * because separate Worker/Durable Object instances would otherwise each invent a different key
 * and silently break sessions and voice tokens.
 */
function sessionSecretBytes(): Buffer {
  const configured = process.env.DASHBOARD_SESSION_SECRET?.trim();
  if (configured) {
    if (/^[0-9a-f]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
    if (Buffer.byteLength(configured) < 32) throw new Error('DASHBOARD_SESSION_SECRET must be 32 bytes or 64 hexadecimal characters.');
    return Buffer.from(configured, 'utf8');
  }
  if (process.env.NODE_ENV !== 'development') throw new Error('DASHBOARD_SESSION_SECRET must be configured outside local development.');
  developmentSessionSecret ??= randomBytes(32);
  return developmentSessionSecret;
}

export function sessionSigningKey(): Uint8Array {
  return sessionSecretBytes();
}

export function voiceTokenSigningKeyHex(tenantId: string): string {
  return Buffer.from(hkdfSync('sha256', sessionSecretBytes(), Buffer.from(`dentdesk-voice:${tenantId}`, 'utf8'), Buffer.from('dentdesk-voice-session-v1'), 32)).toString('hex');
}

export function requestIsSecure(origin?: string | null): boolean {
  return Boolean(origin?.startsWith('https://') || process.env.APP_PUBLIC_URL?.startsWith('https://'));
}

/**
 * The dashboard and its API share one origin, so the session cookie never needs to travel on
 * cross-site requests. SameSite=Lax (with Secure on HTTPS) plus the trusted-Origin check on every
 * mutating request keeps the session out of cross-site contexts.
 */
export function cookieOptions(name = SESSION_COOKIE, secure = requestIsSecure()): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: name === SESSION_COOKIE ? 8 * 60 * 60 * 1000 : 5 * 60 * 1000,
  };
}

export function assertServerConfig(): void {
  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DASHBOARD_ADMIN_PASSCODE', 'APP_PUBLIC_URL']
    .filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing server configuration: ${missing.join(', ')}`);
  const passcode = process.env.DASHBOARD_ADMIN_PASSCODE ?? '';
  if (passcode.length < 8 || passcode.length > 128) throw new Error('DASHBOARD_ADMIN_PASSCODE must be between 8 and 128 characters.');
  const configuredOrigin = process.env.APP_PUBLIC_URL?.trim() ?? '';
  let publicUrl: URL;
  try { publicUrl = new URL(configuredOrigin); } catch { throw new Error('APP_PUBLIC_URL must be an origin such as https://dentdesk.example.com.'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('APP_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  const localOrigin = publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !localOrigin) {
    throw new Error('APP_PUBLIC_URL must use HTTPS outside localhost development.');
  }
  // Validate the stable signing key; only an explicit NODE_ENV=development run gets a throwaway one.
  sessionSecretBytes();
  assertTenantProviderSecretEncryptionKey();
}
