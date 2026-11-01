import type { Request } from 'express';
import type { AppUser } from '../types.js';
import { getMembership } from '../integrations/supabase.js';
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

export async function requireTenantRole(req: Request, tenantId: string, roles: string[] = ['owner', 'manager', 'viewer']): Promise<{ user: AppUser; role: string }> {
  const user = await requireUser(req);
  if (user.is_platform_admin) return { user, role: 'platform_admin' };
  const membership = await getMembership(tenantId, user.id);
  if (!membership || !roles.includes(membership.role)) throw new HttpError(403, 'You do not have access to this clinic.');
  return { user, role: membership.role };
}
