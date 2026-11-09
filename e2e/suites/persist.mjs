// Clinics must survive restarts, deploys, a wiped Worker (via backup) and a changed encryption key.
// Clinics must survive restarts, a wiped Worker (restored from a backup file) and a changed encryption key.
// Run through `node e2e/run.mjs persist`.
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket, chromium } from '../lib/deps.mjs';
import { BASE, DATABASES, DEFAULT_ENCRYPTION_KEY, PASSCODE, SHOTS, WORK, removeConfig, startAll, startWorker, stopWorker, writeConfig } from '../lib/stack.mjs';

const [{ key: K1 }, { key: K2 }] = DATABASES;
const H = { Origin: BASE, 'Content-Type': 'application/json' };
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(SHOTS, { recursive: true });

async function stopWrangler() { await stopWorker(); }
async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ passcode: PASSCODE }) });
  return { ...H, Cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}
const apiWith = (authed) => async (method, path, body) => { const r = await fetch(`${BASE}/api${path}`, { method, headers: authed, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch {} return { status: r.status, body: json, text }; };

function open(id, tok) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:8799/agents/${id}/ws`, ['dentdesk-voice-v1', `bearer.${tok}`], { headers: { Origin: BASE } });
    const events = [];
    ws.on('unexpected-response', (_q, rr) => resolve({ rejected: rr.statusCode, events }));
    ws.on('open', () => resolve({ ws, events }));
    ws.on('message', (d, bin) => { if (!bin) events.push(JSON.parse(d.toString())); });
    ws.on('close', (code) => events.push({ type: `close:${code}` }));
  });
}
async function call(api, id, ms = 1500) {
  const t = await api('POST', `/tenants/${id}/voice-token`, {});
  if (t.status !== 200) return { tokenStatus: t.status, events: [] };
  const c = await open(id, t.body.token);
  await sleep(ms);
  if (c.ws) { c.ws.send(JSON.stringify({ type: 'end' })); for (let n = 0; n < 40 && !c.events.some((e) => e.type === 'ended'); n += 1) await sleep(100); }
  return c;
}
const dump = async (port) => (await fetch(`http://127.0.0.1:${port}/__dump`)).json();

(async () => {
  console.log('--- start from nothing');
  await startAll({ wipe: true });
  let api = apiWith(await login());
  check('no clinics yet', (await api('GET', '/tenants')).body.tenants.length === 0);

  const mk = (name, db, key) => api('POST', '/tenants', { name, timezone: 'UTC', receptionist_config: { greeting: 'Hello from ' + name, knowledge_base: 'Open 8 to 5.' }, integrations: { geminiApiKey: 'e2e-gemini-key', supabaseUrl: `http://127.0.0.1:${db}`, supabaseSecretKey: key, calcomApiKey: 'cal_live_good', calcomEventTypeId: '4242' } });
  const a = (await mk('Persist One', 9921, K1)).body.tenant;
  const b = (await mk('Persist Two', 9922, K2)).body.tenant;
  check('two clinics created, agents live', a?.agent_status === 'live' && b?.agent_status === 'live');

  console.log('--- the backup file');
  let r = await api('GET', '/backup');
  const backupText = r.text;
  const backup = r.body;
  check('a backup can be downloaded', r.status === 200 && backup.app === 'metisai-clinics' && backup.companies.length === 2 && backup.secrets.length === 2, `${r.status} ${backupText.slice(0, 120)}`);
  check('it holds no readable keys', !/e2e-gemini-key|cal_live_good|sb_secret_e2e/.test(backupText));
  const backupFile = path.join(WORK, 'backup.json');
  fs.writeFileSync(backupFile, backupText);

  console.log('--- a restart (what an update does) keeps the clinics');
  await stopWrangler(); await startWorker(); api = apiWith(await login());
  let list = (await api('GET', '/tenants')).body.tenants;
  check('both clinics are still there with the same ids', list.length === 2 && list.some((t) => t.id === a.id) && list.some((t) => t.id === b.id), JSON.stringify(list.map((t) => t.name)));
  check('and keep their settings', list.find((t) => t.id === a.id).receptionist_config.greeting === 'Hello from Persist One');
  let integ = (await api('GET', `/tenants/${a.id}/integrations`)).body.integrations;
  check('their keys are still saved and readable', integ.gemini.configured && integ.calcom.configured && integ.supabase.configured && !integ.gemini.problem, JSON.stringify(integ).slice(0, 200));
  let c = await call(api, a.id);
  check('a call works after the restart and is saved', c.events.some((e) => e.type === 'ended' && e.reason === 'client') && c.events.filter((e) => e.type === 'call_info').at(-1)?.history.state === 'saved', JSON.stringify(c.events.map((e) => e.type)).slice(0, 200));

  console.log('--- a wiped Worker (new account, deleted data): restore from the backup file in the page');
  await stopWrangler(); await startWorker({ wipe: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(BASE);
  await page.locator('input[type=password]').fill('e2e-passcode-123');
  await page.locator('form button').first().click();
  await page.locator('.empty-restore').waitFor({ timeout: 15000 });
  check('with no clinics, the page offers to restore a backup', /Restore from backup/.test(await page.locator('.empty-restore').innerText()));
  await page.getByLabel('Business backup file').setInputFiles(backupFile);
  await page.locator('.tenant-switcher select').waitFor({ timeout: 15000 });
  const options = await page.locator('.tenant-switcher select option').allInnerTexts();
  check('restoring brings both clinics back', options.includes('Persist One') && options.includes('Persist Two'), JSON.stringify(options));
  api = apiWith(await login());
  list = (await api('GET', '/tenants')).body.tenants;
  check('with their original ids', list.some((t) => t.id === a.id) && list.some((t) => t.id === b.id));
  integ = (await api('GET', `/tenants/${a.id}/integrations`)).body.integrations;
  check('and their keys work again, with nothing re-entered', integ.gemini.configured && integ.supabase.configured && !integ.gemini.problem && !integ.supabase.problem, JSON.stringify(integ).slice(0, 240));
  c = await call(api, a.id);
  check('a call works on the restored clinic and is saved', c.events.some((e) => e.type === 'ended') && c.events.filter((e) => e.type === 'call_info').at(-1)?.history.state === 'saved' && c.events.some((e) => e.type === 'ready'), JSON.stringify(c.events.map((e) => e.type)).slice(0, 200));
  await page.locator('.nav-item', { hasText: 'Overview' }).click();
  const download = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.getByRole('button', { name: /Download backup/ }).click()]);
  const saved = await download[0].path();
  const downloaded = JSON.parse(fs.readFileSync(saved, 'utf8'));
  check('the Overview page downloads a fresh backup', downloaded.app === 'metisai-clinics' && downloaded.companies.length === 2 && /\.json$/.test(download[0].suggestedFilename()), download[0].suggestedFilename());
  await page.screenshot({ path: path.join(SHOTS, 'backup-overview.png'), fullPage: true });

  console.log('--- restoring again never overwrites or duplicates');
  r = await api('POST', '/backup/restore', backup);
  check('every clinic is skipped', r.status === 200 && r.body.restored === 0 && r.body.skipped === 2 && (await api('GET', '/tenants')).body.tenants.length === 2, JSON.stringify(r.body).slice(0, 200));
  r = await api('POST', '/backup/restore', { app: 'something-else', version: 1, companies: [], secrets: [] });
  check('a file that is not a backup is refused with a reason', r.status === 400 && /backup/i.test(r.body.error ?? ''), JSON.stringify(r.body));

  console.log('--- the encryption key changed (someone regenerated it): clinics are kept and can be repaired');
  await stopWrangler();
  writeConfig({ encryptionKey: 'ef'.repeat(32) });
  await startWorker(); api = apiWith(await login());
  list = (await api('GET', '/tenants')).body.tenants;
  check('both clinics are still listed', list.length === 2 && list.some((t) => t.id === a.id));
  integ = (await api('GET', `/tenants/${a.id}/integrations`)).body.integrations;
  check('their keys are marked as unreadable, with the reason and what to do', /TENANT_CREDENTIALS_ENCRYPTION_KEY/.test(integ.gemini.problem ?? '') && /Enter the key again/.test(integ.gemini.problem ?? ''), JSON.stringify(integ.gemini));
  r = await api('GET', `/tenants/${a.id}/calls`);
  check('the calls page explains it rather than showing nothing', r.body.connected === false && /Enter the key again/.test(r.body.problem ?? ''), JSON.stringify(r.body));
  c = await call(api, a.id);
  check('a call says why it cannot start', c.events.some((e) => e.type === 'error' && /Enter the key again/.test(e.message)), JSON.stringify(c.events).slice(0, 300));
  r = await api('PUT', `/tenants/${a.id}/integrations`, { provider: 'gemini', apiKey: 'e2e-gemini-key' });
  check('entering the Gemini key again repairs the clinic', r.status === 200 && !r.body.warning, JSON.stringify(r.body));
  r = await api('PUT', `/tenants/${a.id}/integrations`, { provider: 'supabase', supabaseUrl: 'http://127.0.0.1:9921', supabaseSecretKey: K1 });
  check('and so does the database key', r.status === 200 && !r.body.warning, JSON.stringify(r.body));
  r = await api('PUT', `/tenants/${a.id}/integrations`, { provider: 'calcom', apiKey: 'cal_live_good', eventTypeId: '4242' });
  integ = (await api('GET', `/tenants/${a.id}/integrations`)).body.integrations;
  check('after re-entering all three, nothing is flagged', integ.gemini.configured && integ.supabase.configured && integ.calcom.configured && !integ.gemini.problem && !integ.supabase.problem && !integ.calcom.problem, JSON.stringify(integ).slice(0, 300));
  check('the clinic kept its name and settings throughout', (await api('GET', '/tenants')).body.tenants.find((t) => t.id === a.id).receptionist_config.greeting === 'Hello from Persist One');
  c = await call(api, a.id);
  check('and calls work and are saved again', c.events.some((e) => e.type === 'ready') && c.events.filter((e) => e.type === 'call_info').at(-1)?.history.state === 'saved', JSON.stringify(c.events.map((e) => e.type)).slice(0, 200));
  console.log('console problems:', logs.filter((l) => !/fonts\.googleapis|ERR_TUNNEL_CONNECTION_FAILED/.test(l)).join('\n') || '(none)');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); failed += 1; }).finally(() => {
  writeConfig({ encryptionKey: DEFAULT_ENCRYPTION_KEY });
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
});
