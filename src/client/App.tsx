import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarDays, ChevronDown, ChevronRight, CircleHelp, Headphones, LayoutDashboard, LogOut, Mic2, Plus, Settings2, ShieldCheck, SlidersHorizontal, Stethoscope, X } from 'lucide-react';
import { api, type CallDetail, type CallRow, type NewTenantInput, type UsageSummary } from './api.js';
import * as React from 'react';
import type { Company, IntegrationStatus, SessionUser } from './types.js';
import { KnowledgeUpload, type KnowledgeValue } from './KnowledgeUpload.js';
import { BackupPanel } from './BackupPanel.js';

const VoiceTester = React.lazy(() => import('./VoiceTester.js').then((module) => ({ default: module.VoiceTester })));

type Page = 'overview' | 'voice' | 'clinic' | 'integrations' | 'calls';
type ExtendedCompany = Company;
type DeploymentSnapshot = { provisioned: boolean | null; inCall: boolean | null; status: string; error: string };

const shortName = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('').toUpperCase();
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
const firstBoolean = (source: Record<string, unknown>, names: string[]): boolean | null => {
  for (const name of names) if (typeof source[name] === 'boolean') return source[name] as boolean;
  return null;
};
const agentStateLabel = (status: string) => {
  switch (status.toLowerCase()) {
    case 'idle': return 'Idle · ready for a voice test';
    case 'in_call': return 'In a call';
    case 'not_provisioned': return 'Not provisioned';
    case 'unavailable': return 'Unavailable here';
    default: return status;
  }
};

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenants, setTenants] = useState<Company[]>([]);
  const [activeId, setActiveId] = useState('');
  const [page, setPage] = useState<Page>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<{ name: string; warnings: string[] } | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [passcode, setPasscode] = useState('');
  const active = useMemo(() => tenants.find((tenant) => tenant.id === activeId) ?? tenants[0] ?? null, [activeId, tenants]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const session = await api.getSession();
      setUser(session.user);
      if (session.user) {
        const data = await api.tenants();
        setTenants(data);
        setActiveId((current) => data.some((tenant) => tenant.id === current) ? current : data[0]?.id ?? '');
      } else {
        setTenants([]);
        setActiveId('');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load the console.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    const submittedPasscode = passcode;
    setPasscode('');
    setError('');
    try {
      await api.login(submittedPasscode);
      await load();
    } catch {
      setError('Passcode sign-in failed. Check the passcode and try again.');
    }
  }

  async function signOut() {
    await api.logout();
    setUser(null);
    setTenants([]);
    setActiveId('');
  }

  function restored(list: Company[]) {
    setTenants(list);
    setActiveId((current) => list.some((tenant) => tenant.id === current) ? current : list[0]?.id ?? '');
  }

  async function createTenant(input: NewTenantInput) {
    const { tenant, warnings } = await api.createTenant(input);
    setTenants((current) => [tenant, ...current]);
    setActiveId(tenant.id);
    setShowCreate(false);
    setCreated({ name: tenant.name, warnings });
    setPage(warnings.length ? 'integrations' : 'clinic');
  }

  const pageTitle: Record<Page, string> = { overview: 'Clinic overview', voice: 'Voice test lab', clinic: 'Reception setup', integrations: 'Provider connections', calls: 'Call activity' };

  if (loading) return <div className="loading-screen"><div className="spinner" /><span>Loading reception console</span></div>;

  if (!user) return <main className="login-wrap"><div className="login-card"><div className="brand-symbol"><Stethoscope size={25} /></div><div className="eyebrow">DENTDESK · RECEPTION OPERATIONS</div><h1>A calmer front desk,<br /><em>ready to listen.</em></h1><p>Enter your workspace passcode to configure a clinic, test a voice session, and review call activity.</p>{error && <div className="alert error">{error}</div>}<form onSubmit={(event) => void signIn(event)}><label className="form-field"><span>Workspace passcode</span><input type="password" autoComplete="current-password" value={passcode} onChange={(event) => setPasscode(event.target.value)} required /></label><button className="button primary wide">Continue <ChevronRight size={17} /></button></form><div className="login-note"><ShieldCheck size={15} /> Secure passcode sign-in · Clinic access is role-controlled</div></div><div className="login-aside"><span className="mini-label">RECEPTION CONSOLE</span><div className="signal-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div><div className="aside-title">Every call starts<br />with listening.</div><div className="aside-copy">Appointments, common questions, and the moment a person needs a person.</div></div></main>;

  if (!active && !user.isPlatformAdmin) return <main className="login-wrap"><div className="login-card"><div className="brand-symbol"><Stethoscope size={25} /></div><div className="eyebrow">ACCOUNT READY</div><h1>Clinic access<br /><em>is not assigned.</em></h1><p>Your account is signed in, but no clinic has been assigned. Ask your platform administrator to add your account to a clinic.</p><button className="button secondary" onClick={() => void signOut()}><LogOut size={16} /> Sign out</button></div></main>;

  const navigation: Array<{ id: Page; label: string; icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'voice', label: 'Voice test', icon: Headphones },
    { id: 'clinic', label: 'Clinic setup', icon: Settings2 },
    { id: 'integrations', label: 'Integrations', icon: SlidersHorizontal },
    { id: 'calls', label: 'Call activity', icon: Activity },
  ];
  const voiceTenant: Company | null = active;

  return <div className="app-shell">
    <aside className={`sidebar ${navOpen ? '' : 'sidebar-collapsed'}`}>
      <div className="sidebar-brand"><div className="brand-symbol small"><Stethoscope size={18} /></div>{navOpen && <div><strong>dentdesk</strong><span>RECEPTION CONSOLE</span></div>}<button className="icon-button nav-toggle" aria-label="Collapse navigation" onClick={() => setNavOpen(!navOpen)}><ChevronDown size={16} /></button></div>
      {navOpen && <div className="sidebar-section-label">WORKSPACE</div>}
      <div className="nav-list">{navigation.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)} title={item.label}><item.icon size={17} />{navOpen && <span>{item.label}</span>}{navOpen && item.id === 'voice' && <span className="nav-live">TEST</span>}</button>)}</div>
      <div className="sidebar-bottom">{navOpen && <div className="security-card"><div className="security-top"><span className="status-dot mint" />PRIVATE WORKSPACE</div><p>Clinic settings and provider keys are accessible only to authorized users.</p></div>}<button className="user-row" onClick={() => void signOut()}><div className="avatar">{shortName(user.name || user.email)}</div>{navOpen && <div className="user-meta"><strong>{user.name || user.email}</strong><span>{user.isPlatformAdmin ? 'Platform admin' : 'Clinic member'}</span></div>}<LogOut size={15} className="logout-icon" /></button></div>
    </aside>
    <main className="main-panel">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>{pageTitle[page]}</strong></div><div className="topbar-right"><span className="topbar-status"><i className="status-dot mint" /> CONSOLE READY</span><button className="help-button" title="Help"><CircleHelp size={16} /></button></div></header>
      <div className="content-scroll">
        <div className="page-heading"><div><div className="eyebrow">{page === 'voice' ? 'BROWSER AUDIO · NO PHONE LINE' : 'MULTI-TENANT RECEPTION'}</div><h1>{pageTitle[page]}</h1><p>{page === 'overview' ? 'A clear view of each clinic’s service configuration and runtime readiness.' : page === 'voice' ? 'Test the receptionist with your microphone before connecting a phone line.' : page === 'clinic' ? 'Tune the greeting, clinic details, and caller guidance.' : page === 'integrations' ? 'Connect provider accounts without exposing credentials to the browser.' : 'Recent calls, handoff requests, and assistant activity.'}</p></div><div className="heading-actions">{user.isPlatformAdmin && <button className="button primary" onClick={() => setShowCreate(true)}><Plus size={16} /> Add clinic agent</button>}</div></div>
        {error && <div className="alert error inline-alert">{error}<button onClick={() => setError('')}><X size={14} /></button></div>}
        {created && <div className={`alert inline-alert created-banner ${created.warnings.length ? 'warn' : ''}`}><div><strong>{created.name} was created.</strong>{created.warnings.length > 0 && <> These still need attention (you can fix each one under Integrations):<ul>{created.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></>}</div><button aria-label="Dismiss" onClick={() => setCreated(null)}><X size={14} /></button></div>}
        {active && <div className="tenant-context"><div className="tenant-monogram">{shortName(active.name)}</div><div className="tenant-context-name"><span>ACTIVE CLINIC</span><strong>{active.name}</strong></div><div className="tenant-switcher"><select aria-label="Choose active clinic" value={active.id} onChange={(event) => setActiveId(event.target.value)}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select><ChevronDown size={14} /></div><span className={`pill ${active.is_active ? 'active-pill' : 'paused-pill'}`}><i />{active.is_active ? 'ACTIVE' : 'PAUSED'}</span></div>}
        {!active && user.isPlatformAdmin && <div className="empty-state"><div className="empty-icon"><Stethoscope size={22} /></div><h2>Create your first clinic agent</h2><p>Each clinic gets its own voice agent, running on Cloudflare and answering through Gemini Live, and keeps its call history in its own Supabase project.</p><button className="button primary" onClick={() => setShowCreate(true)}><Plus size={16} /> Add clinic agent</button><div className="empty-restore"><span>Had clinics before? Bring them back from a backup file.</span><BackupPanel download={false} onRestored={restored} /></div></div>}
        {active && page === 'overview' && <Overview tenant={active as ExtendedCompany} go={setPage} canManage={user.isPlatformAdmin} onUpdate={(next) => setTenants((items) => items.map((item) => item.id === next.id ? next : item))} />}
        {active && page === 'overview' && user.isPlatformAdmin && <section className="panel backup-section"><div className="eyebrow">SAFEKEEPING</div><BackupPanel onRestored={restored} /></section>}
        {active && page === 'voice' && voiceTenant && <React.Suspense fallback={<div className="loading-screen"><div className="spinner" /><span>Loading voice test tools</span></div>}><VoiceTester tenant={voiceTenant} /></React.Suspense>}
        {active && page === 'clinic' && <ClinicSetup tenant={active} onUpdate={(next) => setTenants((items) => items.map((item) => item.id === next.id ? next : item))} />}
        {active && page === 'integrations' && <Integrations tenant={active} />}
        {active && page === 'calls' && <CallActivity tenant={active} />}
      </div>
    </main>
    {showCreate && <CreateTenantModal onClose={() => setShowCreate(false)} onCreate={createTenant} />}
  </div>;
}

