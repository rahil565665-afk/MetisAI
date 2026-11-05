# MetisAI — multi-tenant voice receptionist for dental clinics

An admin console for running one AI voice receptionist per clinic. An administrator signs in with a passcode, creates clinics, saves each clinic's provider keys, and tests the receptionist by talking to it in the browser. Everything runs on **Cloudflare, including the free Workers plan**: the console is a Worker, and each clinic's voice agent runs inside its own Durable Object, talking to Google's Gemini Live API.

- **Voice:** Gemini Live native speech, over a WebSocket held by the clinic's Durable Object. No servers, containers or Python.
- **Scheduling:** Cal.com API v2 — availability, booking, rescheduling, cancellation. Changes need the person on the call to approve the exact action in the browser.
- **Data:** each clinic has **its own Supabase project** (Postgres) for call history and appointments. You enter that project's URL and secret key when you add the clinic; the key is stored encrypted and used only by the Worker. Nothing from one clinic is stored with another's.
- **Telephony:** not implemented. Twilio fields store credentials only.

> This is a browser-tested receptionist, not a phone system, and it is not certified for healthcare compliance (HIPAA, GDPR, etc.). Do not use real patient data until you have completed your own privacy, consent and retention review.

## How it fits together

```
Browser ──HTTPS──▶ Cloudflare Worker  (src/worker/index.ts)
  │                  ├─ static dashboard (React, Workers Assets)
  │                  ├─ /api/*   Express 5 app (src/server) ──▶ the clinic's own Supabase
  │                  ├─ Registry Durable Object      (list of clinics + their encrypted keys)
  │                  ├─ LoginLimiter Durable Object  (brute-force protection)
  │                  └─ /agents/<clinicId>/ws
  │                        └─▶ ClinicAgent Durable Object  (one per clinic)
  │                               ├─▶ Gemini Live  (outbound WebSocket)
  └── microphone / speaker        ├─▶ Cal.com API
      audio over one WebSocket    └─▶ that clinic's Supabase  (call + appointment metadata)
```

A voice test opens a single WebSocket from the browser to the clinic's Durable Object. The object connects out to Gemini, relays audio both ways, runs the receptionist's tools, and goes away when the call ends. Between calls nothing runs and nothing is billed. Details are in [docs/architecture.md](docs/architecture.md).

## Deploy (free Cloudflare account)

Follow **[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)**. In short:

1. Import this repository into Cloudflare as a Worker with Workers Builds (build `pnpm build`, deploy `npx wrangler deploy`). The free plan is enough.
2. Add four secrets to the Worker (`APP_PUBLIC_URL` is its final HTTPS origin), then sign in.
3. For each clinic, create a Supabase project and run `supabase/clinic-schema.sql` in its SQL Editor once.
4. **Add clinic agent**: paste that clinic's Supabase URL and secret key, its Gemini API key and (optionally) its Cal.com details, then press **Start browser test**.

### What the free plan allows

| Limit (Workers Free) | Value | This app |
| --- | --- | --- |
| Worker + Durable Object requests | 100,000 / day each, shared | A call costs about 30 billed requests per minute of talking; a dashboard visit a few dozen. |
| Durable Object duration | 13,000 GB-s / day | About 0.13 GB-s per connected second — roughly 28 hours of calls a day. |
| CPU per HTTP request | 10 ms | Dashboard API calls are small; see *Known limits*. Voice runs in the Durable Object, which gets 30 s per message. |
| Worker size | 64 MiB uncompressed | About 1.6 MiB. |

That is plenty for testing and a handful of clinics. Calls are capped at 30 minutes and end after 3 minutes of silence (with a warning 30 seconds before either), so a forgotten browser tab cannot burn the daily allowance. Longer calls ride through Gemini's own connection limits by resuming the same conversation on a fresh connection. Numbers and caveats: [docs/architecture.md](docs/architecture.md#free-plan-budget).

## Configuration

All values are Cloudflare **Secrets** in production (`.dev.vars` for `pnpm dev:worker`, `.env` for `pnpm dev`).

| Name | Purpose |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | Sign-in passcode, 8–128 characters. |
| `DASHBOARD_SESSION_SECRET` | 32 random bytes (64 hex). Signs sessions and derives each clinic's voice-token key. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes (64 hex). Encrypts saved provider keys (AES-256-GCM). **Back it up** — losing it means re-entering every clinic's keys. |
| `APP_PUBLIC_URL` | Exact public origin, e.g. `https://metisai.<you>.workers.dev`. HTTPS, no path. |

Generate the two random keys with `openssl rand -hex 32`. The server refuses to run with a missing or malformed value rather than falling back to a default.

