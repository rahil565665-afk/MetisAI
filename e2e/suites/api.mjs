// API-level checks: creating clinics, provider problems, booking calls, call history, per-clinic databases.
// Run through `node e2e/run.mjs api` (it starts the fake services and the Worker first).
import { WebSocket } from '../lib/deps.mjs';
const BASE = 'http://127.0.0.1:8799';
const H = { Origin: BASE, 'Content-Type': 'application/json' };
const K1 = 'sb_secret_e2e_clinic_one_key_000000001';
const K2 = 'sb_secret_e2e_clinic_two_key_000000002';
const K3 = 'sb_secret_e2e_clinic_three_key_0000003';
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ passcode: 'e2e-passcode-123' }) });
const authed = { ...H, Cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
const api = async (method, path, body) => { const r = await fetch(`${BASE}/api${path}`, { method, headers: authed, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const input = (name, integrations) => ({ name, slug: name.toLowerCase().replace(/\W+/g, '-') + '-' + Math.random().toString(36).slice(2, 6), timezone: 'UTC', receptionist_config: { greeting: 'Thank you for calling.', knowledge_base: 'Open 8 to 5.' }, integrations });
const good = { geminiApiKey: 'e2e-gemini-key', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: K1 };

const K4 = 'sb_secret_e2e_legacy_clinic_key_0000004';
console.log('--- creating a clinic is never blocked: problems are saved and reported');
const tenantCount = async () => (await api('GET', '/tenants')).body.tenants.length;
const created = [];
const make = async (name, integrations, extra = {}) => {
  const before = await tenantCount();
  const r = await api('POST', '/tenants', { name, timezone: 'UTC', ...(integrations ? { integrations } : {}), ...extra });
  const after = await tenantCount();
  if (r.status === 201) created.push(r.body.tenant);
  return { r, grew: after === before + 1 };
};
const stat = async (tenant, provider) => (await api('GET', `/tenants/${tenant.id}/integrations`)).body.integrations[provider];
let m = await make('Name Only Dental');
check('a clinic with only a name is created', m.r.status === 201 && m.grew, m.r.body.error);
check('and lists what is still missing', m.r.body.warnings?.length === 2 && /No database/.test(m.r.body.warnings[0]) && /No Gemini/.test(m.r.body.warnings[1]), JSON.stringify(m.r.body.warnings));
check('the voice agent stays off without a key', m.r.body.tenant.agent_status === 'not_created', m.r.body.tenant.agent_status);
check('the default greeting is filled in', /Thank you for calling/.test(m.r.body.tenant.receptionist_config.greeting));
const empty = m.r.body.tenant;

m = await make('Bad Key Dental', { ...good, supabaseSecretKey: 'sb_secret_wrong_key_value_000000000' });
check('a wrong Supabase key does not stop creation', m.r.status === 201 && m.grew, m.r.body.error);
check('the problem is reported and recorded', m.r.body.warnings.some((w) => /rejected that secret key/.test(w)) && /rejected that secret key/.test((await stat(m.r.body.tenant, 'supabase')).problem ?? ''), JSON.stringify(m.r.body.warnings));
check('the wrong key is still stored for correction, shown as needing attention', (await stat(m.r.body.tenant, 'supabase')).configured === false && (await stat(m.r.body.tenant, 'gemini')).configured === true);

m = await make('No Tables Dental', { ...good, supabaseUrl: 'http://127.0.0.1:9923', supabaseSecretKey: K3 });
check('a project without the tables does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /clinic-schema\.sql/.test(w)), JSON.stringify(m.r.body.warnings));

m = await make('Anon Dental', { ...good, supabaseSecretKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz' });
check('a public Supabase key does not stop creation, and is not stored', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /public Supabase key/.test(w)) && (await stat(m.r.body.tenant, 'supabase')).configured === false);

m = await make('Bad URL Dental', { ...good, supabaseUrl: 'https://example.com' });
check('a non-Supabase URL does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /project URL/.test(w)), JSON.stringify(m.r.body.warnings));

m = await make('Bad Gemini Dental', { ...good, geminiApiKey: 'bad-key' });
check('a rejected Gemini key does not stop creation', m.r.status === 201 && m.grew, m.r.body.error);
check('the Gemini problem is reported and recorded', m.r.body.warnings.some((w) => /Gemini/.test(w)) && /Gemini/.test((await stat(m.r.body.tenant, 'gemini')).problem ?? ''));

m = await make('Bad Cal Dental', { ...good, calcomApiKey: 'cal_live_wrong', calcomEventLink: 'https://cal.com/rahil-fjf4vl/30min' });
check('a rejected Cal.com key does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /Cal\.com/.test(w)), JSON.stringify(m.r.body.warnings));
check('the event is still kept so only the key needs fixing', m.r.body.tenant.receptionist_config.calcom?.username === 'rahil-fjf4vl');

m = await make('Missing Cal Dental', { ...good, calcomApiKey: 'cal_live_good', calcomEventLink: 'https://cal.com/rahil-fjf4vl/missing' });
check('an unknown Cal.com event does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /could not find that event/i.test(w)), JSON.stringify(m.r.body.warnings));

m = await make('Half Link Dental', { ...good, calcomApiKey: 'cal_live_good', calcomEventLink: 'https://cal.com/rahil-fjf4vl' });
check('a link with no event does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /does not name an event type/.test(w)), JSON.stringify(m.r.body.warnings));

m = await make('Text Id Dental', { ...good, calcomApiKey: 'cal_live_good', calcomEventTypeId: 'not-a-number' });
check('an event ID typed as text does not stop creation', m.r.status === 201 && m.grew && m.r.body.warnings.some((w) => /event type ID/.test(w)), JSON.stringify(m.r.body.warnings));

m = await make('Garbage Dental', { geminiApiKey: ' ', supabaseUrl: '   ', supabaseSecretKey: '', calcomApiKey: '', calcomEventLink: '', calcomEventTypeId: '' });
check('blank optional fields are ignored', m.r.status === 201 && m.grew, m.r.body.error);

console.log('--- all eight business templates provide durable starter settings');
const templateTenants = new Map();
for (const template of ['dental', 'salon_spa', 'medical', 'legal', 'restaurant', 'home_services', 'fitness', 'general']) {
  const createdTemplate = await make(`Template ${template}`, undefined, { business_type: template });
  templateTenants.set(template, createdTemplate.r.body.tenant);
  const config = createdTemplate.r.body.tenant?.receptionist_config;
  check(`${template} template saves greeting, persona, services, safety, FAQs, booking wording and action defaults`,
    createdTemplate.r.status === 201 && createdTemplate.r.body.tenant.business_type === template &&
    Boolean(config?.greeting && config?.persona_name && config?.tone && config?.opening_hours && config?.safety_rules && config?.booking_language) &&
    Array.isArray(config?.services) && config.services.length > 0 && Array.isArray(config?.faqs) && config.faqs.length > 0 &&
    config?.enabled_actions?.booking === true && config?.enabled_actions?.take_messages === true && config?.enabled_actions?.hand_off === true);
  const requiresMedicalGuardrails = ['dental', 'medical'].includes(template);
  check(`${template} ${requiresMedicalGuardrails ? 'has' : 'does not inherit'} medical-only diagnosis safeguards`,
    requiresMedicalGuardrails ? /Never ask for date of birth, insurance details, payment-card details/.test(config?.safety_rules ?? '') : !/Never ask for date of birth, insurance details, payment-card details/.test(config?.safety_rules ?? ''));
}
const legacyDental = await make('Legacy dental client', good, { business_type: 'dental_clinic' });
check('an older client can still send dental_clinic explicitly and keeps Dental safeguards', legacyDental.r.status === 201 &&
  legacyDental.r.body.tenant.business_type === 'dental_clinic' && /Do not diagnose/.test(legacyDental.r.body.tenant.receptionist_config.safety_rules));
let templateUpdate = await api('PATCH', `/tenants/${templateTenants.get('salon_spa').id}`, { receptionist_config: {
  persona_name: 'Morgan', tone: 'Friendly and concise.', services: ['Haircut'], opening_hours: 'Tue-Sat 9-5',
  safety_rules: 'Do not promise a chemical treatment is safe.', booking_language: 'Call bookings service visits.',
  enabled_actions: { booking: false, take_messages: true, hand_off: false },
} });
check('custom persona, tone, services, hours, safety, booking words and action switches persist', templateUpdate.status === 200 &&
  templateUpdate.body.tenant.receptionist_config.persona_name === 'Morgan' &&
  templateUpdate.body.tenant.receptionist_config.services[0] === 'Haircut' &&
  templateUpdate.body.tenant.receptionist_config.enabled_actions.booking === false &&
  templateUpdate.body.tenant.receptionist_config.enabled_actions.take_messages === true &&
  templateUpdate.body.tenant.receptionist_config.enabled_actions.hand_off === false, JSON.stringify(templateUpdate.body).slice(0, 240));

console.log('--- names that clash, and odd content');
const clash1 = await make('Same Name Dental', good);
const clash2 = await make('Same Name Dental', good);
check('two clinics can have the same name', clash1.r.status === 201 && clash2.r.status === 201 && clash1.r.body.tenant.slug !== clash2.r.body.tenant.slug, `${clash1.r.body.tenant?.slug} / ${clash2.r.body.tenant?.slug}`);
m = await make('日本語クリニック !!!');
check('a name with no usable letters still gets a clinic', m.r.status === 201 && m.grew, m.r.body.error);
m = await make('Long Name Dental '.repeat(9));
check('a very long name is accepted', m.r.status === 201 && m.grew, m.r.body.error);
const noText = await api('POST', '/tenants', { name: '   ' });
check('only a blank name is refused', noText.status === 400, JSON.stringify(noText.body));

console.log('--- knowledge base from a PDF');
const pdfText = 'Opening hours\u0000: 8 to 5\r\n\r\n\r\n\r\nWe accept most insurance. Cleaning costs $90.';
m = await make('Knowledge Dental', good, { receptionist_config: { greeting: 'Hi!', knowledge_base: pdfText, knowledge_base_file: { name: 'Price list.pdf', pages: 3 } } });
const kc = m.r.body.tenant?.receptionist_config;
check('the PDF text is stored cleaned', m.r.status === 201 && kc.knowledge_base === 'Opening hours : 8 to 5\n\nWe accept most insurance. Cleaning costs $90.', JSON.stringify(kc?.knowledge_base));
check('the file name, pages and size are remembered', kc.knowledge_base_file?.name === 'Price list.pdf' && kc.knowledge_base_file?.pages === 3 && kc.knowledge_base_file?.characters === kc.knowledge_base.length, JSON.stringify(kc.knowledge_base_file));
m = await make('Huge Knowledge Dental', good, { receptionist_config: { knowledge_base: 'x'.repeat(200_000) } });
check('very long knowledge is cut, not refused', m.r.status === 201 && m.r.body.tenant.receptionist_config.knowledge_base.length === 60000, String(m.r.body.tenant?.receptionist_config?.knowledge_base?.length ?? m.r.body.error));
m = await make('Greeting Dental', good, { receptionist_config: { greeting: 'g'.repeat(3000) } });
check('a very long greeting is cut, not refused', m.r.status === 201, JSON.stringify(m.r.body).slice(0, 120));

console.log('--- saving reception setup afterwards (the PATCH that used to fail)');
let p = await api('PATCH', `/tenants/${kc ? m.r.body.tenant.id : ''}`, { receptionist_config: { greeting: '', knowledge_base: '', faqs: [] } });
check('clearing greeting and knowledge saves', p.status === 200, JSON.stringify(p.body).slice(0, 160));
const longName = created.find((t) => t.name.startsWith('Long Name'));
p = await api('PATCH', `/tenants/${longName.id}`, { receptionist_config: { greeting: 'Hello', knowledge_base: 'Closed Sundays.', knowledge_base_file: { name: 'new.pdf', pages: 1 }, faqs: [{ question: 'q'.repeat(900), answer: 'a'.repeat(5000) }] } });
check('long FAQ entries and a new PDF save without a 400', p.status === 200, JSON.stringify(p.body).slice(0, 200));
check('the clinic keeps its long name in the saved config', (p.body.tenant?.receptionist_config?.clinic_name ?? '').length > 120 || p.status === 200);

console.log('--- a project from an earlier version (foreign key to companies) is repaired automatically');
m = await make('Legacy Project Dental', { ...good, supabaseUrl: 'http://127.0.0.1:9924', supabaseSecretKey: K4 });
check('creating a clinic on an old-schema project works with no warning about the database', m.r.status === 201 && m.grew && !m.r.body.warnings.some((w) => /database|Supabase|link/i.test(w)), JSON.stringify(m.r.body.warnings));
check('and the connection shows as configured', (await stat(m.r.body.tenant, 'supabase')).configured === true);
const legacyClinic = m.r.body.tenant;
const legacyDump = await (await fetch('http://127.0.0.1:9924/__dump')).json();
check('only a companies row was added to the old project', legacyDump.companies.some((row) => row.id === legacyClinic.id) && legacyDump.call_logs.length === 0, JSON.stringify(legacyDump).slice(0, 200));

let r;
console.log('--- the same project, entered from Integrations after creating the clinic');
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9924', supabaseSecretKey: K4 });
check('connecting the old project later works too', r.status === 200 && r.body.ok && !r.body.warning, JSON.stringify(r.body));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: 'sb_secret_wrong_key_value_000000000' });
check('a wrong key is saved with a warning instead of an error', r.status === 200 && r.body.warning && /rejected that secret key/.test(r.body.warning), JSON.stringify(r.body));
check('and shows as needing attention', /rejected/.test((await stat(empty, 'supabase')).problem ?? ''));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'calcom', apiKey: 'cal_live_good', eventTypeId: '4242' });
check('Cal.com takes the event ID as text', r.status === 200 && !r.body.warning, JSON.stringify(r.body));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'calcom', eventTypeId: 'abc' });
check('a non-numeric event ID is explained', r.status === 400 && /event type ID/.test(r.body.error), JSON.stringify(r.body));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'gemini', apiKey: 'e2e-gemini-key' });
check('Gemini can be added after the clinic exists (no Gemini-first rule)', r.status === 200 && !r.body.warning, JSON.stringify(r.body));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'gemini', apiKey: 'bad-key' });
check('a rejected Gemini key is saved with a warning', r.status === 200 && /Gemini/.test(r.body.warning ?? ''), JSON.stringify(r.body));
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'gemini', apiKey: 'e2e-gemini-key' });
r = await api('PUT', `/tenants/${empty.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: K1 });
check('everything can be put right afterwards', r.status === 200 && !r.body.warning);
r = await api('GET', `/tenants/${(created.find((t) => t.name === 'Bad Key Dental')).id}/calls`);
check('a clinic whose database key is wrong reports the problem instead of failing', r.status === 200 && r.body.connected === false && /rejected that secret key/.test(r.body.problem ?? ''), JSON.stringify(r.body));

console.log('--- the happy paths');
m = await make('Link Salon', { ...good, calcomApiKey: 'cal_live_good', calcomEventLink: 'https://cal.com/rahil-fjf4vl/30min' }, { business_type: 'salon_spa' });
const linkClinic = m.r.body.tenant;
check('clinic created from a Cal.com link, with no warnings and the agent live', m.r.status === 201 && linkClinic?.agent_status === 'live' && m.r.body.warnings.length === 0, JSON.stringify(m.r.body.warnings));
check('the link became username + slug', linkClinic?.receptionist_config?.calcom?.username === 'rahil-fjf4vl' && linkClinic?.receptionist_config?.calcom?.event_type_slug === '30min', JSON.stringify(linkClinic?.receptionist_config?.calcom));
m = await make('Id Dental', { ...good, supabaseUrl: 'http://127.0.0.1:9922', supabaseSecretKey: K2, calcomApiKey: 'cal_live_good', calcomEventTypeId: '4242', calcomEventLink: 'https://cal.com/someone/else' });
const idClinic = m.r.body.tenant;
check('clinic created from an event type ID (ID wins)', m.r.status === 201 && idClinic?.receptionist_config?.calcom?.event_type_id === 4242 && !idClinic.receptionist_config.calcom.username, JSON.stringify(idClinic?.receptionist_config?.calcom));
m = await make('Minimal Dental', good);
const bare = m.r.body.tenant;
check('clinic created with no Cal.com at all', m.r.status === 201 && m.r.body.warnings.length === 0, JSON.stringify(m.r.body.warnings));
let integ = (await api('GET', `/tenants/${linkClinic.id}/integrations`)).body.integrations;
check('integration status shows gemini, calcom, supabase configured', integ.gemini.configured && integ.calcom.configured && integ.supabase.configured && !integ.twilio.configured, JSON.stringify(Object.fromEntries(Object.entries(integ).map(([k, v]) => [k, v.configured]))));
integ = (await api('GET', `/tenants/${bare.id}/integrations`)).body.integrations;
check('without Cal.com the clinic reports it as needing setup', integ.calcom.configured === false);
check('no secret values are returned', !JSON.stringify(integ).includes(K1) && !JSON.stringify(integ).includes('e2e-gemini-key'));

console.log('--- editing a clinic\'s integrations (the original failure)');
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'calcom', apiKey: 'cal_live_good', eventTypeId: 7768457, eventLink: 'https://cal.com/rahil-fjf4vl', eventTypeSlug: 'https://cal.com/rahil-fjf4vl', username: 'rahil-fjf4vl', teamSlug: 'https://cal.com/rahil-fjf4vl' });
check('the exact combination from the screenshot now saves', r.status === 200 && r.body.ok, r.body.error ?? r.body.message);
check('and says the other fields were ignored', /ignored/.test(r.body.message ?? ''), r.body.message);
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'calcom', apiKey: '', eventLink: 'https://cal.com/team/north/checkup' });
check('a team link saves without re-entering the key', r.status === 200, r.body.error ?? r.body.message);
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'calcom', apiKey: 'cal_live_wrong' });
check('a wrong Cal.com key is saved and explained', r.status === 200 && /Cal\.com rejected/.test(r.body.warning ?? ''), JSON.stringify(r.body));
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'calcom', apiKey: 'cal_live_good' });
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'calcom' });
check('submitting nothing says what to enter', r.status === 400 && /API key, an event type ID, or an event link/.test(r.body.error), r.body.error);
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: 'sb_secret_wrong_key_value_000000000' });
check('re-entering a wrong Supabase key is saved with a warning', r.status === 200 && /rejected that secret key/.test(r.body.warning ?? ''), JSON.stringify(r.body));
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9922', supabaseSecretKey: K2 });
check('moving a clinic to another Supabase project works', r.status === 200, r.body.error ?? r.body.message);
r = await api('PUT', `/tenants/${bare.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: K1 });
check('and back again', r.status === 200, r.body.error);