type ConnectionState = 'ok' | 'problem' | 'todo';
const connectionState = (status?: IntegrationStatus): ConnectionState => status?.problem ? 'problem' : status?.configured ? 'ok' : 'todo';
const connectionLabel = (state: ConnectionState) => state === 'ok' ? 'Configured' : state === 'problem' ? 'Needs attention' : 'Needs setup';

function Overview({ tenant, go, canManage, onUpdate }: { tenant: ExtendedCompany; go: (page: Page) => void; canManage: boolean; onUpdate: (next: Company) => void }) {
  const [integrations, setIntegrations] = useState<Record<string, IntegrationStatus>>({});
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [databaseConnected, setDatabaseConnected] = useState<boolean | null>(null);
  const [databaseProblem, setDatabaseProblem] = useState('');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState('');
  const [deployment, setDeployment] = useState<DeploymentSnapshot>({ provisioned: null, inCall: null, status: 'Not reported', error: '' });
  const [refreshing, setRefreshing] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleNotice, setLifecycleNotice] = useState('');
  async function refreshDeployment() {
    setRefreshing(true);
    try {
      const response: unknown = await api.deploymentStatus(tenant.id);
      const data = isRecord(response) ? response : {};
      const status = typeof data.status === 'string' ? data.status : typeof data.state === 'string' ? data.state : 'Not reported';
      const error = typeof data.error === 'string' ? data.error : typeof data.message === 'string' && data.ok === false ? data.message : '';
      setDeployment({
        provisioned: firstBoolean(data, ['provisioned', 'configured', 'serviceConfigured']),
        inCall: firstBoolean(data, ['inCall']),
        status,
        error,
      });
      if (isRecord(data.tenant)) onUpdate(data.tenant as unknown as Company);
    } catch (cause) {
      setDeployment((current) => ({ ...current, error: cause instanceof Error ? cause.message : 'Could not refresh the voice agent status.' }));
    } finally { setRefreshing(false); }
  }
  useEffect(() => {
    void Promise.all([api.integrations(tenant.id), api.calls(tenant.id)]).then(([i, c]) => { setIntegrations(i); setCalls(c.calls); setDatabaseConnected(c.connected); setDatabaseProblem(c.problem ?? ''); }).catch(() => {});
    void refreshDeployment();
    let current = true;
    setUsage(null);
    setUsageLoading(true);
    setUsageError('');
    void api.usage(tenant.id).then((summary) => {
      if (current) setUsage(summary);
    }).catch((cause) => {
      if (current) setUsageError(cause instanceof Error ? cause.message : 'Could not load clinic usage.');
    }).finally(() => {
      if (current) setUsageLoading(false);
    });
    return () => { current = false; };
  }, [tenant.id]);
  async function endCall() {
    setLifecycleBusy(true); setLifecycleNotice('');
    try {
      const result = await api.endCall(tenant.id);
      setLifecycleNotice(result.message);
      await refreshDeployment();
    } catch (cause) {
      setLifecycleNotice(cause instanceof Error ? cause.message : 'Could not end the call in progress.');
    } finally { setLifecycleBusy(false); }
  }
  async function removeAgent() {
    if (!window.confirm(`Remove the voice agent for ${tenant.name}? This removes the clinic agent provisioning and its agent-specific configuration, but preserves the clinic profile and saved call and appointment history.`)) return;
    setLifecycleBusy(true); setLifecycleNotice('');
    try {
      const result = await api.deleteAgent(tenant.id);
      onUpdate(result.tenant);
      setDeployment({ provisioned: false, inCall: null, status: 'Not provisioned', error: '' });
      setLifecycleNotice('Clinic agent removed. The clinic profile and saved call and appointment history are preserved.');
    } catch (cause) {
      setLifecycleNotice(cause instanceof Error ? cause.message : 'Could not remove the clinic agent.');
    } finally { setLifecycleBusy(false); }
  }
  const checks = [
    { id: 'gemini', label: 'Gemini Live', status: integrations.gemini },
    { id: 'calcom', label: 'Cal.com', status: integrations.calcom },
    { id: 'supabase', label: 'Clinic Supabase database', status: integrations.supabase },
  ].map((item) => ({ ...item, state: connectionState(item.status), problem: item.status?.problem }));
  const ready = checks.filter((item) => item.state === 'ok').length;
  const yesNo = (value: boolean | null) => value === null ? 'Not reported' : value ? 'Yes' : 'No';
  const talkTime = (seconds: number) => {
    const totalMinutes = Math.floor(seconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours ? `${hours}h ${minutes}m` : `${totalMinutes}m`;
  };
  const periodLabel = usage?.periodStart && !Number.isNaN(Date.parse(usage.periodStart))
    ? `Since ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(usage.periodStart))} · last 30 days`
    : 'Last 30 days';
  return <><div className="overview-grid"><section className="panel readiness-panel"><div className="panel-head"><div><div className="eyebrow">SERVICE CONFIGURATION</div><h2>Reception stack</h2></div><div className="readiness-score"><strong>{ready}<small>/{checks.length}</small></strong><span>CONFIGURED</span></div></div><div className="readiness-list">{checks.map((item) => <div className="readiness-row" key={item.id}><span className={`provider-icon ${item.id}`}><i /></span><span className="provider-name">{item.label}</span><span className={`readiness-state ${item.state}`}><i />{connectionLabel(item.state)}</span></div>)}</div>{checks.filter((item) => item.problem).map((item) => <div className="alert warn" key={item.id}><strong>{item.label}:</strong> {item.problem}</div>)}<button className="text-link" onClick={() => go('integrations')}>Manage provider settings <ChevronRight size={15} /></button></section><section className="panel test-panel"><div className="eyebrow">BROWSER TEST</div><div className="test-visual"><div className="test-orbit"><Mic2 size={24} /></div><div className="test-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div><h2>Try a conversation</h2><p>Check the greeting, audio quality, and escalation flow before phone integration.</p><button className="button secondary" onClick={() => go('voice')}>Open voice test <ChevronRight size={15} /></button></section></div>
    <section className="panel usage-summary"><div className="panel-head"><div><div className="eyebrow">USAGE SUMMARY</div><h2>Last 30 days</h2></div><span className="mini-badge">{usage ? periodLabel : '30-day period'}</span></div>{usageLoading ? <div className="usage-state">Loading usage…</div> : usage && !usage.connected ? <div className="alert">This business’s database is not connected, so there is no usage to show. <button className="text-link inline-link" onClick={() => go('integrations')}>Connect it</button></div> : usageError ? <div className="alert error">{usageError}</div> : usage && usage.calls === 0 && usage.appointments === 0 && usage.escalationCount === 0 && usage.talkSeconds === 0 ? <div className="usage-empty"><CalendarDays size={20} /><span>No usage recorded for this period.</span></div> : usage ? <div className="usage-stats" aria-label="Usage statistics">{[
      ['Calls', usage.calls.toLocaleString()],
      ['Appointments', usage.appointments.toLocaleString()],
      ['Handoffs', usage.escalationCount.toLocaleString()],
      ['Talk time', talkTime(usage.talkSeconds)],
    ].map(([label, value]) => <div className="usage-stat" key={label}><strong className="usage-stat-value">{value}</strong><span className="usage-stat-label">{label}</span></div>)}</div> : null}</section>
    <section className="panel agent-status-panel"><div className="panel-head"><div><div className="eyebrow">CLOUDFLARE VOICE AGENT</div><h2>Agent status</h2></div><button className="button secondary" onClick={() => void refreshDeployment()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button></div><div className="readiness-list"><div className="readiness-row"><span className="provider-name">Agent provisioned</span><span className={`readiness-state ${deployment.provisioned ? 'ok' : ''}`}><i />{yesNo(deployment.provisioned)}</span></div><div className="readiness-row"><span className="provider-name">Call in progress</span><span className={`readiness-state ${deployment.inCall ? 'ok' : ''}`}><i />{yesNo(deployment.inCall)}</span></div><div className="readiness-row"><span className="provider-name">Agent state</span><span className="readiness-state">{agentStateLabel(deployment.status)}</span></div></div><div className="privacy-note"><ShieldCheck size={16} /><span>The agent only runs while a voice test is open and uses nothing between calls. Starting a test opens one WebSocket; there is no background pinger.</span></div>{lifecycleNotice && <div className="alert">{lifecycleNotice}</div>}{canManage && <div className="modal-actions"><button className="button secondary" onClick={() => void endCall()} disabled={lifecycleBusy}>{lifecycleBusy ? 'Working…' : 'End call in progress'}</button><button className="button secondary" onClick={() => void removeAgent()} disabled={lifecycleBusy}>Remove clinic agent</button></div>}{deployment.provisioned === false && <div className="alert">No voice agent is provisioned for this business. Add a Gemini API key to provision it.</div>}{deployment.error && <div className="alert error">Voice agent status: {deployment.error}</div>}</section>
    <div className="section-title-row"><div><div className="eyebrow">LATEST ACTIVITY</div><h2>Recent calls</h2></div><button className="text-link" onClick={() => go('calls')}>View call history <ChevronRight size={15} /></button></div><CallTable rows={calls.slice(0, 5)} tenantId={tenant.id} />{!calls.length && <div className="panel empty-activity"><CalendarDays size={20} /><span>{databaseConnected === false ? (databaseProblem || 'This clinic’s Supabase database is not connected, so calls are not being saved.') : 'No calls recorded yet. Start a browser voice test to see activity here.'}</span></div>}</>;
}

function ClinicSetup({ tenant, onUpdate }: { tenant: Company; onUpdate: (next: Company) => void }) {
  const config = tenant.receptionist_config as Company['receptionist_config'] & { knowledge_base?: string };
  const [greeting, setGreeting] = useState(config?.greeting || 'Thank you for calling. How can I help you today?');
  const knowledgeOf = (source: typeof config): KnowledgeValue => ({ text: source?.knowledge_base || '', file: source?.knowledge_base_file ?? null });
  const [knowledge, setKnowledge] = useState<KnowledgeValue>(knowledgeOf(config));
  const [faqs, setFaqs] = useState((config?.faqs ?? []).map((faq) => `${faq.question}\n${faq.answer}`).join('\n\n'));
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { const nextConfig = tenant.receptionist_config as typeof config; setGreeting(nextConfig?.greeting || 'Thank you for calling. How can I help you today?'); setKnowledge(knowledgeOf(nextConfig)); setTimezone(tenant.timezone); setFaqs((nextConfig?.faqs ?? []).map((faq) => `${faq.question}\n${faq.answer}`).join('\n\n')); }, [tenant.id]);
  async function save() {
    setSaving(true); setNotice('');
    try {
      const entries = faqs.split(/\n\s*\n/).map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean)).filter((lines) => lines.length >= 2).map((lines) => ({ question: lines[0], answer: lines.slice(1).join(' ') }));
      const next = await api.updateTenant(tenant.id, { timezone, receptionist_config: { ...tenant.receptionist_config, greeting, knowledge_base: knowledge.text, knowledge_base_file: knowledge.file, faqs: entries, transfer_enabled: true } });
      onUpdate(next); setNotice('Reception settings saved.');
    } catch (cause) { setNotice(cause instanceof Error && cause.message ? cause.message : 'Could not save reception settings.'); }
    finally { setSaving(false); }
  }
  return <div className="settings-layout"><section className="panel settings-main"><div className="panel-head"><div><div className="eyebrow">CALLER EXPERIENCE</div><h2>Reception instructions</h2></div><span className="mini-badge">{tenant.business_type.replaceAll('_', ' ')}</span></div><label className="field-label">Opening greeting<span>What callers hear when the assistant answers.</span></label><textarea className="textarea greeting-input" value={greeting} maxLength={800} onChange={(event) => setGreeting(event.target.value)} /><label className="field-label">Knowledge base<span>Upload a PDF with the clinic’s policies, services, prices, hours and other reference information. Press Save reception setup afterwards to apply it.</span></label><KnowledgeUpload value={knowledge} onChange={setKnowledge} disabled={saving} /><label className="field-label">Frequently asked questions<span>Separate each entry with a blank line. Put the question first, then the answer.</span></label><textarea className="textarea faq-input" placeholder={'Do you accept walk-ins?\nWe recommend booking ahead so we can find a time that works for you.\n\nWhat are your hours?\nPlease check the clinic website for today’s hours.'} value={faqs} onChange={(event) => setFaqs(event.target.value)} /><div className="settings-footer">{notice && <span className="inline-notice">{notice}</span>}<button className="button primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save reception setup'}</button></div></section><aside className="panel settings-aside"><div className="eyebrow">CLINIC PROFILE</div><h2>{tenant.name}</h2><label className="field-label">Clinic time zone</label><select className="select-field" value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="America/New_York">Eastern Time — New York</option><option value="America/Chicago">Central Time — Chicago</option><option value="America/Denver">Mountain Time — Denver</option><option value="America/Los_Angeles">Pacific Time — Los Angeles</option><option value="UTC">UTC</option></select><div className="privacy-note"><ShieldCheck size={16} /><span>Changes apply to the active clinic. Only clinic managers and owners can edit this setup.</span></div></aside></div>;
}

