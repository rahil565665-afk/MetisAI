# End-to-end suites

These run the **real Worker** (in `wrangler dev`) and the real dashboard in Chrome, against local fakes of the three outside services, so the whole path can be exercised without keys or accounts:

| Fake | Port | What it does |
| --- | --- | --- |
| Gemini Live | 9912 | A scripted caller-facing model: greets, requests a Salon/Spa service booking with a badly transcribed email, retries with a good one, reads the details back, hears "yes", and creates the booking. |
| Cal.com | 9913 | Slots, bookings, and a good API key (`cal_live_good`); other keys get a 401. |
| Supabase (four projects) | 9921, 9922, 9923, 9924 | A small PostgREST stand-in. 9923 has no tables; 9924 has the old `companies` foreign key. |

Because they are fakes, **a pass here does not prove the real Gemini, Cal.com or Supabase accept what the code sends.** Do one real test call and booking after each deploy.

## Run

```
pnpm install
pnpm build                       # the Worker serves the built dashboard from dist/client
npm install --prefix e2e         # once: ws and playwright
npx playwright install chromium  # once, if Chrome for Playwright is not installed
pnpm e2e                         # every suite, about 3 minutes
pnpm e2e api ui                  # only some
```

Suites: `api` (creation, all eight template defaults, editable behavior/actions, provider problems, a non-dental booking call, call history), `ui` (business/template dialog, integrations, a Salon/Spa browser booking, Call activity), `ui-pdf` (PDF knowledge base), `persist` (restart, wiped Worker restored from a backup, changed encryption key).

The UI suite also captures Overview at **1440, 1280, 1024, 768, and 390 px** for populated, empty, and disconnected database states. It checks the four usage tiles and active-business status stay within the layout. A short-height 1280 × 560 capture checks the active bar separately. These screenshots are written to `e2e/.work/shots/` for visual review.

Each suite starts from a fresh stack with no businesses. Screenshots and logs go to `e2e/.work/` (not committed). The Worker's local data is kept in `e2e/.work/state`, never in your own `.wrangler/state`.

## Things to know

- It writes `.dev.vars` and `.smoke.wrangler.json` in the repository root and deletes them afterwards. If you already have a `.dev.vars`, it refuses to run rather than replace it: move yours aside first.
- Fixed ports (8799 for the Worker, 9912/9913, 9921–9924) must be free.
- It is not part of `pnpm check` or CI: it needs Chrome and a local Workers runtime.
- When you change what the receptionist says or does, update `fakes/gemini-and-calcom.mjs` so its script still matches the tools and the read-back flow.
