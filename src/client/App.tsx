import { useEffect, useMemo, useState } from 'react';
import { Activity, CalendarDays, ChevronDown, ChevronRight, CircleHelp, Headphones, LayoutDashboard, LogOut, Mic2, Plus, Settings2, ShieldCheck, SlidersHorizontal, Stethoscope, X } from 'lucide-react';
import { api } from './api.js';
import * as React from 'react';
import type { Company, IntegrationStatus, SessionUser } from './types.js';

const VoiceTester = React.lazy(() => import('./VoiceTester.js').then((module) => ({ default: module.VoiceTester })));

type Page = 'overview' | 'voice' | 'clinic' | 'integrations' | 'calls';
type ExtendedCompany = Company;
type DeploymentSnapshot = { provisioned: boolean | null; runtimeReady: boolean | null; status: string; error: string };
type UsageSummary = { calls: number; appointments: number; escalationCount: number; talkSeconds: number; periodStart: string };

const shortName = (name: string) => name.split(' ').slice(0, 2).map((word) => word[0]).join('').toUpperCase();
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';
const firstBoolean = (source: Record<string, unknown>, names: string[]): boolean | null => {
  for (const name of names) if (typeof source[name] === 'boolean') return source[name] as boolean;
  return null;
};
const containerStateLabel = (status: string, runtimeReady: boolean | null) => {
  const value = status.toLowerCase();
  if (value === 'not_configured') return 'Not configured';
  if (/(asleep|sleeping|suspended|stopped)/.test(value)) return 'Asleep';
  if (/(waking|starting|booting|pending)/.test(value)) return 'Waking';
  if (runtimeReady === true || /(awake|ready|healthy|running)/.test(value)) return 'Awake';
  return status;
};

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenants, setTenants] = useState<Company[]>([]);
  const [activeId, setActiveId] = useState('');
  const [page, setPage] = useState<Page>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
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

  async function createTenant(input: {
    name: string; slug: string; timezone: string;
    receptionist_config: { greeting: string; knowledge_base: string; voice_output_mode: 'native' | 'cartesia' };
    integrations: { geminiApiKey: string; cartesiaApiKey: string; cartesiaVoiceId: string; calcomApiKey: string; calcomEventTypeId: number | null; calcomEventTypeSlug: string; calcomUsername: string; calcomTeamSlug: string };
  }) {
    const created = await api.createTenant(input);
    setTenants((current) => [created, ...current]);
    setActiveId(created.id);
    setShowCreate(false);
    setPage('clinic');
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
  const extendedActive = active as ExtendedCompany | null;
  const voiceTenant = extendedActive ? { ...extendedActive, agentUrl: `${window.location.origin}/agents/${extendedActive.id}` } as Company : null;

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
        {active && <div className="tenant-context"><div className="tenant-monogram">{shortName(active.name)}</div><div className="tenant-context-name"><span>ACTIVE CLINIC</span><strong>{active.name}</strong></div><div className="tenant-switcher"><select aria-label="Choose active clinic" value={active.id} onChange={(event) => setActiveId(event.target.value)}>{tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</select><ChevronDown size={14} /></div><span className={`pill ${active.is_active ? 'active-pill' : 'paused-pill'}`}><i />{active.is_active ? 'ACTIVE' : 'PAUSED'}</span></div>}
        {!active && user.isPlatformAdmin && <div className="empty-state"><div className="empty-icon"><Stethoscope size={22} /></div><h2>Create your first clinic agent</h2><p>Each clinic agent is served through its Cloudflare clinic Container and agent process.</p><button className="button primary" onClick={() => setShowCreate(true)}><Plus size={16} /> Add clinic agent</button></div>}
        {active && page === 'overview' && <Overview tenant={active as ExtendedCompany} go={setPage} canManage={user.isPlatformAdmin} onUpdate={(next) => setTenants((items) => items.map((item) => item.id === next.id ? next : item))} />}
        {active && page === 'voice' && voiceTenant && <React.Suspense fallback={<div className="loading-screen"><div className="spinner" /><span>Loading voice test tools</span></div>}><VoiceTester tenant={voiceTenant} /></React.Suspense>}
        {active && page === 'clinic' && <ClinicSetup tenant={active} onUpdate={(next) => setTenants((items) => items.map((item) => item.id === next.id ? next : item))} />}
        {active && page === 'integrations' && <Integrations tenant={active} />}
        {active && page === 'calls' && <CallActivity tenant={active} />}
      </div>
    </main>
    {showCreate && <CreateTenantModal onClose={() => setShowCreate(false)} onCreate={createTenant} />}
  </div>;
}

function Overview({ tenant, go, canManage, onUpdate }: { tenant: ExtendedCompany; go: (page: Page) => void; canManage: boolean; onUpdate: (next: Company) => void }) {
  const [integrations, setIntegrations] = useState<Record<string, IntegrationStatus>>({});
  const [calls, setCalls] = useState<any[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState('');
  const [deployment, setDeployment] = useState<DeploymentSnapshot>({ provisioned: null, runtimeReady: null, status: 'Not reported', error: '' });
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
        runtimeReady: firstBoolean(data, ['runtimeReady', 'runtime_ready', 'ready', 'healthy']),
        status,
        error,
      });
      if (isRecord(data.tenant)) onUpdate(data.tenant as unknown as Company);
    } catch (cause) {
      setDeployment((current) => ({ ...current, error: cause instanceof Error ? cause.message : 'Could not refresh clinic Container status.' }));
    } finally { setRefreshing(false); }
  }
  useEffect(() => {
    void Promise.all([api.integrations(tenant.id), api.calls(tenant.id)]).then(([i, c]) => { setIntegrations(i); setCalls(c); }).catch(() => {});
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
  async function resetAgent() {
    setLifecycleBusy(true); setLifecycleNotice('');
    try {
      await api.redeploy(tenant.id);
      setDeployment((current) => ({ ...current, runtimeReady: null, status: 'Restart requested · takes effect on next test', error: '' }));
      setLifecycleNotice('Agent process reset/restart requested. It takes effect the next time you start a user test.');
    } catch (cause) {
      setLifecycleNotice(cause instanceof Error ? cause.message : 'Could not request an agent process reset/restart.');
    } finally { setLifecycleBusy(false); }
  }
  async function removeAgent() {
    if (!window.confirm(`Remove the provisioned agent process for ${tenant.name}? This removes the clinic agent provisioning and its agent-specific configuration, but preserves the clinic profile and saved call and appointment history.`)) return;
    setLifecycleBusy(true); setLifecycleNotice('');
    try {
      const result = await api.deleteAgent(tenant.id);
      onUpdate(result.tenant);
      setDeployment({ provisioned: false, runtimeReady: null, status: 'Not provisioned', error: '' });
      setLifecycleNotice('Clinic agent removed. The clinic profile and saved call and appointment history are preserved.');
    } catch (cause) {
      setLifecycleNotice(cause instanceof Error ? cause.message : 'Could not remove the clinic agent process.');
    } finally { setLifecycleBusy(false); }
  }
  const checks = [
    { id: 'gemini', label: 'Gemini Live', value: integrations.gemini?.configured },
    { id: 'cartesia', label: 'Cartesia voice', value: integrations.cartesia?.configured },
    { id: 'calcom', label: 'Cal.com', value: integrations.calcom?.configured },
    { id: 'supabase', label: 'Central Supabase store', value: integrations.supabase?.configured },
  ];
  const ready = checks.filter((item) => item.value).length;
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
  return <><div className="overview-grid"><section className="panel readiness-panel"><div className="panel-head"><div><div className="eyebrow">SERVICE CONFIGURATION</div><h2>Reception stack</h2></div><div className="readiness-score"><strong>{ready}<small>/4</small></strong><span>CONFIGURED</span></div></div><div className="readiness-list">{checks.map((item) => <div className="readiness-row" key={item.id}><span className={`provider-icon ${item.id}`}><i /></span><span className="provider-name">{item.label}</span><span className={`readiness-state ${item.value ? 'ok' : ''}`}><i />{item.value ? 'Configured' : 'Needs setup'}</span></div>)}</div><button className="text-link" onClick={() => go('integrations')}>Manage provider settings <ChevronRight size={15} /></button></section><section className="panel test-panel"><div className="eyebrow">BROWSER TEST</div><div className="test-visual"><div className="test-orbit"><Mic2 size={24} /></div><div className="test-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div><h2>Try a conversation</h2><p>Check the greeting, audio quality, and escalation flow before phone integration.</p><button className="button secondary" onClick={() => go('voice')}>Open voice test <ChevronRight size={15} /></button></section></div>
    <section className="panel deployment-panel"><div className="panel-head"><div><div className="eyebrow">USAGE SUMMARY</div><h2>Last 30 days</h2></div><span className="mini-badge">{usage ? periodLabel : '30-day period'}</span></div>{usageLoading ? <div className="readiness-list"><div className="readiness-row"><span className="provider-name">Loading clinic usage…</span></div></div> : usageError ? <div className="alert error">{usageError}</div> : usage && usage.calls === 0 && usage.appointments === 0 && usage.escalationCount === 0 && usage.talkSeconds === 0 ? <div className="panel empty-activity"><CalendarDays size={20} /><span>No usage recorded for this period.</span></div> : usage ? <div className="readiness-list"><div className="readiness-row"><span className="provider-name">Calls</span><span className="readiness-state">{usage.calls.toLocaleString()}</span></div><div className="readiness-row"><span className="provider-name">Appointments</span><span className="readiness-state">{usage.appointments.toLocaleString()}</span></div><div className="readiness-row"><span className="provider-name">Handoffs</span><span className="readiness-state">{usage.escalationCount.toLocaleString()}</span></div><div className="readiness-row"><span className="provider-name">Talk time</span><span className="readiness-state">{talkTime(usage.talkSeconds)}</span></div></div> : null}</section>
    <section className="panel deployment-panel"><div className="panel-head"><div><div className="eyebrow">CLOUDFLARE CLINIC CONTAINER</div><h2>Agent process status</h2></div><button className="button secondary" onClick={() => void refreshDeployment()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh status'}</button></div><div className="readiness-list"><div className="readiness-row"><span className="provider-name">Agent provisioned</span><span className={`readiness-state ${deployment.provisioned ? 'ok' : ''}`}><i />{yesNo(deployment.provisioned)}</span></div><div className="readiness-row"><span className="provider-name">Container ready now</span><span className={`readiness-state ${deployment.runtimeReady ? 'ok' : ''}`}><i />{yesNo(deployment.runtimeReady)}</span></div><div className="readiness-row"><span className="provider-name">Container state</span><span className="readiness-state">{containerStateLabel(deployment.status, deployment.runtimeReady)}</span></div></div><div className="privacy-note"><ShieldCheck size={16} /><span>A provisioned clinic Container may be asleep between tests. Starting a user test sends one wake request; the active WebSocket carries the session without a background pinger.</span></div>{lifecycleNotice && <div className="alert">{lifecycleNotice}</div>}{canManage && <div className="modal-actions"><button className="button secondary" onClick={() => void resetAgent()} disabled={lifecycleBusy}>{lifecycleBusy ? 'Working…' : 'Reset/restart agent process'}</button><button className="button secondary" onClick={() => void removeAgent()} disabled={lifecycleBusy}>Remove clinic agent</button></div>}{deployment.provisioned === false && <div className="alert">No clinic Container agent is provisioned for this clinic. Ask a platform administrator to provision it.</div>}{deployment.error && <div className="alert error">Clinic Container status: {deployment.error}</div>}</section>
    <div className="section-title-row"><div><div className="eyebrow">LATEST ACTIVITY</div><h2>Recent calls</h2></div><button className="text-link" onClick={() => go('calls')}>View call history <ChevronRight size={15} /></button></div><CallTable rows={calls.slice(0, 5)} />{!calls.length && <div className="panel empty-activity"><CalendarDays size={20} /><span>No calls recorded yet. Start a browser voice test to see activity here.</span></div>}</>;
}

function ClinicSetup({ tenant, onUpdate }: { tenant: Company; onUpdate: (next: Company) => void }) {
  const config = tenant.receptionist_config as Company['receptionist_config'] & { knowledge_base?: string };
  const [greeting, setGreeting] = useState(config?.greeting || 'Thank you for calling. How can I help you today?');
  const [voiceOutputMode, setVoiceOutputMode] = useState<'native' | 'cartesia'>(config?.voice_output_mode === 'cartesia' ? 'cartesia' : 'native');
  const [knowledgeBase, setKnowledgeBase] = useState(config?.knowledge_base || '');
  const [faqs, setFaqs] = useState((config?.faqs ?? []).map((faq) => `${faq.question}\n${faq.answer}`).join('\n\n'));
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { const nextConfig = tenant.receptionist_config as typeof config; setGreeting(nextConfig?.greeting || 'Thank you for calling. How can I help you today?'); setVoiceOutputMode(nextConfig?.voice_output_mode === 'cartesia' ? 'cartesia' : 'native'); setKnowledgeBase(nextConfig?.knowledge_base || ''); setTimezone(tenant.timezone); setFaqs((nextConfig?.faqs ?? []).map((faq) => `${faq.question}\n${faq.answer}`).join('\n\n')); }, [tenant.id]);
  async function save() {
    setSaving(true); setNotice('');
    try {
      const entries = faqs.split(/\n\s*\n/).map((block) => block.split('\n').map((line) => line.trim()).filter(Boolean)).filter((lines) => lines.length >= 2).map((lines) => ({ question: lines[0], answer: lines.slice(1).join(' ') }));
      const next = await api.updateTenant(tenant.id, { timezone, receptionist_config: { ...tenant.receptionist_config, greeting, knowledge_base: knowledgeBase, voice_output_mode: voiceOutputMode, faqs: entries, transfer_enabled: true } });
      onUpdate(next); setNotice('Reception settings saved.');
    } catch { setNotice('Could not save reception settings.'); }
    finally { setSaving(false); }
  }
  return <div className="settings-layout"><section className="panel settings-main"><div className="panel-head"><div><div className="eyebrow">CALLER EXPERIENCE</div><h2>Reception instructions</h2></div><span className="mini-badge">{tenant.business_type.replaceAll('_', ' ')}</span></div><label className="field-label">Opening greeting<span>What callers hear when the assistant answers.</span></label><textarea className="textarea greeting-input" value={greeting} maxLength={800} onChange={(event) => setGreeting(event.target.value)} /><label className="field-label">Speech output<span>Gemini Live is the recommended real-time mode. Cartesia streaming TTS uses the clinic voice ID and requires a Gemini Live model that supports text output.</span></label><select className="select-field" value={voiceOutputMode} onChange={(event) => setVoiceOutputMode(event.target.value as 'native' | 'cartesia')}><option value="native">Gemini Live native speech (recommended)</option><option value="cartesia">Cartesia streaming TTS</option></select><label className="field-label">Knowledge base<span>Clinic policies, services, hours, and other reference information for the receptionist.</span></label><textarea className="textarea faq-input" value={knowledgeBase} onChange={(event) => setKnowledgeBase(event.target.value)} placeholder="Add clinic information the receptionist can use when answering caller questions." /><label className="field-label">Frequently asked questions<span>Separate each entry with a blank line. Put the question first, then the answer.</span></label><textarea className="textarea faq-input" placeholder={'Do you accept walk-ins?\nWe recommend booking ahead so we can find a time that works for you.\n\nWhat are your hours?\nPlease check the clinic website for today’s hours.'} value={faqs} onChange={(event) => setFaqs(event.target.value)} /><div className="settings-footer">{notice && <span className="inline-notice">{notice}</span>}<button className="button primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save reception setup'}</button></div></section><aside className="panel settings-aside"><div className="eyebrow">CLINIC PROFILE</div><h2>{tenant.name}</h2><label className="field-label">Clinic time zone</label><select className="select-field" value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="America/New_York">Eastern Time — New York</option><option value="America/Chicago">Central Time — Chicago</option><option value="America/Denver">Mountain Time — Denver</option><option value="America/Los_Angeles">Pacific Time — Los Angeles</option><option value="UTC">UTC</option></select><div className="privacy-note"><ShieldCheck size={16} /><span>Changes apply to the active clinic. Only clinic managers and owners can edit this setup.</span></div></aside></div>;
}

const emptyProviderFields = () => ({ geminiApiKey: '', cartesiaApiKey: '', cartesiaVoiceId: '', calcomApiKey: '', calcomEventTypeId: '', calcomEventTypeSlug: '', calcomUsername: '', calcomTeamSlug: '', accountSid: '', authToken: '', phoneNumber: '' });
type ProviderFields = ReturnType<typeof emptyProviderFields>;

function Integrations({ tenant }: { tenant: Company }) {
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [provider, setProvider] = useState('gemini');
  const [fields, setFields] = useState<ProviderFields>(emptyProviderFields());
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  async function refresh() { setStatuses(await api.integrations(tenant.id)); }
  useEffect(() => { void refresh().catch(() => setNotice('Could not load integration statuses.')); }, [tenant.id]);
  const providerInfo: Record<string, { title: string; description: string }> = {
    gemini: { title: 'Gemini Live', description: 'Realtime conversation, speech understanding, and receptionist tool selection.' },
    cartesia: { title: 'Cartesia voice', description: 'Streaming speech synthesis and the clinic’s selected receptionist voice.' },
    calcom: { title: 'Cal.com scheduling', description: 'Availability, appointment booking, rescheduling, and cancellations.' },
    twilio: { title: 'Twilio credentials', description: 'Optional credential storage only. Phone transport remains disconnected.' },
  };
  const providers = [
    { id: 'gemini', label: providerInfo.gemini.title },
    { id: 'cartesia', label: providerInfo.cartesia.title },
    { id: 'calcom', label: providerInfo.calcom.title },
    { id: 'supabase', label: 'Central Supabase store' },
    { id: 'twilio', label: providerInfo.twilio.title },
  ];
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setNotice('');
    let keyFields: string[] = [];
    let payload: Record<string, unknown> = {};
    if (provider === 'gemini') { keyFields = ['geminiApiKey']; payload = { apiKey: fields.geminiApiKey.trim() }; }
    if (provider === 'cartesia') { keyFields = ['cartesiaApiKey']; payload = { apiKey: fields.cartesiaApiKey.trim(), voiceId: fields.cartesiaVoiceId.trim() }; }
    if (provider === 'calcom') {
      keyFields = ['calcomApiKey'];
      payload = { apiKey: fields.calcomApiKey.trim(), eventTypeId: fields.calcomEventTypeId.trim() ? Number(fields.calcomEventTypeId) : null, eventTypeSlug: fields.calcomEventTypeSlug.trim(), username: fields.calcomUsername.trim(), teamSlug: fields.calcomTeamSlug.trim() };
    }
    if (provider === 'twilio') { keyFields = ['accountSid', 'authToken']; payload = { accountSid: fields.accountSid.trim(), authToken: fields.authToken.trim(), phoneNumber: fields.phoneNumber.trim() }; }
    try {
      await api.updateIntegration(tenant.id, provider, payload);
      const next = { ...fields };
      keyFields.forEach((key) => { next[key as keyof ProviderFields] = ''; });
      if (provider === 'calcom') { next.calcomEventTypeId = ''; next.calcomEventTypeSlug = ''; next.calcomUsername = ''; next.calcomTeamSlug = ''; }
      if (provider === 'cartesia') next.cartesiaVoiceId = '';
      if (provider === 'twilio') next.phoneNumber = '';
      setFields(next);
      await refresh();
      setNotice(provider === 'twilio' ? 'Credentials saved server-side only. Twilio remains disconnected.' : 'Saved securely. Secret values are not shown again.');
    } catch {
      setNotice('Could not save provider configuration. Check the fields and try again.');
    } finally { setSaving(false); }
  }
  const isConfigured = (key: string) => statuses[key]?.configured;
  const secretInput = (key: keyof ProviderFields, label: string) => <label className="form-field" key={key}><span>{label}</span><input type="password" autoComplete="new-password" value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} placeholder="Enter a new value to rotate; existing value is never shown" /></label>;
  const textInput = (key: keyof ProviderFields, label: string, placeholder?: string) => <label className="form-field" key={key}><span>{label}</span><input type="text" autoComplete="off" value={fields[key]} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} placeholder={placeholder ?? `Enter ${label.toLowerCase()}`} /></label>;
  return <div className="integrations-layout"><section className="panel provider-list"><div className="panel-head"><div><div className="eyebrow">PROVIDER CONFIGURATION</div><h2>Integration status</h2></div></div>{providers.map((item) => <button key={item.id} className={`integration-row ${provider === item.id ? 'selected' : ''}`} onClick={() => { setProvider(item.id); setNotice(''); }}><span className={`provider-icon ${item.id}`}><i /></span><span className="integration-row-text"><strong>{item.label}</strong><small>{item.id === 'supabase' ? 'Central application database connection.' : providerInfo[item.id]?.description}</small></span><span className={`readiness-state ${isConfigured(item.id) ? 'ok' : ''}`}><i />{isConfigured(item.id) ? 'Configured' : 'Needs setup'}</span></button>)}</section><section className="panel integration-form"><div className="eyebrow">CONFIGURATION</div><h2>{provider === 'supabase' ? 'Central Supabase store' : providerInfo[provider].title}</h2><p>{provider === 'supabase' ? 'Shared central storage status. This connection is managed centrally and is not rotated from this clinic form.' : providerInfo[provider].description}</p>{provider === 'supabase' ? <div className="readiness-row"><span className="provider-name">Central Supabase status</span><span className={`readiness-state ${isConfigured('supabase') ? 'ok' : ''}`}><i />{isConfigured('supabase') ? 'Configured' : 'Needs setup'}</span></div> : <>
    {provider === 'calcom' && <div className="privacy-note"><ShieldCheck size={16} /><span>Use a numeric event type ID, or an event slug with either the owner’s username or the team slug. A slug alone cannot identify a Cal.com calendar.</span></div>}
    {provider === 'twilio' && <><div className="alert">Credentials only — not connected.</div><div className="privacy-note"><ShieldCheck size={16} /><span>Credentials are stored encrypted in Supabase, but are not passed to a clinic Container. This app does not validate or use them, call Twilio, configure webhooks, route phone calls, or enable the phone transport. Twilio remains disconnected.</span></div></>}
    <form onSubmit={(event) => void save(event)}>
      {provider === 'gemini' && secretInput('geminiApiKey', 'Gemini API key')}
      {provider === 'cartesia' && <>{secretInput('cartesiaApiKey', 'Cartesia API key')}{textInput('cartesiaVoiceId', 'Cartesia voice ID')}</>}
      {provider === 'calcom' && <>{secretInput('calcomApiKey', 'Cal.com API key')}{textInput('calcomEventTypeId', 'Numeric event type ID', 'e.g. 12345')}{textInput('calcomEventTypeSlug', 'Event type slug', 'Use with a username or team slug')}{textInput('calcomUsername', 'Cal.com username')}{textInput('calcomTeamSlug', 'Cal.com team slug')}</>}
      {provider === 'twilio' && <>{secretInput('accountSid', 'TWILIO_ACCOUNT_SID')}{secretInput('authToken', 'TWILIO_AUTH_TOKEN')}{textInput('phoneNumber', 'TWILIO_PHONE_NUMBER', '+15551234567')}</>}
      <div className="form-bottom">{notice && <span className="inline-notice">{notice}</span>}<button className="button primary" disabled={saving}>{saving ? 'Saving…' : provider === 'twilio' ? 'Save credentials' : 'Save connection'}</button></div>
    </form><div className="secret-footnote"><ShieldCheck size={15} />Secret fields are blank on load; stored values are never returned or displayed.</div></>}</section></div>;
}

