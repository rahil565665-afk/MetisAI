import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { cookieOptions, sessionSigningKey, SESSION_COOKIE } from '../config.js';
import { HttpError } from '../http.js';
import type { AppUser } from '../types.js';
import { MemoryLoginRateLimiter, type LoginRateLimiter } from './loginRateLimit.js';

const ADMIN_USER: AppUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'admin@dentdesk.local',
  display_name: 'Workspace administrator',
  is_platform_admin: true,
  is_active: true,
};

let limiter: LoginRateLimiter = new MemoryLoginRateLimiter();

/** The Worker installs a Durable Object limiter so attempts are counted across all instances. */
export function configureLoginRateLimiter(next: LoginRateLimiter): void {
  limiter = next;
}

function configuredOrigin(): string | null {
  const raw = process.env.APP_PUBLIC_URL;
  if (!raw) return null;
  try { return new URL(raw).origin; } catch { throw new HttpError(503, 'The dashboard public origin is not configured correctly.'); }
}

export function assertTrustedOrigin(req: Request): void {
  const raw = req.get('origin');
  if (!raw) throw new HttpError(403, 'A trusted browser origin is required.');
  let origin: URL;
  try { origin = new URL(raw); } catch { throw new HttpError(403, 'The browser origin is invalid.'); }
  const configured = configuredOrigin();
  if (configured) {
    if (origin.origin !== configured) throw new HttpError(403, 'The request origin is not allowed.');
    return;
  }
  if (origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)) return;
  throw new HttpError(403, 'Set APP_PUBLIC_URL to the dashboard HTTPS origin before using this action.');
}

function secureRequest(req: Request): boolean {
  return Boolean(req.get('origin')?.startsWith('https://') || process.env.APP_PUBLIC_URL?.startsWith('https://'));
}

/** Compare digests so neither the content nor the length of the passcode leaks through timing. */
function passcodesMatch(candidate: string, expected: string): boolean {
  if (candidate.length === 0 || expected.length === 0) return false;
  const left = createHash('sha256').update(candidate, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Cloudflare overwrites CF-Connecting-IP on every request, so it cannot be spoofed in production.
 * Local development has no such header and falls back to the socket address.
 */
function rateLimitKey(req: Request): string {
  const ip = req.get('cf-connecting-ip') || req.ip || req.socket.remoteAddress || 'unknown';
  return createHash('sha256').update(ip).digest('hex');
}

async function assertNotRateLimited(key: string): Promise<void> {
  let blocked: boolean;
  try { blocked = await limiter.isBlocked(key); } catch { throw new HttpError(503, 'Sign-in is temporarily unavailable. Try again shortly.'); }
  if (blocked) throw new HttpError(429, 'Too many login attempts. Wait a while, then try again.');
}

export async function login(req: Request, res: Response): Promise<void> {
  assertTrustedOrigin(req);
  const key = rateLimitKey(req);
  await assertNotRateLimited(key);
  const expected = process.env.DASHBOARD_ADMIN_PASSCODE;
  if (!expected || expected.length < 8) throw new HttpError(503, 'Dashboard passcode authentication is not configured.');
  const candidate = typeof req.body?.passcode === 'string' ? req.body.passcode.slice(0, 128) : '';
  if (!passcodesMatch(candidate, expected)) {
    await limiter.recordFailure(key).catch(() => undefined);
    throw new HttpError(401, 'The passcode was not accepted.');
  }
  await limiter.clear(key).catch(() => undefined);
  const token = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('dashboard-admin')
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(sessionSigningKey());
  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_COOKIE, secureRequest(req)));
  res.json({ ok: true });
}

export function logout(req: Request, res: Response): void {
  assertTrustedOrigin(req);
  res.clearCookie(SESSION_COOKIE, cookieOptions(SESSION_COOKIE, secureRequest(req)));
  res.json({ ok: true });
}

export async function userFromSessionToken(token: string): Promise<AppUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSigningKey(), { algorithms: ['HS256'], requiredClaims: ['exp', 'iat', 'sub'] });
    if (payload.sub !== 'dashboard-admin' || payload.role !== 'admin') return null;
    return ADMIN_USER;
  } catch { return null; }
}

export function sessionMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE] ?? '';
  void userFromSessionToken(token).then((user) => {
    req.user = user;
    next();
  }).catch(() => {
    req.user = null;
    next();
  });
}