const emptyProviderFields = () => ({ geminiApiKey: '', calcomApiKey: '', calcomEventTypeId: '', calcomEventLink: '', supabaseUrl: '', supabaseSecretKey: '', accountSid: '', authToken: '', phoneNumber: '' });
type ProviderFields = ReturnType<typeof emptyProviderFields>;

function currentEvent(tenant: Company): string {
  const event = tenant.receptionist_config.calcom;
  if (!event) return '';
  if (event.event_type_id) return `event type ID ${event.event_type_id}`;
  if (event.event_type_slug && (event.username || event.team_slug)) return `${event.team_slug ? 'team/' : ''}${event.team_slug || event.username}/${event.event_type_slug}`;
  return '';
}

function Integrations({ tenant }: { tenant: Company }) {
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [provider, setProvider] = useState('gemini');
  const [fields, setFields] = useState<ProviderFields>(emptyProviderFields());
  const [notice, setNotice] = useState('');
  const [noticeIsWarning, setNoticeIsWarning] = useState(false);
  const [saving, setSaving] = useState(false);
  async function refresh() { setStatuses(await api.integrations(tenant.id)); }
  useEffect(() => { void refresh().catch(() => setNotice('Could not load integration statuses.')); }, [tenant.id]);
  const providerInfo: Record<string, { title: string; description: string }> = {
    gemini: { title: 'Gemini Live', description: 'Realtime conversation, speech understanding, and receptionist tool selection.' },
    calcom: { title: 'Cal.com scheduling', description: 'Availability, appointment booking, rescheduling, and cancellations.' },
    supabase: { title: 'Clinic Supabase database', description: 'This clinic’s own database for call history and appointments. Nothing is shared with other clinics.' },
    twilio: { title: 'Twilio credentials', description: 'Optional credential storage only. Phone transport remains disconnected.' },
  };
  const providers = [
    { id: 'gemini', label: providerInfo.gemini.title },
    { id: 'calcom', label: providerInfo.calcom.title },
    { id: 'supabase', label: providerInfo.supabase.title },
    { id: 'twilio', label: providerInfo.twilio.title },
  ];
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice(''); setNoticeIsWarning(false);
    let keyFields: string[] = [];
    let payload: Record<string, unknown> = {};
    if (provider === 'gemini') { keyFields = ['geminiApiKey']; payload = { apiKey: fields.geminiApiKey.trim() }; }
    if (provider === 'calcom') {
      keyFields = ['calcomApiKey'];
      payload = { apiKey: fields.calcomApiKey.trim(), eventTypeId: fields.calcomEventTypeId.trim() || null, eventLink: fields.calcomEventLink.trim() };
    }
    if (provider === 'supabase') { keyFields = ['supabaseSecretKey']; payload = { supabaseUrl: fields.supabaseUrl.trim(), supabaseSecretKey: fields.supabaseSecretKey.trim() }; }
    if (provider === 'twilio') { keyFields = ['accountSid', 'authToken']; payload = { accountSid: fields.accountSid.trim(), authToken: fields.authToken.trim(), phoneNumber: fields.phoneNumber.trim() }; }
    try {
      const result = await api.updateIntegration(tenant.id, provider, payload);
      const next = { ...fields };
      keyFields.forEach((key) => { next[key as keyof ProviderFields] = ''; });
      if (provider === 'calcom') { next.calcomEventTypeId = ''; next.calcomEventLink = ''; }
      if (provider === 'supabase') next.supabaseUrl = '';
      if (provider === 'twilio') next.phoneNumber = '';
      setFields(next);
      await refresh().catch(() => undefined);
      setNotice(result.message || 'Saved securely. Secret values are not shown again.');
      setNoticeIsWarning(Boolean(result.warning));
    } catch (cause) {
      setNoticeIsWarning(true);
      setNotice(cause instanceof Error && cause.message ? cause.message : 'Could not save this connection. Try again in a moment.');
    } finally { setSaving(false); }
  }
    const secretInput = (key: keyof ProviderFields, label: string) => <label className="form-field" key={key}><span>{label}</span><input type="password" autoComplete="new-password" value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} placeholder="Enter a new value to rotate; existing value is never shown" /></label>;
  const textInput = (key: keyof ProviderFields, label: string, placeholder?: string) => <label className="form-field" key={key}><span>{label}</span><input type="text" autoComplete="off" value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} placeholder={placeholder ?? `Enter ${label.toLowerCase()}`} /></label>;
  return <div className="integrations-layout"><section className="panel provider-list"><div className="panel-head"><div><div className="eyebrow">PROVIDER CONFIGURATION</div><h2>Integration status</h2></div></div>{providers.map((item) => <button key={item.id} className={`integration-row ${provider === item.id ? 'selected' : ''}`} onClick={() => { setProvider(item.id); setNotice(''); setNoticeIsWarning(false); }}><span className={`provider-icon ${item.id}`}><i /></span><span className="integration-row-text"><strong>{item.label}</strong><small>{providerInfo[item.id]?.description}</small></span><span className={`readiness-state ${connectionState(statuses[item.id])}`}><i />{connectionLabel(connectionState(statuses[item.id]))}</span></button>)}</section><section className="panel integration-form"><div className="eyebrow">CONFIGURATION</div><h2>{providerInfo[provider].title}</h2><p>{providerInfo[provider].description}</p>
    {statuses[provider]?.problem && <div className="alert warn">{statuses[provider]?.problem}</div>}
    {provider === 'calcom' && <div className="privacy-note"><ShieldCheck size={16} /><span>Paste the event’s link (for example https://cal.com/your-name/30min), or enter the numeric event type ID. If you enter both, the ID is used. Leave the API key empty to keep the one already saved.{currentEvent(tenant) && <> Current event: {currentEvent(tenant)}.</>}</span></div>}
    {provider === 'supabase' && <div className="privacy-note"><ShieldCheck size={16} /><span>Create a free project at supabase.com, run <code>supabase/clinic-schema.sql</code> once in its SQL Editor, then paste the project URL and the <strong>secret</strong> key (Project Settings → API Keys). Leave the key empty to keep the one already saved. The key is stored encrypted and never shown again.</span></div>}
    {provider === 'twilio' && <><div className="alert">Credentials only — not connected.</div><div className="privacy-note"><ShieldCheck size={16} /><span>Credentials are stored encrypted, but are not used by the voice agent. This app does not validate or use them, call Twilio, configure webhooks, route phone calls, or enable the phone transport. Twilio remains disconnected.</span></div></>}
    <form onSubmit={(event) => void save(event)}>
      {provider === 'gemini' && secretInput('geminiApiKey', 'Gemini API key')}
      {provider === 'calcom' && <>{secretInput('calcomApiKey', 'Cal.com API key')}{textInput('calcomEventLink', 'Event link', 'https://cal.com/your-name/30min')}{textInput('calcomEventTypeId', 'Or numeric event type ID', 'e.g. 7768457')}</>}
      {provider === 'supabase' && <>{textInput('supabaseUrl', 'Supabase project URL', 'https://your-project.supabase.co')}{secretInput('supabaseSecretKey', 'Supabase secret key')}</>}
      {provider === 'twilio' && <>{secretInput('accountSid', 'TWILIO_ACCOUNT_SID')}{secretInput('authToken', 'TWILIO_AUTH_TOKEN')}{textInput('phoneNumber', 'TWILIO_PHONE_NUMBER', '+15551234567')}</>}
      <div className="form-bottom">{notice && <span className={`inline-notice ${noticeIsWarning ? 'warning' : ''}`}>{notice}</span>}<button className="button primary" disabled={saving}>{saving ? 'Saving…' : provider === 'twilio' ? 'Save credentials' : 'Save connection'}</button></div>
    </form><div className="secret-footnote"><ShieldCheck size={15} />Secret fields are blank on load; stored values are never returned or displayed.</div></section></div>;
}

function CallActivity({ tenant }: { tenant: Company }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [connected, setConnected] = useState(true);
  const [problem, setProblem] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setError(''); void api.calls(tenant.id).then((result) => { setRows(result.calls); setConnected(result.connected); setProblem(result.problem ?? ''); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load call activity.')); }, [tenant.id]);
  return <><div className="panel call-list-panel"><div className="panel-head"><div><div className="eyebrow">CALL HISTORY</div><h2>Recent sessions</h2></div><span className="mini-badge">{rows.length} RECORDS</span></div>{error && <div className="alert error">{error}</div>}{!connected && <div className="alert warn">{problem || 'This clinic’s Supabase database is not connected, so calls are not being saved.'} Check it under Integrations → Clinic Supabase database.</div>}<CallTable rows={rows} tenantId={tenant.id} /></div><div className="privacy-note full-note"><ShieldCheck size={16} /><span>Conversation text can contain personal information. Raw browser audio is not recorded. Define retention and consent before using real patient data.</span></div></>;
}

function CallTable({ rows, tenantId }: { rows: CallRow[]; tenantId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!rows.length) return <div className="table-empty"><Activity size={18} /><span>No call activity yet.</span></div>;
  return <div className="table-wrap"><table><thead><tr><th>SESSION</th><th>STARTED</th><th>CALLER</th><th>STATUS</th><th>WHAT HAPPENED</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{rows.map((row) => <React.Fragment key={row.id}><tr><td><span className="call-id">{row.id.slice(0, 8).toUpperCase()}</span>{row.transfer_requested && <span className="transfer-tag">HANDOFF</span>}<div className="call-transport">{row.transport === 'browser' ? 'Browser test' : 'Twilio'}</div></td><td>{new Date(row.started_at).toLocaleString()}</td><td>{row.caller_name || '—'}</td><td><span className={`call-state ${row.status === 'completed' ? 'done' : row.status === 'transfer_requested' ? 'attention' : row.status === 'error' ? 'failed' : 'live'}`}><i />{row.status.replaceAll('_', ' ')}</span></td><td className="call-outcome">{row.outcome || '—'}</td><td><button type="button" className="text-link" aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}>{open === row.id ? 'Hide' : 'Details'}</button></td></tr>{open === row.id && <tr className="call-detail-row"><td colSpan={6}><CallDetailView tenantId={tenantId} callId={row.id} /></td></tr>}</React.Fragment>)}</tbody></table></div>;
}

function CallDetailView({ tenantId, callId }: { tenantId: string; callId: string }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setCall(null); setError('');
    void api.call(tenantId, callId).then((value) => { if (current) setCall(value); }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : 'Could not load this call.'); });
    return () => { current = false; };
  }, [tenantId, callId]);
  if (error) return <div className="alert error" role="alert">{error}</div>;
  if (!call) return <div className="call-detail-loading">Loading…</div>;
  const meta = call.metadata ?? {};
  const events = Array.isArray(meta.events) ? meta.events : [];
  const transcript = Array.isArray(meta.transcript) ? meta.transcript : [];
  return <div className="call-detail" aria-label="Call details">
    {call.caller_name && <p className="call-detail-line"><strong>Caller</strong> {call.caller_name}{call.caller_phone ? ` · ${call.caller_phone}` : ''}</p>}
    {call.ended_at && <p className="call-detail-line"><strong>Length</strong> {Math.max(0, Math.round((Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000))} seconds</p>}
    {meta.failure && <div className="alert error">{meta.failure}</div>}
    {meta.scheduling && meta.scheduling.available === false && <div className="alert warn">Booking was not available on this call{meta.scheduling.reason ? `: ${meta.scheduling.reason}` : '.'}</div>}
    {call.transfer_reason && <p className="call-detail-line"><strong>Handoff</strong> {call.transfer_reason}</p>}
    {events.length > 0 && <><div className="eyebrow">WHAT THE RECEPTIONIST DID</div><ul className="call-events">{events.map((item, index) => <li key={index}>{item.text}</li>)}</ul></>}
    <div className="eyebrow">CONVERSATION</div>
    {transcript.length === 0 ? <p className="call-detail-line">No conversation text was saved for this call.</p> : <div className="call-transcript">{transcript.map((line, index) => <div key={index} className={`transcript-line ${line.role}`}><span>{line.role === 'user' ? 'CALLER' : 'RECEPTIONIST'}</span><p>{line.text}</p></div>)}</div>}
  </div>;
}

function CreateTenantModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: NewTenantInput) => Promise<void> }) {
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [greeting, setGreeting] = useState('Thank you for calling. How can I help you today?');
  const [knowledge, setKnowledge] = useState<KnowledgeValue>({ text: '', file: null });
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [calcomApiKey, setCalcomApiKey] = useState('');
  const [calcomEventTypeId, setCalcomEventTypeId] = useState('');
  const [calcomEventLink, setCalcomEventLink] = useState('');
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [supabaseSecretKey, setSupabaseSecretKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLDivElement | null>(null);
  // Keep the page behind the dialog still, so the dialog is the only thing that scrolls.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [error]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await onCreate({
        name, timezone,
        receptionist_config: { greeting, knowledge_base: knowledge.text, knowledge_base_file: knowledge.file },
        integrations: { geminiApiKey, supabaseUrl, supabaseSecretKey, calcomApiKey, calcomEventTypeId, calcomEventLink },
      });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : 'Could not create the clinic. Try again.');
    } finally { setSaving(false); }
  }
  const secretField = (label: string, value: string, change: (value: string) => void, placeholder: string) => <label className="form-field"><span>{label}</span><input type="password" autoComplete="new-password" value={value} onChange={(event) => change(event.target.value)} placeholder={placeholder} /></label>;
  return <div className="modal-backdrop" onClick={onClose}><section className="modal-card" onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">NEW CLINIC AGENT</div><h2>Add clinic agent</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><p>Only the clinic name is needed. Everything else is optional and can be added or fixed later under Integrations; the clinic is created either way, and anything that does not check out is listed afterwards. Keys are stored encrypted and never shown again.</p>{error && <div className="alert error" ref={errorRef} role="alert">{error}</div>}<form onSubmit={(event) => void submit(event)}><label className="form-field"><span>Clinic name</span><input required maxLength={160} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Northside Dental" /></label><label className="form-field"><span>Time zone</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="America/New_York">America/New_York</option><option value="America/Chicago">America/Chicago</option><option value="America/Denver">America/Denver</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="UTC">UTC</option></select></label><label className="form-field"><span>Receptionist greeting</span><textarea className="textarea" value={greeting} onChange={(event) => setGreeting(event.target.value)} /></label><div className="eyebrow">KNOWLEDGE BASE</div><KnowledgeUpload value={knowledge} onChange={setKnowledge} disabled={saving} /><div className="eyebrow">CLINIC DATABASE</div><div className="privacy-note"><ShieldCheck size={16} /><span>Each clinic keeps its call history and appointments in its own Supabase project. Paste its URL and <strong>secret</strong> key (Project Settings → API Keys). Run <code>supabase/clinic-schema.sql</code> in that project’s SQL Editor once for a new project; a project from an earlier version is repaired automatically.</span></div><label className="form-field"><span>Supabase project URL</span><input autoComplete="off" value={supabaseUrl} onChange={(event) => setSupabaseUrl(event.target.value)} placeholder="https://your-project.supabase.co" /></label>{secretField('Supabase secret key', supabaseSecretKey, setSupabaseSecretKey, 'sb_secret_… (not the publishable key)')}<div className="eyebrow">VOICE</div>{secretField('Gemini API key', geminiApiKey, setGeminiApiKey, 'Needed for the voice agent to answer')}<div className="eyebrow">SCHEDULING</div><div className="privacy-note"><ShieldCheck size={16} /><span>Add the Cal.com API key and either the event’s link (for example https://cal.com/your-name/30min) or its numeric event type ID.</span></div>{secretField('Cal.com API key', calcomApiKey, setCalcomApiKey, 'cal_live_…')}<label className="form-field"><span>Cal.com event link</span><input autoComplete="off" value={calcomEventLink} onChange={(event) => setCalcomEventLink(event.target.value)} placeholder="https://cal.com/your-name/30min" /></label><label className="form-field"><span>Or numeric event type ID</span><input inputMode="numeric" autoComplete="off" value={calcomEventTypeId} onChange={(event) => setCalcomEventTypeId(event.target.value)} placeholder="e.g. 7768457" /></label><div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Creating…' : 'Create clinic agent'}</button></div></form></section></div>;
}
