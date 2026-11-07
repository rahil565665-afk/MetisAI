import { useRef, useState } from 'react';
import { FileText, Upload, X } from 'lucide-react';
import { KNOWLEDGE_MAX_CHARS, PdfProblem, readPdfKnowledge } from './pdfText.js';

export interface KnowledgeFile { name: string; pages: number; characters: number }
export interface KnowledgeValue { text: string; file: KnowledgeFile | null }

const number = (value: number) => value.toLocaleString();

/** The clinic's knowledge base: a PDF is chosen, its text is read here, and the text is what gets saved. */
export function KnowledgeUpload({ value, onChange, disabled }: { value: KnowledgeValue; onChange: (next: KnowledgeValue) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [cutNote, setCutNote] = useState('');

  async function choose(file: File | undefined) {
    if (!file) return;
    setBusy(true); setProblem(''); setCutNote('');
    try {
      const pdf = await readPdfKnowledge(file);
      onChange({ text: pdf.text, file: { name: pdf.name, pages: pdf.pages, characters: pdf.characters } });
      if (pdf.originalCharacters > pdf.characters) {
        setCutNote(`This PDF has ${number(pdf.originalCharacters)} characters. Only the first ${number(KNOWLEDGE_MAX_CHARS)} are used, so put the most important information first.`);
      }
    } catch (error) {
      setProblem(error instanceof PdfProblem ? error.message : 'That PDF could not be read. Try a different file.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const has = value.text.trim().length > 0;
  const label = value.file?.name ?? 'Text saved earlier';
  const details = value.file && value.file.pages > 0
    ? `${number(value.file.pages)} page${value.file.pages === 1 ? '' : 's'} · ${number(value.text.length)} characters`
    : `${number(value.text.length)} characters`;
  return <div className="knowledge-upload">
    <input ref={input} type="file" accept="application/pdf,.pdf" hidden aria-label="Knowledge base PDF" onChange={(event) => void choose(event.target.files?.[0])} />
    {has
      ? <div className="knowledge-file">
          <FileText size={18} />
          <div className="knowledge-file-text"><strong>{label}</strong><span>{details}</span></div>
          <button type="button" className="button ghost" disabled={disabled || busy} onClick={() => input.current?.click()}>{busy ? 'Reading…' : 'Replace'}</button>
          <button type="button" className="icon-button" aria-label="Remove knowledge base" disabled={disabled || busy} onClick={() => { onChange({ text: '', file: null }); setCutNote(''); setProblem(''); }}><X size={16} /></button>
        </div>
      : <button type="button" className="knowledge-drop" disabled={disabled || busy} onClick={() => input.current?.click()}>
          <Upload size={20} />
          <strong>{busy ? 'Reading the PDF…' : 'Upload a PDF'}</strong>
          <span>Services, prices, hours, policies — anything the receptionist should know. Optional; you can add or replace it later.</span>
        </button>}
    {has && <details className="knowledge-preview"><summary>Preview what the receptionist will read</summary><pre>{value.text.slice(0, 1500)}{value.text.length > 1500 ? '\n…' : ''}</pre></details>}
    {cutNote && <div className="alert warn">{cutNote}</div>}
    {problem && <div className="alert error" role="alert">{problem}</div>}
  </div>;
}
