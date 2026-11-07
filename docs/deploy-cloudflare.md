# Deploying to Cloudflare (free plan)

This deploys the whole application — dashboard, API and per-clinic voice agents — as one Cloudflare Worker with Durable Objects, using Workers Builds (Cloudflare builds and deploys on every push to `main`). Nothing here needs Docker, Containers or a paid plan.

## 0. What you need

- A **Cloudflare account** (the free Workers plan is enough).
- Per clinic, entered in the console later and not here: a **Supabase project** of its own (the free tier is fine), a **Gemini API key** (required; create it in Google AI Studio with Live API access) and optionally a Cal.com API key and event.

## 1. Nothing to set up centrally

There is no shared database. The console keeps its clinic list and each clinic's encrypted keys inside the Worker (a Durable Object on Cloudflare's free storage), and every clinic's call history and appointments go to **that clinic's own Supabase project**, which you set up per clinic in step 4.

## 2. Create the Worker from this repository

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** and choose `rahil565665-afk/MetisAI`, branch `main`.
2. **Worker name: `metisai`.** It must match `name` in `wrangler.jsonc`, otherwise Workers Builds reports a name mismatch. A Worker cannot be renamed, so to use another name, change `name` in `wrangler.jsonc` and commit before the first build.
3. Build settings:
   - Build command: `pnpm build`
   - Deploy command: `npx wrangler deploy`
   - Root directory: leave empty.
4. Save and deploy. The build typechecks, builds the dashboard and deploys the Worker, creating the three Durable Object classes (`ClinicAgent`, `Registry`, `LoginLimiter`) on the way. The first deploy takes a minute or two.

Notes:

- The Worker is minified at deploy time (`"minify": true` in `wrangler.jsonc`) to keep its startup time well under the Free plan's one-second limit.
- The first deploy succeeds without secrets, but sign-in will not work until step 3.
- All three Durable Object classes use SQLite storage, which is the only kind the Free plan supports; the migration in `wrangler.jsonc` already says so.

## 3. Add the secrets

Worker → **Settings → Variables and Secrets → Add**, type **Secret** (use *runtime* variables, not *build* variables). Four secrets are needed:

| Name | Value |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | A long passphrase of your choice (8–128 characters). |
| `DASHBOARD_SESSION_SECRET` | Output of `openssl rand -hex 32`. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | A *different* output of `openssl rand -hex 32`. Store a copy in your password manager. |
| `APP_PUBLIC_URL` | The Worker's exact origin, e.g. `https://metisai.<your-subdomain>.workers.dev` (or your custom domain). HTTPS, no trailing slash or path. |

Equivalent from a terminal: `npx wrangler secret put DASHBOARD_ADMIN_PASSCODE` (and so on).

Secrets are kept across deployments. `wrangler.jsonc` only sets the non-secret `NODE_ENV=production`; do not add secrets there.

Optional plain-text variables (Settings → Variables, type **Text**), only if Google changes the Live API: `GEMINI_LIVE_MODEL` (default `models/gemini-3.8-live`) and `GEMINI_VOICE_NAME` (default `Charon`). Invalid values are ignored with the default used instead.

## 4. Sign in and create a clinic

1. In Supabase, create a project for the clinic. Open **SQL Editor → New query**, paste the whole of `supabase/clinic-schema.sql` from this repository, and **Run** it (safe to run again). Then copy the project's URL (`https://<ref>.supabase.co`) and its **secret** key from *Project Settings → API Keys* (it starts `sb_secret_`; an older project's `service_role` key also works). Never use the publishable / anon key; the console will not store it. A project that already has tables from an earlier version works as it is: the Worker repairs the old link when it first needs to.
2. Open the Worker URL and sign in with `DASHBOARD_ADMIN_PASSCODE`.
3. **Add clinic agent**: only the clinic's name is required. Optionally add the greeting, a PDF as the knowledge base (services, prices, hours, policies; its text is read in your browser and the first 60,000 characters are used), the clinic's Supabase URL and secret key, and its Gemini API key. For scheduling, add the Cal.com API key and either the event's link (for example `https://cal.com/your-name/30min`) or its numeric event type ID. Nothing here can stop the clinic being created: each value is saved and checked, and anything that is wrong is listed after the clinic appears, marked **Needs attention** under Integrations, so you can correct it there.
4. Open the clinic and press **Start browser test**, allow the microphone, and talk. The receptionist greets you first. Use headphones — with speakers, the microphone can pick up the assistant and make it interrupt itself.

## What the free plan covers

Cloudflare's Workers Free limits that matter here (confirm current figures on Cloudflare's [limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) pages):

| Limit | Free allowance | Effect |
| --- | --- | --- |
| Requests | 100,000 / day for Workers and 100,000 / day for Durable Objects | A minute of talking is about 30 billed Durable Object requests (audio chunks are 100 ms; incoming WebSocket messages count 1 in 20). |
| Durable Object duration | 13,000 GB-s / day | About 7.7 GB-s a minute of call, so roughly 28 hours of calls a day. |
| CPU | 10 ms per HTTP request; 30 s per Durable Object message | Dashboard requests must be cheap; voice work happens in the Durable Object. |
| Size / startup | 64 MiB uncompressed, 1 s startup | The bundle is about 1.6 MiB minified. |

