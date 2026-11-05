/** Test doubles for Google, Cal.com and Supabase are honoured only in an explicit local development run. */
export function developmentUrl(name: string): string | undefined {
  if (process.env.NODE_ENV !== 'development') return undefined;
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}
