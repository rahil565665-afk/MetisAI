// Browser checks in Chrome with a fake microphone: the create dialog, integrations, a booking call, call activity.
// Run through `node e2e/run.mjs ui`.
import { chromium } from '../lib/deps.mjs';
import { SHOTS } from '../lib/stack.mjs';
const BASE = 'http://127.0.0.1:8799';
const OUT = process.argv[2] || SHOTS;
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); if (!ok) failed += 1; };
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1280, height: 560 } });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(BASE);
  await page.locator('input[type=password]').fill('e2e-passcode-123');
  await page.locator('form button').first().click();
  await page.getByRole('button', { name: /Add clinic agent/ }).first().waitFor();

  console.log('--- create-clinic dialog on a short screen');
  await page.getByRole('button', { name: /Add clinic agent/ }).first().click();
  const card = page.locator('.modal-card');
  await card.waitFor();
  const m = await card.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
  check('the dialog is taller than the screen, so it must scroll', m.scroll > m.client, JSON.stringify(m));
  check('the page behind is locked', await page.evaluate(() => document.body.style.overflow) === 'hidden');
  const pageBefore = await page.evaluate(() => [window.scrollY, document.querySelector('.content-scroll')?.scrollTop ?? 0]);
  await card.hover();
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(300);
  const after = await card.evaluate((el) => el.scrollTop);
  const pageAfter = await page.evaluate(() => [window.scrollY, document.querySelector('.content-scroll')?.scrollTop ?? 0]);
  check('scrolling over the dialog scrolls the dialog', after > 300, `scrollTop ${after}`);
  check('and not the page behind it', JSON.stringify(pageBefore) === JSON.stringify(pageAfter), `${pageBefore} -> ${pageAfter}`);
  await card.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const submit = page.getByRole('button', { name: 'Create clinic agent' });
  const box = await submit.boundingBox();
  check('the Create button can be scrolled into view', box && box.y >= 0 && box.y + box.height <= 560, JSON.stringify(box));
  await page.screenshot({ path: `${OUT}/modal-bottom.png` });
  await card.evaluate((el) => { el.scrollTop = 0; });

  console.log('--- creating a clinic through the dialog');
  const clinicName = `UI Dental ${Math.floor(Math.random() * 9000 + 1000)}`;
  await page.getByLabel('Clinic name').fill(clinicName);
  await page.getByLabel('Supabase project URL').fill('http://127.0.0.1:9921');
  await page.getByLabel(/Supabase secret key/).fill('sb_secret_e2e_clinic_one_key_000000001');
  await page.getByLabel(/Gemini API key/).fill('e2e-gemini-key');
  await page.getByLabel(/Cal\.com API key/).fill('cal_live_good');
  await page.getByLabel(/Cal\.com event link/).fill('https://cal.com/rahil-fjf4vl/30min');
  await submit.click();
  await page.locator('.modal-card').waitFor({ state: 'detached', timeout: 15000 });
  check('creating with the right key closes the dialog and unlocks the page', await page.evaluate(() => document.body.style.overflow) === '');
  await page.locator('.created-banner').waitFor();
  check('no warnings when everything is right', (await page.locator('.created-banner li').count()) === 0);
  await page.locator('.nav-item', { hasText: 'Clinic setup' }).click();
  await page.getByText('Reception instructions').waitFor();

  console.log('--- integrations');
  await page.locator('.nav-item', { hasText: 'Integrations' }).click();
  await page.locator('.integration-row', { hasText: 'Clinic Supabase database' }).waitFor();
  const rows = await page.locator('.integration-row strong').allInnerTexts();
  check('the list has Gemini, Cal.com, the clinic database and Twilio', JSON.stringify(rows) === JSON.stringify(['Gemini Live', 'Cal.com scheduling', 'Clinic Supabase database', 'Twilio credentials']), JSON.stringify(rows));
  await page.locator('.integration-row', { hasText: 'Cal.com scheduling' }).click();
  const labels = await page.locator('.integration-form .form-field > span').allInnerTexts();
  check('Cal.com asks for a key, a link and an ID only', JSON.stringify(labels) === JSON.stringify(['Cal.com API key', 'Event link', 'Or numeric event type ID']), JSON.stringify(labels));
  check('and shows the event already saved', /Current event: rahil-fjf4vl\/30min/.test(await page.locator('.integration-form .privacy-note').innerText()));
  await page.getByLabel('Event link').fill('https://cal.com/rahil-fjf4vl');
  await page.getByLabel('Or numeric event type ID').fill('7768457');
  await page.locator('.integration-form button.primary').click();
  await page.locator('.inline-notice').waitFor();
  const notice = await page.locator('.inline-notice').innerText();
  check('the screenshot\'s combination saves, and says what was used', /Saved/.test(notice) && /7768457/.test(notice), notice);
  await page.getByLabel('Cal.com API key').fill('cal_live_wrong');
  await page.locator('.integration-form button.primary').click();
  await page.waitForFunction(() => /rejected that API key/.test(document.querySelector('.inline-notice')?.textContent ?? ''), null, { timeout: 8000 });
  check('a wrong key shows its own reason, not the old generic text', !/Check the fields/.test(await page.locator('.inline-notice').innerText()), await page.locator('.inline-notice').innerText());
  await page.locator('.integration-row', { hasText: 'Clinic Supabase database' }).click();
  const dbLabels = await page.locator('.integration-form .form-field > span').allInnerTexts();
  check('the database form asks for a URL and a secret key', JSON.stringify(dbLabels) === JSON.stringify(['Supabase project URL', 'Supabase secret key']), JSON.stringify(dbLabels));
  await page.getByLabel('Supabase project URL').fill('http://127.0.0.1:9923');
  await page.getByLabel('Supabase secret key').fill('sb_secret_e2e_clinic_three_key_0000003');
  await page.locator('.integration-form button.primary').click();
  await page.waitForFunction(() => /clinic-schema\.sql/.test(document.querySelector('.inline-notice')?.textContent ?? ''), null, { timeout: 8000 });
  check('a project without tables says to run the SQL file', true);
  check('and is shown as needing attention rather than blocked', (await page.locator('.integration-row', { hasText: 'Clinic Supabase database' }).locator('.readiness-state').innerText()).trim() === 'Needs attention');
  await page.getByLabel('Supabase project URL').fill('http://127.0.0.1:9921');
  await page.getByLabel('Supabase secret key').fill('sb_secret_e2e_clinic_one_key_000000001');
  await page.locator('.integration-form button.primary').click();
  await page.waitForFunction(() => /Connected/.test(document.querySelector('.inline-notice')?.textContent ?? ''), null, { timeout: 15000 });

  console.log('--- overview');
  await page.locator('.nav-item', { hasText: 'Overview' }).click();
  await page.getByText('Reception stack').waitFor();
  await page.waitForFunction(() => /2\s*\/\s*3/.test(document.querySelector('.readiness-score strong')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
  const score = (await page.locator('.readiness-score strong').innerText()).replace(/\s+/g, '');
  check('the stack counts two providers as working (Cal.com has the wrong key saved above)', score === '2/3', score);
  check('and says what is wrong with Cal.com', /Cal\.com:.*rejected that API key/.test(await page.locator('.alert.warn').first().innerText()), await page.locator('.alert.warn').first().innerText());
  check('and names the clinic database', (await page.locator('.readiness-list').first().innerText()).includes('Clinic Supabase database'));

  console.log('--- put the Cal.com key right, so a call can really book');
  await page.locator('.nav-item', { hasText: 'Integrations' }).click();
  await page.locator('.integration-row', { hasText: 'Cal.com scheduling' }).click();
  await page.getByLabel('Cal.com API key').fill('cal_live_good');
  await page.locator('.integration-form button.primary').click();
  await page.waitForFunction(() => /Saved/.test(document.querySelector('.inline-notice')?.textContent ?? '') && !/not working/.test(document.querySelector('.inline-notice')?.textContent ?? ''), null, { timeout: 8000 });
  check('a correct key saves with no warning', true);

  console.log('--- a voice test survives the service moving the call');
  await fetch('http://127.0.0.1:9912/__reset');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.nav-item', { hasText: 'Voice test' }).click();
  await page.getByRole('button', { name: /Start browser test/ }).click();
  await page.getByText(/Thank you for calling Northside Dental|How can I help you today/).first().waitFor({ timeout: 20000 });
  await page.locator('.call-checks').waitFor({ timeout: 10000 });
  const checks = await page.locator('.call-checks').innerText();
  check('the page says booking is ready', /Booking: ready/.test(checks), checks);
  check('and that this call is being recorded', /being recorded in Call activity/.test(checks), checks);
  await page.getByRole('dialog').waitFor({ timeout: 20000 });
  const dialogText = await page.getByRole('dialog').innerText();
  check('the approval shows the confirmed name, phone and email', /Ada Lovelace/.test(dialogText) && /\+14155550123/.test(dialogText) && /ada@example\.com/.test(dialogText), dialogText.replace(/\s+/g, ' '));
  const spokenReadBack = await page.locator('.transcript-line', { hasText: 'Let me read that back' }).first().innerText();
  check('the receptionist read the email back letter by letter before the approval', /a, d, a, at, e, x, a, m, p, l, e, dot, c, o, m/.test(spokenReadBack), spokenReadBack.replace(/\s+/g, ' '));
  check('and the caller\'s yes is in the transcript', (await page.locator('.transcript-line.user', { hasText: 'Yes, that is all correct' }).count()) >= 1);
  await page.getByRole('button', { name: /Approve action/ }).click();
  await page.getByText(/Your appointment is booked/).first().waitFor({ timeout: 15000 });
  check('greeting, approval and booking work as before', true);
  await page.waitForTimeout(1500);
  const trigger = async (mode) => (await fetch(`http://127.0.0.1:9912/__trigger?mode=${mode}`)).text();
  const lines = () => page.locator('.transcript-line', { hasText: 'still here after the reconnect' }).count();
  await trigger('goaway');
  await page.waitForFunction(() => (document.body.innerText.match(/still here after the reconnect/g) ?? []).length >= 1, null, { timeout: 15000 });
  check('after a goAway the call carries on with a fresh connection', await lines() >= 1);
  check('without an error or an ended call', (await page.locator('.voice-error.error').count()) === 0 && !(await page.locator('.call-state').innerText()).match(/ended/i), await page.locator('.call-state').innerText());
  await page.waitForTimeout(1500);
  await trigger('drop');
  await page.waitForFunction(() => (document.body.innerText.match(/still here after the reconnect/g) ?? []).length >= 2, null, { timeout: 20000 });
  check('after the connection is cut the call resumes by itself', await lines() >= 2);
  check('and still shows no error', (await page.locator('.alert.error').count()) === 0);
  await page.screenshot({ path: `${OUT}/resumed.png` });
  await page.getByRole('button', { name: /End test call/ }).click();
  await page.getByText('Call ended', { exact: false }).first().waitFor({ timeout: 10000 });
  check('ending the call works', true);
  await page.waitForFunction(() => /saved to Call activity/.test(document.querySelector('.call-checks')?.textContent ?? ''), null, { timeout: 10000 });
  check('and the page confirms the call was saved to Call activity', true, await page.locator('.call-checks').innerText());

  console.log('--- the call appears in Call activity, with what happened and what was said');
  await page.locator('.nav-item', { hasText: 'Call activity' }).click();
  await page.locator('.call-list-panel tbody tr').first().waitFor({ timeout: 10000 });
  const firstRow = await page.locator('.call-list-panel tbody tr').first().innerText();
  check('the test call is listed, with the caller and the booking', /Ada Lovelace/.test(firstRow) && /Booked Ada Lovelace/.test(firstRow), firstRow.replace(/\s+/g, ' '));
  await page.locator('.call-list-panel tbody tr').first().getByRole('button', { name: 'Details' }).click();
  await page.locator('.call-detail').waitFor({ timeout: 10000 });
  const detail = await page.locator('.call-detail').innerText();
  check('opening it shows what the receptionist did', /WHAT THE RECEPTIONIST DID/.test(detail) && /Booked Ada Lovelace/.test(detail), detail.replace(/\s+/g, ' ').slice(0, 200));
  check('and the conversation, including the confirmation', /CONVERSATION/.test(detail) && /Yes, that is all correct/.test(detail) && /Is all of that correct/.test(detail), detail.replace(/\s+/g, ' ').slice(0, 400));
  await page.screenshot({ path: `${OUT}/call-detail.png` });

  console.log('--- responsive Overview screenshots: data, empty database, and database not connected');
  await page.locator('.nav-item', { hasText: 'Overview' }).click();
  await page.locator('.usage-summary').waitFor();
  await page.waitForFunction(() => document.querySelector('.usage-stats')?.children.length === 4, null, { timeout: 10000 });
  const states = [{ name: 'with-data', id: await page.getByLabel('Choose active clinic').inputValue() }];
  const additional = await page.evaluate(async () => {
    const create = async (name, integrations) => {
      const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, timezone: 'UTC', integrations }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Could not create screenshot fixture (${response.status})`);
      return body.tenant.id;
    };
    return {
      empty: await create('Overview Empty Fixture', { supabaseUrl: 'http://127.0.0.1:9922', supabaseSecretKey: 'sb_secret_e2e_clinic_two_key_000000002' }),
      disconnected: await create('Overview Disconnected Fixture', {}),
    };
  });
  states.push({ name: 'empty', id: additional.empty }, { name: 'disconnected', id: additional.disconnected });
  await page.reload();
  await page.locator('.nav-item', { hasText: 'Overview' }).waitFor();
  const widths = [1440, 1280, 1024, 768, 390];
  for (const state of states) {
    await page.getByLabel('Choose active clinic').selectOption(state.id);
    await page.locator('.usage-summary').waitFor();
    if (state.name === 'with-data') {
      await page.waitForFunction(() => document.querySelector('.usage-stats')?.children.length === 4, null, { timeout: 10000 });
      check('the four usage stats are rendered as readable tiles', await page.locator('.usage-stat').count() === 4);
      check('stat values use large readable text', await page.locator('.usage-stat-value').evaluateAll((nodes) => nodes.every((node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 20)));
    } else if (state.name === 'empty') {
      await page.getByText('No usage recorded for this period.').waitFor();
    } else {
      await page.getByText(/database is not connected, so there is no usage to show/).waitFor();
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const layout = await page.evaluate(() => {
        const bar = document.querySelector('.tenant-context');
        const pill = bar?.querySelector('.pill');
        const summary = document.querySelector('.usage-summary');
        const bounds = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        return { bar: bar && bounds(bar), pill: pill && bounds(pill), summary: summary && bounds(summary), width: innerWidth, pageWidth: document.body.scrollWidth, rootOverflow: getComputedStyle(document.documentElement).overflowX };
      });
      check(`${state.name} ${width}px has no horizontal page overflow`, layout.pageWidth <= width && layout.rootOverflow === 'hidden', `${layout.pageWidth}/${width}, root overflow ${layout.rootOverflow}`);
      check(`${state.name} ${width}px keeps the active status pill inside its bar`, Boolean(layout.bar && layout.pill && layout.pill.right <= layout.bar.right + 1 && layout.pill.left >= layout.bar.left - 1), JSON.stringify({ bar: layout.bar, pill: layout.pill }));
      if (state.name === 'with-data') {
        const tiles = await page.locator('.usage-stat').evaluateAll((nodes) => nodes.map((node) => {
          const card = node.getBoundingClientRect();
          const value = node.querySelector('.usage-stat-value').getBoundingClientRect();
          const label = node.querySelector('.usage-stat-label').getBoundingClientRect();
          return value.left >= card.left && value.right <= card.right && label.left >= card.left && label.right <= card.right && value.bottom <= card.bottom && label.bottom <= card.bottom;
        }));
        check(`${width}px keeps every stat value and label within its tile`, tiles.length === 4 && tiles.every(Boolean));
      }
      await page.locator('.app-shell').screenshot({ path: `${OUT}/overview-${state.name}-${width}x900.png` });
    }
    if (state.name === 'with-data') {
      await page.setViewportSize({ width: 1280, height: 560 });
      await page.screenshot({ path: `${OUT}/overview-${state.name}-1280x560-viewport.png` });
      await page.locator('.app-shell').screenshot({ path: `${OUT}/overview-${state.name}-1280x560-full.png` });
    }
  }
  const setups = (await (await fetch('http://127.0.0.1:9912/__state')).json()).setups;
  console.log('gemini setups:', JSON.stringify(setups));
  check('the first connection asked for resumption + compression, later ones resumed with a handle', setups.length >= 3 && setups[0].resumeHandle === null && setups[0].resumption && setups[0].compression && setups.slice(1).every((s) => /^handle-/.test(s.resumeHandle)), '');
  console.log('console problems:', logs.filter((l) => !/Download the React DevTools|fonts\.googleapis|ERR_TUNNEL_CONNECTION_FAILED/.test(l)).join('\n') || '(none)');
  await browser.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); }).then(() => process.exit(failed ? 1 : 0));