Roughly 3,000 call-minutes a day by request count — shared with dashboard use. Each test call stops after 30 minutes, or after 3 minutes with no speech from either side; you get a warning 30 seconds before either. When a daily allowance runs out, Cloudflare rejects requests until 00:00 UTC; paying for Workers Paid ($5/month) lifts the limits without any change to this project.

## Operating notes

- **Changing a provider key** — save it in the clinic's integrations. A call in progress is ended; the next test uses the new key.
- **Remove clinic agent** deletes the clinic's stored provider keys (including its Supabase credentials) and marks it unprovisioned; add a Gemini key again to re-provision. The call history in the clinic's own Supabase project is untouched.
- **Locked out?** After 8 wrong passcodes an address is blocked for up to 15 minutes, even if the next attempt is correct. Changing the `DASHBOARD_ADMIN_PASSCODE` secret takes effect immediately for new sign-ins.
- **Rotating `DASHBOARD_SESSION_SECRET`** signs everyone out and rotates every clinic's voice key; no other action is needed.
- **Rotating `TENANT_CREDENTIALS_ENCRYPTION_KEY`** makes existing saved provider keys undecryptable. Re-enter each clinic's keys afterwards.
- **Logs**: Worker → *Observability* → Logs. Voice calls log only status codes and error classes; they never log audio, transcripts, keys or provider error text.
- **Deploys during a call** can drop it. The browser shows the call as ended; start a new test.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Build fails with a name mismatch | The Worker's name in the dashboard differs from `name` in `wrangler.jsonc` (currently `metisai`). Rename the config value to match, since a Worker cannot be renamed. |
| Sign-in says the passcode is invalid | `DASHBOARD_ADMIN_PASSCODE` is not set as a Worker secret, or was set as a *build* variable. |
| Sign-in or saving a clinic returns "server is not configured" | One of the four secrets is missing or malformed (`APP_PUBLIC_URL` with a path, keys not 64 hex characters). |
| Every state-changing request returns 403 | `APP_PUBLIC_URL` does not exactly match the origin you are browsing. |
| The voice test shows "Add a Gemini API key" | The clinic has no Gemini key saved, or the key was removed. |
| The voice test says the Gemini service refused the connection | The key is invalid, lacks Live API access, or the configured model name is not available to it. Check the key in Google AI Studio, then `GEMINI_LIVE_MODEL`. |
| The voice test says a test is already running | Another browser tab (or a call that has not timed out) is using this clinic. Close the other tab, or press **End call in progress** in the clinic's *Agent status* panel; an abandoned call also ends by itself after 3 minutes of silence. |
| Some pages return Cloudflare error 1102 ("exceeded resource limits") | The Free plan's 10 ms CPU limit per request was hit. Retry once; if it persists, upgrade to Workers Paid. |
| Everything returns an error late in the day | The daily Free-plan request allowance is used up; it resets at 00:00 UTC. |
| A clinic's keys can no longer be read after a deploy | `TENANT_CREDENTIALS_ENCRYPTION_KEY` was changed or lost. |
| The clinic was created but Supabase shows *Needs attention*: missing its tables | `supabase/clinic-schema.sql` has not been run in that clinic's Supabase project. Run it, then press **Save connection** again. |
| The clinic was created but Supabase shows *Needs attention*: link from an earlier version | The project's old foreign key could not be repaired automatically (usually a restricted key). Run `supabase/clinic-schema.sql` in that project's SQL Editor, then press **Save connection** again. |
| Supabase shows *Needs attention*: rejected the secret key | The wrong key was pasted (publishable / anon, or from another project). Use the **secret** key shown under *Project Settings → API Keys*. |
| A PDF upload says no text could be read | The PDF is a scan or a set of pictures. Export a PDF with selectable text (for example from Word or Google Docs), or run OCR on it first. Password-protected PDFs must be unlocked first. |
| Cal.com says the event was not found | The link or event type ID does not belong to the account that owns the API key. |
| Call activity says the database is not connected | The clinic's Supabase URL or key stopped working. Re-enter it under **Integrations → Clinic Supabase database**. |

## Before using it with real callers

This repository has been verified by typecheck, unit tests, and an end-to-end run in the local Workers runtime and Chrome (with a fake microphone), against stand-ins for Gemini, Cal.com and Supabase. Three things can only be confirmed on your own accounts:

1. **A real Gemini Live call** — model access, voice quality, and speaker echo. Make a test call right after deploying.
2. **Real Cal.com bookings** — confirm availability, booking, rescheduling and cancellation against a test event type, using fake patient details.
3. **Dashboard CPU time on the free plan** — only Cloudflare enforces it, so use the console for a few minutes after deploying and watch for error 1102.

If an earlier version of this project exposed any provider or database keys (for example in a pasted file or chat), rotate them before going live: each clinic's Supabase secret key first, then Gemini.
