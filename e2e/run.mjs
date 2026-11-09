// Runs the end-to-end suites against the real Worker (in `wrangler dev`) and fake Gemini, Cal.com and Supabase.
//   node e2e/run.mjs            every suite
//   node e2e/run.mjs api ui     only these
// Each suite starts from a fresh stack with no saved clinics. Build the dashboard first (`pnpm build`).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { E2E, SHOTS, removeConfig, startAll, stopAll } from './lib/stack.mjs';

const SUITES = { api: 'api.mjs', ui: 'ui.mjs', 'ui-pdf': 'ui-pdf.mjs', persist: 'persist.mjs' };
const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(SUITES);
for (const name of names) {
  if (!SUITES[name]) { console.error(`Unknown suite "${name}". Choose from: ${Object.keys(SUITES).join(', ')}`); process.exit(2); }
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(E2E, 'suites', file)], {
      stdio: 'inherit',
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
try {
  for (const name of names) {
    console.log(`\n=== ${name} ${'='.repeat(Math.max(0, 60 - name.length))}`);
    await startAll({ wipe: true });
    results.push([name, await run(SUITES[name])]);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  results.push(['setup', 1]);
} finally {
  await stopAll().catch(() => undefined);
  removeConfig();
}
console.log('\n' + results.map(([name, code]) => `${code === 0 ? 'PASS' : 'FAIL'}  ${name}`).join('\n'));
console.log(`Screenshots and logs: ${path.relative(process.cwd(), path.join(E2E, '.work'))}`);
process.exit(results.some(([, code]) => code !== 0) ? 1 : 0);