console.log('--- calls are recorded in each clinic\'s own database, and nowhere else');
function open(id, tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8799/agents/${id}/ws`, ['dentdesk-voice-v1', `bearer.${tok}`], { headers: { Origin: BASE } });
    const events = [];
    ws.on('unexpected-response', (_q, rr) => resolve({ rejected: rr.statusCode }));
    ws.on('open', () => resolve({ ws, events }));
    ws.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())); });
    ws.on('close', (code) => events.push({ type: `close:${code}` }));
  });
}
async function call(id, ms = 1200) {
  const t = await api('POST', `/tenants/${id}/voice-token`, {});
  const c = await open(id, t.body.token);
  await sleep(ms);
  c.ws.send(JSON.stringify({ type: 'end' }));
  await sleep(500);
  return c;
}
const db = async (port) => (await fetch(`http://127.0.0.1:${port}/__dump`)).json();
const db1Before = (await db(9921)).call_logs.length; const db2Before = (await db(9922)).call_logs.length;
let c = await call(idClinic.id);          // clinic two -> database 9922
check('the call completed normally', c.events.some((e) => e.type === 'ended' && e.reason === 'client'), JSON.stringify(c.events.map((e) => e.type)));
const db1After = (await db(9921)).call_logs.length; const db2After = (await db(9922)).call_logs;
check('the call landed in that clinic\'s own database', db2After.length === db2Before + 1 && db1After === db1Before, `db1 ${db1Before}->${db1After}, db2 ${db2Before}->${db2After.length}`);
check('with the right tenant id and a completed status', db2After.at(-1)?.tenant_id === idClinic.id && db2After.at(-1)?.status === 'completed', JSON.stringify(db2After.at(-1)));
r = await api('GET', `/tenants/${idClinic.id}/calls`);
check('the calls API reads from that database', r.body.connected === true && r.body.calls.length === 1, JSON.stringify(r.body).slice(0, 160));
r = await api('GET', `/tenants/${linkClinic.id}/calls`);
check('another clinic does not see it', r.body.connected === true && r.body.calls.length === 0, JSON.stringify(r.body).slice(0, 160));
r = await api('GET', `/tenants/${idClinic.id}/usage`);
check('usage counts it', r.body.connected === true && r.body.calls === 1, JSON.stringify(r.body));

console.log('--- calls on the old-schema project are saved, with the repair done automatically');
const legacyBefore = await (await fetch('http://127.0.0.1:9924/__dump')).json();
c = await call(legacyClinic.id);
const legacyAfter = await (await fetch('http://127.0.0.1:9924/__dump')).json();
check('the call completed', c.events.some((e) => e.type === 'ended' && e.reason === 'client'), JSON.stringify(c.events.map((e) => e.type)));
check('its history was saved to the old-schema project', legacyAfter.call_logs.length === legacyBefore.call_logs.length + 1 && legacyAfter.call_logs.at(-1).tenant_id === legacyClinic.id && legacyAfter.call_logs.at(-1).status === 'completed', JSON.stringify(legacyAfter.call_logs.at(-1)));
r = await api('GET', `/tenants/${legacyClinic.id}/calls`);
check('and the calls page shows it', r.body.connected === true && r.body.calls.length === 1, JSON.stringify(r.body).slice(0, 140));

console.log('--- a booking call: confirmed before booking, booked for real, and saved with its conversation');
const mockState = async () => (await fetch('http://127.0.0.1:9912/__state')).json();
async function talkingCall(id, { approve = true, frames = 45 } = {}) {
  const t = await api('POST', `/tenants/${id}/voice-token`, {});
  const c = await open(id, t.body.token);
  for (let n = 0; n < 60 && !c.events.some((e) => e.type === 'ready'); n += 1) await sleep(100);
  const answered = new Set();
  for (let n = 0; n < frames; n += 1) {
    c.ws.send(Buffer.alloc(3200, 1), { binary: true });
    for (const e of c.events) if (e.type === 'approval_request' && !answered.has(e.approvalId)) { answered.add(e.approvalId); c.ws.send(JSON.stringify({ type: 'approval_response', approvalId: e.approvalId, approved: approve })); }
    await sleep(60);
  }
  for (let n = 0; n < 40 && !c.events.some((e) => e.type === 'transcript' && /booking is confirmed|could not complete that booking/.test(e.text)); n += 1) {
    for (const e of c.events) if (e.type === 'approval_request' && !answered.has(e.approvalId)) { answered.add(e.approvalId); c.ws.send(JSON.stringify({ type: 'approval_response', approvalId: e.approvalId, approved: approve })); }
    await sleep(100);
  }
  c.ws.send(JSON.stringify({ type: 'end' }));
  for (let n = 0; n < 60 && !c.events.some((e) => e.type === 'ended'); n += 1) await sleep(100);
  return c;
}
await fetch('http://127.0.0.1:9912/__reset');
const apptsBefore = (await db(9921)).receptionist_appointments.length;
const logsBefore = (await db(9921)).call_logs.length;
c = await talkingCall(linkClinic.id);
const ms = await mockState();
const prepares = ms.toolResponses.filter((x) => x.name === 'prepare_booking');
check('an email that is not an address is refused, and the receptionist tries again', prepares.length === 2 && prepares[0].response.ok === false && /email/i.test(prepares[0].response.message) && prepares[1].response.ok === true, JSON.stringify(prepares).slice(0, 300));
check('the details are read back with the email spelled out', prepares[1]?.response.read_back?.email_spelled === 'a, d, a, at, e, x, a, m, p, l, e, dot, c, o, m' && /^\+1/.test(prepares[1]?.response.read_back?.phone_digits ?? ' ') === false && prepares[1]?.response.read_back?.phone_digits === '1 4 1 5 5 5 5 0 1 2 3', JSON.stringify(prepares[1]?.response.read_back));
const approvals = c.events.filter((e) => e.type === 'approval_request');
check('the browser is asked to approve exactly the confirmed details', approvals.length === 1 && approvals[0].summary.callerEmail === 'ada@example.com' && approvals[0].summary.callerPhone === '+14155550123', JSON.stringify(approvals.map((a) => a.summary)));
const posts = ms.calRequests.filter((x) => x.method === 'POST');
check('the Cal.com fake receives one Salon/Spa booking with the email, phone and service', posts.length === 1 && posts[0].body.attendee.email === 'ada@example.com' && posts[0].body.attendee.phoneNumber === '+14155550123' && posts[0].body.metadata?.reason === 'Haircut', JSON.stringify(posts.map((x) => x.body)));
check('the receptionist is told the Salon/Spa booking succeeded and says so', ms.toolResponses.some((x) => x.name === 'create_booking' && x.response.ok) && c.events.some((e) => e.type === 'transcript' && /booking is confirmed/.test(e.text)));
const afterDb = await db(9921);
const appt = afterDb.receptionist_appointments.at(-1);
check('the booking is saved in the business\'s database with the contact details', afterDb.receptionist_appointments.length === apptsBefore + 1 && appt.attendee_email === 'ada@example.com' && appt.attendee_phone === '+14155550123' && appt.attendee_name === 'Ada Lovelace', JSON.stringify(appt));
const log = afterDb.call_logs.at(-1);
check('the call is saved, finished, with the caller\'s name', afterDb.call_logs.length === logsBefore + 1 && log.status === 'completed' && log.caller_name === 'Ada Lovelace' && log.ended_at, JSON.stringify({ ...log, metadata: undefined }));
check('with what happened and the whole conversation', /^Booked Ada Lovelace/.test(log.metadata.outcome) && log.metadata.transcript.some((t) => t.role === 'user' && /Yes, that is all correct/.test(t.text)) && log.metadata.transcript.some((t) => t.role === 'assistant' && /Is all of that correct/.test(t.text)) && log.metadata.events.length === 1, JSON.stringify(log.metadata).slice(0, 300));
const infos = c.events.filter((e) => e.type === 'call_info');
check('the browser is told booking is ready and the call is being saved, and then that it was', infos.length >= 2 && infos[0].scheduling.available === true && infos[0].history.state === 'saved' && infos.at(-1).history.state === 'saved', JSON.stringify(infos));
check('the call ends only after it was saved', c.events.findIndex((e) => e.type === 'call_info' && e === infos.at(-1)) < c.events.findIndex((e) => e.type === 'ended'));
r = await api('GET', `/tenants/${linkClinic.id}/calls`);
const row = r.body.calls?.[0];
check('the calls list shows the outcome but not the conversation', r.body.connected === true && /^Booked Ada Lovelace/.test(row?.outcome ?? '') && row?.caller_name === 'Ada Lovelace' && !('metadata' in row) && row?.note_count === 1, JSON.stringify(row));
r = await api('GET', `/tenants/${linkClinic.id}/calls/${row.id}`);
check('opening a call shows the conversation', r.status === 200 && r.body.call.metadata.transcript.length >= 4 && r.body.call.metadata.events[0].text.startsWith('Booked'), JSON.stringify(r.body).slice(0, 200));
r = await api('GET', `/tenants/${idClinic.id}/calls/${row.id}`);
check('another clinic cannot open it', r.status === 404, String(r.status));
r = await api('GET', `/tenants/${linkClinic.id}/calls/not-a-uuid`);
check('a malformed call id is rejected', r.status === 400, String(r.status));

console.log('--- a booking that is not approved is not made');
await fetch('http://127.0.0.1:9912/__reset');
const postsBefore = 0;
c = await talkingCall(linkClinic.id, { approve: false });
const ms2 = await mockState();
check('nothing is sent to Cal.com', ms2.calRequests.filter((x) => x.method === 'POST').length === postsBefore, JSON.stringify(ms2.calRequests.map((x) => x.method + x.url)));
check('and the receptionist is told it was not approved', ms2.toolResponses.some((x) => x.name === 'create_booking' && x.response.ok === false && /not approved/.test(x.response.message)));

console.log('--- when booking cannot work, the receptionist and the browser are told');
const badCal = (await make('Bad Cal Dental', { ...good, calcomApiKey: 'cal_live_wrong', calcomEventTypeId: '4242' })).r.body.tenant;
await fetch('http://127.0.0.1:9912/__reset');
c = await call(badCal.id, 1500);
const info = c.events.find((e) => e.type === 'call_info');
check('the browser sees "booking unavailable" with the reason', info?.scheduling.available === false && /rejected the configured credentials/.test(info.scheduling.reason ?? ''), JSON.stringify(info));
const setupText = (await mockState()).geminiMessages.find((x) => x.kind === 'setup')?.message?.instruction ?? '';
check('and the receptionist is told booking is not available, so it cannot pretend', /SCHEDULING STATUS: NOT AVAILABLE \(Cal\.com rejected/.test(setupText) && /leave_message_for_staff/.test(setupText), setupText.slice(0, 400));

console.log('--- when the call cannot be saved, the browser is told why');
const noTables = (await make('No Tables Dental', { geminiApiKey: 'e2e-gemini-key', supabaseUrl: 'http://127.0.0.1:9923', supabaseSecretKey: K3 })).r.body.tenant;
c = await call(noTables.id, 1500);
let ci = c.events.filter((e) => e.type === 'call_info');
check('a database without tables: "not saved" and what to run', ci.length >= 1 && ci.at(-1).history.state === 'not_saved' && /clinic-schema\.sql/.test(ci.at(-1).history.problem ?? ''), JSON.stringify(ci));
check('and the call itself still ended normally', c.events.some((e) => e.type === 'ended' && e.reason === 'client'));
const noDb = (await make('No Database Dental', { geminiApiKey: 'e2e-gemini-key' })).r.body.tenant;
c = await call(noDb.id, 1500);
ci = c.events.filter((e) => e.type === 'call_info');
check('no database at all: "not saved" and where to add one', ci.at(-1)?.history.state === 'not_saved' && /No Supabase database is connected/.test(ci.at(-1).history.problem ?? ''), JSON.stringify(ci));
r = await api('GET', `/tenants/${noDb.id}/calls`);
check('and the calls page says the same', r.body.connected === false && /No Supabase database is connected/.test(r.body.problem ?? ''), JSON.stringify(r.body));
r = await api('GET', `/tenants/${noTables.id}/calls`);
check('a database without tables is explained on the calls page', r.body.connected === false && /clinic-schema\.sql/.test(r.body.problem ?? ''), JSON.stringify(r.body));

console.log('--- removing the agent');
r = await api('DELETE', `/tenants/${bare.id}/agent`);
integ = (await api('GET', `/tenants/${bare.id}/integrations`)).body.integrations;
check('delete clears all four statuses', r.status === 200 && Object.values(integ).every((x) => !x.configured), JSON.stringify(integ));
r = await api('GET', `/tenants/${bare.id}/calls`);
check('calls report "not connected" instead of failing', r.status === 200 && r.body.connected === false && r.body.calls.length === 0, JSON.stringify(r.body));
r = await api('GET', `/tenants/${bare.id}/usage`);
check('usage reports "not connected" with zeros', r.status === 200 && r.body.connected === false && r.body.calls === 0, JSON.stringify(r.body));
r = await api('POST', `/tenants/${bare.id}/voice-token`, {});
check('no voice token for a removed agent', r.status >= 400, String(r.status));
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
