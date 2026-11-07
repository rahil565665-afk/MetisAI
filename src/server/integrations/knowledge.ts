/**
 * The clinic's knowledge base is text pulled out of an uploaded PDF in the administrator's browser.
 * It is cleaned here rather than rejected: whatever was uploaded is kept, minus characters that could
 * only be noise or break the prompt, and cut to a length the voice model can carry.
 */

export const KNOWLEDGE_MAX_CHARS = 60_000;

export interface KnowledgeFileInfo {
  name: string;
  pages: number;
  characters: number;
}

/** Remove control characters, tidy line endings and runs of blank lines, trim, and cut to the limit. */
export function cleanKnowledgeText(value: unknown, max = KNOWLEDGE_MAX_CHARS): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Basic facts about the uploaded file, kept so the dashboard can say what the knowledge came from. */
export function cleanKnowledgeFile(value: unknown, characters: number): KnowledgeFileInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  // eslint-disable-next-line no-control-regex
  const name = typeof source.name === 'string' ? source.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
  if (!name) return null;
  const pages = typeof source.pages === 'number' && Number.isFinite(source.pages) ? Math.max(0, Math.min(100_000, Math.floor(source.pages))) : 0;
  return { name, pages, characters };
}