function CallActivity({ tenant }: { tenant: Company }) {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void api.calls(tenant.id).then(setRows).catch((cause) => setError(cause.message)); }, [tenant.id]);
  return <><div className="panel call-list-panel"><div className="panel-head"><div><div className="eyebrow">CALL HISTORY</div><h2>Recent sessions</h2></div><span className="mini-badge">{rows.length} RECORDS</span></div>{error && <div className="alert error">{error}</div>}<CallTable rows={rows} /></div><div className="privacy-note full-note"><ShieldCheck size={16} /><span>Conversation text can contain personal information. Raw browser audio is not recorded. Define retention and consent before using real patient data.</span></div></>;
}

function CallTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <div className="table-empty"><Activity size={18} /><span>No call activity yet.</span></div>;
  return <div className="table-wrap"><table><thead><tr><th>SESSION</th><th>TRANSPORT</th><th>STARTED</th><th>STATUS</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td><span className="call-id">{row.id.slice(0, 8).toUpperCase()}</span>{row.transfer_requested && <span className="transfer-tag">HANDOFF</span>}</td><td>{row.transport === 'browser' ? 'Browser test' : 'Twilio'}</td><td>{new Date(row.started_at).toLocaleString()}</td><td><span className={`call-state ${row.status === 'completed' ? 'done' : row.status === 'transfer_requested' ? 'attention' : 'live'}`}><i />{row.status.replaceAll('_', ' ')}</span></td></tr>)}</tbody></table></div>;
}

