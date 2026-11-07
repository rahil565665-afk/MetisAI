/**
 * Reads the text out of an uploaded PDF, in the browser. Doing it here keeps the heavy work off the
 * Worker (the free plan allows only a few milliseconds of CPU per request) and means the PDF file itself
 * is never uploaded or stored: only its text is saved as the clinic's knowledge base.
 */

export const MAX_PDF_BYTES = 30 * 1024 * 1024;
/** Must match KNOWLEDGE_MAX_CHARS on the server, which cuts anything longer. */
export const KNOWLEDGE_MAX_CHARS = 60_000;
const MIN_USEFUL_CHARS = 20;

export interface PdfKnowledge {
  name: string;
  pages: number;
  text: string;
  /** Characters kept (after any cut). */
  characters: number;
  /** Characters in the whole PDF; larger than `characters` when it was cut. */
  originalCharacters: number;
}

/** A problem with the chosen file, worded for the person who chose it. */
export class PdfProblem extends Error {}

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function readPdfKnowledge(file: File): Promise<PdfKnowledge> {
  if (file.size === 0) throw new PdfProblem('That file is empty.');
  if (file.size > MAX_PDF_BYTES) throw new PdfProblem(`That PDF is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is ${MAX_PDF_BYTES / 1024 / 1024} MB; export a smaller PDF.`);
  const header = new TextDecoder().decode(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
  if (!header.includes('%PDF-')) throw new PdfProblem('That file is not a PDF. Choose a file that ends in .pdf.');

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') throw new PdfProblem('That PDF is password-protected. Remove the password and upload it again.');
    throw new PdfProblem('That PDF could not be read. It may be damaged; try exporting it again.');
  }

  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      pages.push(lines.join('\n'));
      page.cleanup();
    }
    const full = tidy(pages.join('\n\n'));
    if (full.replace(/\s/g, '').length < MIN_USEFUL_CHARS) {
      throw new PdfProblem('No text could be read from that PDF. It looks like a scan or a set of pictures. Upload a PDF with selectable text, for example one exported from Word or Google Docs.');
    }
    const text = full.slice(0, KNOWLEDGE_MAX_CHARS);
    return { name: file.name, pages: document.numPages, text, characters: text.length, originalCharacters: full.length };
  } finally {
    void task.destroy();
  }
}
