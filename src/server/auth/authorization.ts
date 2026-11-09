import type { Request } from 'express';
import type { AppUser } from '../types.js';
import { HttpError } from '../http.js';

export async function requireUser(req: Request): Promise<AppUser> {
  const user = req.user;
  if (!user?.is_active) throw new HttpError(401, 'Sign in to continue.');
  return user;
}

export async function requirePlatformAdmin(req: Request): Promise<AppUser> {
  const user = await requireUser(req);
  if (!user.is_platform_admin) throw new HttpError(403, 'Administrator access is required.');
  return user;
}

/**
 * The console has a single administrator who manages every business. Per-business roles are not part of
 * this release, so anything other than the administrator is refused.
 */
export async function requireTenantRole(req: Request, _tenantId: string, _roles?: string[]): Promise<{ user: AppUser; role: string }> {
  const user = await requireUser(req);
  if (user.is_platform_admin) return { user, role: 'platform_admin' };
  throw new HttpError(403, 'You do not have access to this business.');
}