function CreateTenantModal({ onClose, onCreate }: { onClose: () => void; onCreate: (input: { name: string; slug: string; timezone: string; receptionist_config: { greeting: string; knowledge_base: string; voice_output_mode: 'native' | 'cartesia' }; integrations: { geminiApiKey: string; cartesiaApiKey: string; cartesiaVoiceId: string; calcomApiKey: string; calcomEventTypeId: number | null; calcomEventTypeSlug: string; calcomUsername: string; calcomTeamSlug: string } }) => Promise<void> }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [greeting, setGreeting] = useState('Thank you for calling. How can I help you today?');
  const [knowledgeBase, setKnowledgeBase] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [cartesiaApiKey, setCartesiaApiKey] = useState('');
  const [cartesiaVoiceId, setCartesiaVoiceId] = useState('');
  const [calcomApiKey, setCalcomApiKey] = useState('');
  const [calcomEventTypeId, setCalcomEventTypeId] = useState('');
  const [calcomEventTypeSlug, setCalcomEventTypeSlug] = useState('');
  const [calcomUsername, setCalcomUsername] = useState('');
  const [calcomTeamSlug, setCalcomTeamSlug] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  function changeName(value: string) { setName(value); setSlug(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')); }
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('');
    const hasEventId = calcomEventTypeId.trim().length > 0;
    const hasEventSlug = calcomEventTypeSlug.trim().length > 0;
    if ((hasEventId && hasEventSlug) || (hasEventId && !/^\d+$/.test(calcomEventTypeId.trim())) || (hasEventSlug && Boolean(calcomUsername.trim()) === Boolean(calcomTeamSlug.trim()))) {
      setError('Use a numeric Cal.com event type ID, or an event slug with exactly one username or team slug. You can also configure the calendar after creating the voice agent.'); setSaving(false); return;
    }
    try {
      await onCreate({
        name, slug, timezone,
        receptionist_config: { greeting, knowledge_base: knowledgeBase, voice_output_mode: 'native' },
        integrations: { geminiApiKey, cartesiaApiKey, cartesiaVoiceId, calcomApiKey, calcomEventTypeId: hasEventId ? Number(calcomEventTypeId.trim()) : null, calcomEventTypeSlug, calcomUsername, calcomTeamSlug },
      });
      setGeminiApiKey(''); setCartesiaApiKey(''); setCalcomApiKey('');
    } catch {
      setError('Could not create the clinic agent. Check the details and try again.');
      setGeminiApiKey(''); setCartesiaApiKey(''); setCalcomApiKey('');
    } finally { setSaving(false); }
  }
  const secretField = (label: string, value: string, change: (value: string) => void) => <label className="form-field"><span>{label}</span><input type="password" autoComplete="new-password" required={label === 'Gemini API key'} value={value} onChange={(event) => change(event.target.value)} placeholder={label === 'Gemini API key' ? 'Required for real-time voice' : 'Optional; configure later'} /></label>;
  return <div className="modal-backdrop" onClick={onClose}><section className="modal-card" onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><div className="eyebrow">NEW CLINIC AGENT</div><h2>Add clinic agent</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div><p>Sets up a clinic-specific Container using the shared codebase. It starts on the first user-initiated voice test and may sleep between tests. Provider secrets are submitted to the server and never prefilled in this form.</p>{error && <div className="alert error">{error}</div>}<form onSubmit={(event) => void submit(event)}><label className="form-field"><span>Clinic name</span><input required maxLength={160} value={name} onChange={(event) => changeName(event.target.value)} placeholder="e.g. Northside Dental" /></label><label className="form-field"><span>Service slug</span><input required value={slug} onChange={(event) => setSlug(event.target.value)} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="northside-dental" /></label><label className="form-field"><span>Time zone</span><select value={timezone} onChange={(event) => setTimezone(event.target.value)}><option value="America/New_York">America/New_York</option><option value="America/Chicago">America/Chicago</option><option value="America/Denver">America/Denver</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="UTC">UTC</option></select></label><label className="form-field"><span>Receptionist greeting</span><textarea required className="textarea" value={greeting} onChange={(event) => setGreeting(event.target.value)} /></label><label className="form-field"><span>Knowledge-base text</span><textarea required className="textarea" value={knowledgeBase} onChange={(event) => setKnowledgeBase(event.target.value)} placeholder="Clinic information, policies, services, and hours" /></label><div className="eyebrow">PROVIDER CREDENTIALS</div><div className="privacy-note"><ShieldCheck size={16} /><span>A Gemini API key is required. Cartesia and Cal.com can be added later.</span></div>{secretField('Gemini API key', geminiApiKey, setGeminiApiKey)}{secretField('Cartesia API key', cartesiaApiKey, setCartesiaApiKey)}<label className="form-field"><span>Cartesia voice ID</span><input value={cartesiaVoiceId} onChange={(event) => setCartesiaVoiceId(event.target.value)} placeholder="Optional; configure in Provider connections later" /></label>{secretField('Cal.com API key', calcomApiKey, setCalcomApiKey)}<div className="privacy-note"><ShieldCheck size={16} /><span>Provide either a numeric event type ID, or an event slug plus a Cal.com username or team slug. You may leave calendar selectors blank and add them later.</span></div><label className="form-field"><span>Numeric Cal.com event type ID</span><input inputMode="numeric" value={calcomEventTypeId} onChange={(event) => setCalcomEventTypeId(event.target.value)} placeholder="Use this OR the slug fields below" /></label><label className="form-field"><span>Cal.com event slug</span><input value={calcomEventTypeSlug} onChange={(event) => setCalcomEventTypeSlug(event.target.value)} /></label><label className="form-field"><span>Cal.com username</span><input value={calcomUsername} onChange={(event) => setCalcomUsername(event.target.value)} /></label><label className="form-field"><span>Cal.com team slug</span><input value={calcomTeamSlug} onChange={(event) => setCalcomTeamSlug(event.target.value)} /></label><div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={saving}>{saving ? 'Creating…' : 'Create clinic agent'}</button></div></form></section></div>;
}
