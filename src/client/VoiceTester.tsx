import { useEffect, useRef, useState } from 'react';
import { AudioLines, Check, CircleStop, Headphones, Mic, MicOff, Phone, ShieldAlert, X } from 'lucide-react';
import type { Company, VoiceStatus } from './types.js';
import type { CallHistory, CallScheduling, EndReason } from '../shared/voiceProtocol.js';
import { VoiceClient, type ApprovalRequest } from './voice/VoiceClient.js';

interface TranscriptRow { role: 'assistant' | 'user' | 'system'; text: string; final: boolean; }
interface VoiceTokenResponse { token: string; expiresInSeconds: number; }

const OPERATION_TITLE: Record<ApprovalRequest['operation'], string> = {
  create_booking: 'Create booking',
  reschedule_booking: 'Reschedule booking',
  cancel_booking: 'Cancel booking',
};

/** Why a call ended, for every reason except the person hanging up. Shown in the notice and in the transcript. */
const ENDED_TEXT: Partial<Record<EndReason, string>> = {
  time_limit: 'The test call reached its time limit and was ended. Start a new test call to keep going.',
  idle: 'The test call was ended because nobody spoke for a while. Start a new test call to continue.',
  admin: 'The call was ended by an administrator, for example because this business’s settings changed. Start a new test call to use the new settings.',
  service: 'The call was ended by the voice service. Start a new test call to try again.',
};