Optional, non-secret overrides (plain variables, only if Google renames things): `GEMINI_LIVE_MODEL` (default `models/gemini-3.8-live`) and `GEMINI_VOICE_NAME` (default `Charon`).

Per-clinic provider details — the clinic's **Supabase URL and secret key**, Gemini key, Cal.com key and event, Twilio — are entered in the console UI, not as environment variables. The console checks them when you save (it test-writes one row to the clinic's database, asks Google whether the Gemini key is accepted, and asks Cal.com for the event's availability) and tells you plainly what is wrong.

## Local development

Requires Node 22+ and pnpm 11.

```bash
pnpm install
cp .env.example .env        # fill in the values
pnpm dev                    # API on :3001, web on :3000
```

`pnpm dev` runs the API and dashboard on plain Node, so sign-in, clinic management and integrations work (the clinic list is kept in memory and forgotten when the API restarts), but voice tests need the Worker runtime. For those run `pnpm dev:worker` (copy `.dev.vars.example` to `.dev.vars` first; no Docker needed).

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck and run the unit tests. |
| `pnpm build` | Typecheck and build the dashboard into `dist/client`. |
| `pnpm types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`. |
| `pnpm deploy` | Build and deploy from your machine (needs `wrangler login`). |

## Security model

- Passcode sign-in is rate-limited per client IP in a Durable Object (8 failures per 15 minutes), compared in constant time, and issues an 8-hour signed `HttpOnly`, `SameSite=Lax`, `Secure` session cookie. There is no hard-coded fallback secret; production fails closed if one is missing.
- Mutating browser requests must come from the console's own origin.
- Provider keys (including each clinic's Supabase secret key) are encrypted before storage, bound to their clinic as authenticated data, never returned to the browser, and decrypted only when needed. The Gemini key travels to Google in a request header, never in a URL. Public Supabase keys (anon / publishable) are refused.
- Browsers connect to a clinic's agent with a 3-minute token signed with a key derived for that clinic only; a token for one clinic is rejected by every other clinic. The agent also checks the browser `Origin`. The token travels in the WebSocket subprotocol header, not the URL, so it does not appear in request logs.
- Booking, rescheduling and cancelling require an explicit click in the browser. Spoken consent never counts, silence counts as "no", and a reschedule or cancel is offered only if the supplied email matches the booking's attendee.
- Audio, transcripts and caller identity are not stored. Call logs are metadata only; appointment records can include the attendee's name and email, and live in the clinic's own Supabase project.

## Project layout

| Path | Contents |
| --- | --- |
| `src/client/` | React dashboard, and `voice/` — the browser microphone, resampler and player. |
| `src/server/` | Express API: auth, clinics, integrations, voice tokens; `registry/` is the clinic list. |
| `src/worker/` | Worker entry, `ClinicAgent`, `Registry` and `LoginLimiter` Durable Objects, token helpers. |
| `src/worker/voice/` | The receptionist: Gemini Live protocol, call session, Cal.com client, approval gate. |
| `src/shared/` | The browser ↔ agent message protocol. |
| `supabase/clinic-schema.sql` | The tables each clinic's own Supabase project needs. Run once per clinic. |
| `docs/` | Architecture, deployment guide, provider references. |

## Known limits

- **Not tested against live providers.** The whole call path has been run end to end in the local Workers runtime and a real Chrome with a fake microphone, against stand-ins for Gemini, Cal.com and Supabase. It has not been run against the real Gemini Live service, so confirm the model name, key access and voice quality with a real test call after you deploy.
- **Dashboard CPU on the free plan is unmeasured.** Free Workers allow 10 ms of CPU per HTTP request, and local runs cannot enforce or measure that. The API does little work per request, but if a page ever fails with Cloudflare error 1102, that limit is the cause; moving to Workers Paid ($5/month) raises it.
- One live test call per clinic at a time. A deploy or Cloudflare restart can drop a call in progress; the browser shows the call as ended.
- Voices are Gemini's built-in voices only (Cartesia support from the earlier container version was removed).
- The knowledge base is plain text and FAQs. Uploaded documents, embeddings and vector search are not implemented.
- Human hand-off in the browser raises a logged escalation event; it does not dial a phone.
- The list of clinics and their encrypted keys live in a Durable Object (free SQLite-backed storage), not in Supabase. It is small and strongly consistent, but it is one place: if you delete the Worker, the clinic list goes with it, so keep a note of each clinic's settings.
- A clinic whose Supabase project is unreachable still takes calls; its call history is just not saved until the connection works again (the console says so on the Overview and Call activity pages).
- Earlier versions kept every clinic in one central Supabase database. That data is not migrated: recreate the clinic, and the old central tables can be deleted from that project.
