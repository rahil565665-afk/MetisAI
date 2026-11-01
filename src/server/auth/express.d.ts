import type { AppUser } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      user?: AppUser | null;
      cookies: Record<string, string>;
    }
  }
}
export {};