function fieldLabel(key: string): string {
  const spaced = key.replaceAll(/([A-Z])/g, ' $1').replaceAll('_', ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeApproval(request: ApprovalRequest): string {
  const lines = Object.entries(request.summary).map(([key, value]) => `${fieldLabel(key)}: ${value}`);
  return [OPERATION_TITLE[request.operation], ...lines].join('\n');
}

function voiceSocketUrl(tenantId: string): string {
  const url = new URL(`/agents/${encodeURIComponent(tenantId)}/ws`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function VoiceTester({ tenant }: { tenant: Company }) {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [pending, setPending] = useState<{ approvalId: string; summary: string } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [info, setInfo] = useState<{ scheduling: CallScheduling; history: CallHistory } | null>(null);
  const clientRef = useRef<VoiceClient | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' }); }, [transcript]);
  const live = !['idle', 'disconnected', 'error'].includes(status);
  // Keyed on `live`, not `status`: the status changes every few seconds and would keep resetting the timer.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => () => { clientRef.current?.stop(); clientRef.current = null; }, []);

  function appendTranscript(row: TranscriptRow) { setTranscript((rows) => [...rows, row]); }

  async function fetchToken(): Promise<string> {
    const response = await fetch(`/api/tenants/${encodeURIComponent(tenant.id)}/voice-token`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const body = await response.json().catch((): unknown => ({})) as { error?: unknown };
      throw new Error(typeof body.error === 'string' ? body.error : 'Could not authorize a voice test. Reload the page and try again.');
    }
    const data = await response.json() as VoiceTokenResponse;
    if (typeof data.token !== 'string' || !data.token) throw new Error('The voice authorization response was invalid.');
    return data.token;
  }

  function start() {
    if (clientRef.current?.running) return;
    setError(''); setNotice(''); setTranscript([]); setElapsed(0); setPending(null); setInfo(null);
    const client = new VoiceClient({
      status: setStatus,
      transcript: (role, text, final) => setTranscript((rows) => {
        const last = rows[rows.length - 1];
        if (last && last.role === role && !last.final) return [...rows.slice(0, -1), { role, text, final }];
        return [...rows, { role, text, final }];
      }),
      approval: (request) => setPending({ approvalId: request.approvalId, summary: describeApproval(request) }),
      approvalClosed: (approvalId) => setPending((current) => current?.approvalId === approvalId ? null : current),
      escalation: (reason) => setError(reason
        ? `A business team member has been requested: ${reason}. This browser test cannot transfer the call to a phone line.`
        : 'A business team member has been requested. This browser test cannot transfer the call to a phone line.'),
      notice: setNotice,
      callInfo: (scheduling, history) => setInfo({ scheduling, history }),
      error: setError,
      ended: (reason) => {
        setPending(null);
        const text = ENDED_TEXT[reason];
        if (!text) { setNotice(''); return; }
        setNotice(text);
        appendTranscript({ role: 'system', text, final: true });
      },
    });
    clientRef.current = client;
    // Started directly from the click so the browser lets the audio engine run.
    void client.start({ url: voiceSocketUrl(tenant.id), getToken: fetchToken });
  }

  function stop() {
    clientRef.current?.stop();
    setPending(null);
  }

  function decide(approved: boolean) {
    if (pending) clientRef.current?.respond(pending.approvalId, approved);
    if (!approved) appendTranscript({ role: 'system', text: 'Booking action was not approved. No change was made.', final: true });
    setPending(null);
  }

  const statusLabel: Record<VoiceStatus, string> = {
    idle: 'Ready to test', connecting: 'Connecting to assistant', listening: 'Listening', processing: 'Waiting for your approval', speaking: 'Assistant speaking', transfer_requested: 'Handoff requested', disconnected: 'Call ended', error: 'Connection needs attention',
  };
  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const seconds = String(elapsed % 60).padStart(2, '0');
  const visibleError = error;

  return <div className="voice-layout">
    <section className="voice-stage panel">
      <div className="voice-stage-top"><div><div className="eyebrow">LIVE BROWSER SESSION</div><h2>{tenant.name}</h2></div><span className={`call-state ${live ? 'live' : 'done'}`}><i />{statusLabel[status]}</span></div>
      <div className={`voice-circle ${status}`}><div className="voice-circle-inner"><div className="voice-ring ring-one" /><div className="voice-ring ring-two" />{status === 'error' ? <ShieldAlert size={27} /> : status === 'disconnected' ? <MicOff size={25} /> : <AudioLines size={28} />}</div></div>
      <div className="voice-timer">{minutes}:{seconds}</div>
      <p className="voice-caption">{status === 'idle' ? 'Your microphone is off until you begin a test call.' : status === 'listening' ? 'Say hello. The assistant will answer using this business’s configuration.' : status === 'speaking' ? 'Listen to the response, or speak to interrupt.' : status === 'transfer_requested' ? 'A handoff event has been recorded for business staff. No phone transfer occurred.' : status === 'disconnected' ? 'The test session has ended.' : statusLabel[status] + '…'}</p>
      {info && <ul className="call-checks" aria-label="Call checks">
        <li className={info.scheduling.available ? 'ok' : 'bad'}>{info.scheduling.available ? 'Booking: ready' : info.scheduling.reason?.includes('turned off') ? 'Booking is disabled for this business in Reception setup.' : `Booking unavailable${info.scheduling.reason ? `: ${info.scheduling.reason}` : ''}. Check Integrations → Cal.com scheduling; the receptionist can use other enabled actions.`}</li>
        <li className={info.history.state === 'not_saved' ? 'bad' : 'ok'}>{info.history.state === 'saved' ? (live ? 'Call history: this call is being recorded in Call activity' : 'Call history: saved to Call activity') : info.history.state === 'pending' ? 'Call history: checking…' : `Call history: not saved${info.history.problem ? `. ${info.history.problem}` : ''}`}</li>
      </ul>}
      {visibleError && <div className="alert error voice-error">{visibleError}</div>}{notice && !visibleError && <div className="alert voice-error">{notice}</div>}
      <div className="voice-controls">{live ? <button className="button danger" onClick={stop}><CircleStop size={17} /> End test call</button> : <button className="button primary" onClick={start}><Phone size={16} /> Start browser test</button>}</div>
      <div className="audio-privacy"><ShieldAlert size={14} /> Audio streams live for this test; it is not recorded or saved as an audio file.</div>
    </section>
    <section className="transcript-panel panel">
      <div className="panel-head"><div><div className="eyebrow">CONVERSATION</div><h2>Live transcript</h2></div><span className="mini-badge">TEXT ONLY</span></div>
      <div className="transcript-list" ref={transcriptRef}>{transcript.length ? transcript.map((item, index) => <div className={`transcript-line ${item.role}`} key={index}><span>{item.role === 'assistant' ? 'ASSISTANT' : item.role === 'user' ? 'CALLER' : 'SYSTEM'}</span><p>{item.text}</p></div>) : <div className="transcript-empty"><Headphones size={22} /><p>Start a test call to see the conversation here.</p></div>}</div>
      <div className="transcript-footer"><Mic size={14} /> {live ? 'Microphone connected · Browser audio' : 'No active microphone'}<span className={live ? 'status-dot mint' : 'status-dot'} /></div>
    </section>
    {pending && <div className="modal-backdrop"><section className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="booking-confirmation-title"><div className="confirm-icon"><ShieldAlert size={20} /></div><div className="eyebrow">CALLER APPROVAL REQUIRED</div><h2 id="booking-confirmation-title">Confirm booking action</h2><p>{pending.summary}</p><div className="confirm-warning">Nothing will be changed until you approve this action.</div><div className="modal-actions"><button className="button ghost" onClick={() => decide(false)}><X size={15} /> Don’t proceed</button><button className="button primary" onClick={() => decide(true)}><Check size={15} /> Approve action</button></div></section></div>}
  </div>;
}
