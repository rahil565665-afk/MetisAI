import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { sessionMiddleware, login, logout, assertTrustedOrigin } from './auth/passcode.js';
import { apiRouter } from './routes/api.js';
import { errorStatus, safeErrorMessage } from './http.js';

export const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// API responses carry session-scoped or credential-adjacent data; never let a cache keep them.
app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use((req: Request, _res: Response, next: NextFunction) => {
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try { cookies[name] = decodeURIComponent(part.slice(separator + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  req.cookies = cookies;
  next();
});
app.use(sessionMiddleware);
app.post('/api/auth/login', (req, res, next) => { void login(req, res).catch(next); });
app.post('/api/auth/logout', (req, res, next) => { try { logout(req, res); } catch (error) { next(error); } });
app.use('/api', (req, _res, next) => {
  // Browser requests are cookie-authenticated, so mutating ones must come from the dashboard's own
  // origin (CSRF defence). Login and logout do their own origin check.
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const exempt = req.path === '/auth/login' || req.path === '/auth/logout';
  if (mutating && !exempt) {
    try { assertTrustedOrigin(req); } catch (error) { next(error); return; }
  }
  next();
});
app.use('/api', apiRouter);
app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found.' }); });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = errorStatus(error);
  // The real cause goes to the operator's private Worker logs only; clients get the generic message.
  // Error text from our own code and the database layer never contains credentials.
  if (status >= 500) console.error('[api-error]', error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : 'Unknown error');
  res.status(status).json({ error: safeErrorMessage(error) });
});
