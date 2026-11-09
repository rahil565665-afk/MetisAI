import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { api } from './api.js';
import type { Company } from './types.js';

/**
 * A safety net for the clinic list. Clinics live in Cloudflare and survive updates, but a backup file
 * means a deleted Worker or a lost database never costs anyone their clinic settings.
 */
export function BackupPanel({ onRestored, download = true }: { onRestored: (tenants: Company[]) => void; download?: boolean }) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  async function save() {
    setBusy(true); setMessage(''); setFailed(false);
    try {
      const { blob, filename } = await api.downloadBackup();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      URL.revokeObjectURL(url);
      setMessage('Backup downloaded. Keep it somewhere safe.');
    } catch (cause) {
      setFailed(true); setMessage(cause instanceof Error ? cause.message : 'Could not create the backup.');
    } finally { setBusy(false); }
  }

  async function restore(file: File | undefined) {
    if (!file) return;
    setBusy(true); setMessage(''); setFailed(false);
    try {
      let payload: unknown;
      try { payload = JSON.parse(await file.text()); } catch { throw new Error('That file could not be read. Choose a backup downloaded from this console.'); }
      const result = await api.restoreBackup(payload);
      onRestored(result.tenants);
      setMessage(result.restored
        ? `Restored ${result.restored} clinic${result.restored === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} already existed and were left as they are` : ''}. If a clinic shows Needs attention, enter its keys again under Integrations.`
        : 'Nothing to restore: every clinic in that file already exists.');
    } catch (cause) {
      setFailed(true); setMessage(cause instanceof Error ? cause.message : 'Could not restore the backup.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return <div className="backup-panel">
    <input ref={input} type="file" accept="application/json,.json" hidden aria-label="Clinic backup file" onChange={(event) => void restore(event.target.files?.[0])} />
    <div className="backup-text"><strong>Back up your clinics</strong><span>Clinics are kept across updates. A backup file also lets you bring them back if the Worker is ever deleted. Provider keys inside it stay encrypted.</span></div>
    <div className="backup-actions">
      {download && <button type="button" className="button ghost" disabled={busy} onClick={() => void save()}><Download size={15} /> Download backup</button>}
      <button type="button" className="button ghost" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} /> Restore from backup</button>
    </div>
    {message && <div className={`alert ${failed ? 'error' : 'warn'} backup-message`} role={failed ? 'alert' : 'status'}>{message}</div>}
  </div>;
}
