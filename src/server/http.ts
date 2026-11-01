import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { void handler(req, res, next).catch(next); };
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  if (error instanceof z.ZodError) return error.issues.map((issue) => issue.message).join('; ');
  // Body-parser failures (malformed JSON, oversized body) carry a 4xx status but internal wording.
  if (errorStatus(error) < 500) return 'The request body could not be read.';
  return 'The request could not be completed. Check configuration and try again.';
}

/** HTTP status for an error: validation problems are the client's fault, anything unknown is ours. */
export function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof z.ZodError) return 400;
  const status = typeof error === 'object' && error && 'status' in error ? (error as { status: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T { return schema.parse(body); }
