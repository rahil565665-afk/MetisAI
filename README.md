# MetisAI — multi-tenant voice receptionist for dental clinics

An admin console for running one AI voice receptionist per clinic. An administrator signs in with a passcode, creates clinics, saves each clinic's provider keys, and tests the receptionist by talking to it in the browser. Everything runs on **Cloudflare, including the free Workers plan**: the console is a Worker, and each clinic's voice agent runs inside its own Durable Object, talking to Google's Gemini Live API.

- **Voice:** Gemini Live native speech, over a WebSocket held by the clinic's Durable Object. No servers, containers or Python.
- **Scheduling:** Cal.com API v2 — availability, booking, rescheduling, cancellation. Changes need the person on the call to approve the exact action in the browser.
- **Data:** Supabase (Postgres). Only the console Worker's code holds the Supabase secret key.
- **Telephony:** not implemented. Twilio fields store credentials only.

> This is a browser-tested receptionist, not a phone system, and it is not certified for healthcare compliance (HIPAA, GDPR, etc.). Do not use real patient data until you have completed your own privacy, consent and retention review.

## How it fits together

```
Browser ──HTTPS──▶ Cloudflare Worker  (src/worker/index.ts)
  │                  ├─ static dashboard (React, Workers Assets)
  │                  ├─ /api/*   Express 5 app (src/server) ──▶ Supabase
  │                  ├─ LoginLimiter Durable Object  (brute-force protection)
  │                  └─ /agents/<clinicId>/ws
  │                        └─▶ ClinicAgent Durable Object  (one per clinic)
  │                               ├─▶ Gemini Live  (outbound WebSocket)
  └── microphone / speaker        ├─▶ Cal.com API
      audio over one WebSocket    └─▶ Supabase  (call + appointment metadata)
```

A voice test opens a single WebSocket from the browser to the clinic's Durable Object. The object connects out to Gemini, relays audio both ways, runs the receptionist's tools, and goes away when the call ends. Between calls nothing runs and nothing is billed. Details are in [docs/architecture.md](docs/architecture.md).

## Deploy (free Cloudflare account)

Follow **[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)**. In short:

1. Create a Supabase project and run the three SQL files in `supabase/migrations/` in order.
2. Import this repository into Cloudflare as a Worker with Workers Builds (build `pnpm build`, deploy `npx wrangler deploy`). The free plan is enough.
3. Add six secrets to the Worker, set `APP_PUBLIC_URL` to its final HTTPS origin, then sign in.
4. Create a clinic, paste its Gemini API key, and press **Start browser test**.

### What the free plan allows

| Limit (Workers Free) | Value | This app |
| --- | --- | --- |
| Worker + Durable Object requests | 100,000 / day each, shared | A call costs about 30 billed requests per minute of talking; a dashboard visit a few dozen. |
| Durable Object duration | 13,000 GB-s / day | About 0.13 GB-s per connected second — roughly 28 hours of calls a day. |
| CPU per HTTP request | 10 ms | Dashboard API calls are small; see *Known limits*. Voice runs in the Durable Object, which gets 30 s per message. |
| Worker size | 64 MiB uncompressed | About 1.6 MiB. |

That is plenty for testing and a handful of clinics. Calls are capped at 10 minutes and end after 90 seconds of silence, so a forgotten browser tab cannot burn the daily allowance. Numbers and caveats: [docs/architecture.md](docs/architecture.md#free-plan-budget).

## Configuration

All values are Cloudflare **Secrets** in production (`.dev.vars` for `pnpm dev:worker`, `.env` for `pnpm dev`).

| Name | Purpose |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | Sign-in passcode, 8–128 characters. |
| `DASHBOARD_SESSION_SECRET` | 32 random bytes (64 hex). Signs sessions and derives each clinic's voice-token key. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes (64 hex). Encrypts saved provider keys (AES-256-GCM). **Back it up** — losing it means re-entering every clinic's keys. |
| `APP_PUBLIC_URL` | Exact public origin, e.g. `https://dentdesk-console.<you>.workers.dev`. HTTPS, no path. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SECRET_KEY` | Supabase service-role / secret key. Server-only. |

Generate the two random keys with `openssl rand -hex 32`. The server refuses to run with a missing or malformed value rather than falling back to a default.

Optional, non-secret overrides (plain variables, only if Google renames things): `GEMINI_LIVE_MODEL` (default `models/gemini-3.8-live`) and `GEMINI_VOICE_NAME` (default `Charon`).

Per-clinic provider keys (Gemini, Cal.com, Twilio) are entered in the console UI, not as environment variables.

## Local development

Requires Node 22+ and pnpm 11.

```bash
pnpm install
cp .env.example .env        # fill in the values
pnpm dev                    # API on :3001, web on :3000
```

`pnpm dev` runs the API and dashboard on plain Node, so sign-in, clinic management and integrations work, but voice tests need the Worker runtime. For those run `pnpm dev:worker` (copy `.dev.vars.example` to `.dev.vars` first; no Docker needed).

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck and run the unit tests. |
| `pnpm build` | Typecheck and build the dashboard into `dist/client`. |
| `pnpm types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`. |
| `pnpm deploy` | Build and deploy from your machine (needs `wrangler login`). |

## Security model

- Passcode sign-in is rate-limited per client IP in a Durable Object (8 failures per 15 minutes), compared in constant time, and issues an 8-hour signed `HttpOnly`, `SameSite=Lax`, `Secure` session cookie. There is no hard-coded fallback secret; production fails closed if one is missing.
- Mutating browser requests must come from the console's own origin.
- Provider keys are encrypted before storage, bound to their clinic as authenticated data, never returned to the browser, and decrypted only when a call starts. The Gemini key travels to Google in a request header, never in a URL.
- Browsers connect to a clinic's agent with a 3-minute token signed with a key derived for that clinic only; a token for one clinic is rejected by every other clinic. The agent also checks the browser `Origin`. The token travels in the WebSocket subprotocol header, not the URL, so it does not appear in request logs.
- Booking, rescheduling and cancelling require an explicit click in the browser. Spoken consent never counts, silence counts as "no", and a reschedule or cancel is offered only if the supplied email matches the booking's attendee.
- Audio, transcripts and caller identity are not stored. Call logs are metadata only; appointment records can include the attendee's name and email.

## Project layout

| Path | Contents |
| --- | --- |
| `src/client/` | React dashboard, and `voice/` — the browser microphone, resampler and player. |
| `src/server/` | Express API: auth, clinics, integrations, voice tokens. |
| `src/worker/` | Worker entry, `ClinicAgent` and `LoginLimiter` Durable Objects, token helpers. |
| `src/worker/voice/` | The receptionist: Gemini Live protocol, call session, Cal.com client, approval gate. |
| `src/shared/` | The browser ↔ agent message protocol. |
| `supabase/migrations/` | Database schema, applied in filename order. |
| `docs/` | Architecture, deployment guide, provider references. |

## Known limits

- **Not tested against live providers.** The whole call path has been run end to end in the local Workers runtime and a real Chrome with a fake microphone, against stand-ins for Gemini, Cal.com and Supabase. It has not been run against the real Gemini Live service, so confirm the model name, key access and voice quality with a real test call after you deploy.
- **Dashboard CPU on the free plan is unmeasured.** Free Workers allow 10 ms of CPU per HTTP request, and local runs cannot enforce or measure that. The API does little work per request, but if a page ever fails with Cloudflare error 1102, that limit is the cause; moving to Workers Paid ($5/month) raises it.
- One live test call per clinic at a time. A deploy or Cloudflare restart can drop a call in progress; the browser shows the call as ended.
- Voices are Gemini's built-in voices only (Cartesia support from the earlier container version was removed).
- The knowledge base is plain text and FAQs. Uploaded documents, embeddings and vector search are not implemented.
- Human hand-off in the browser raises a logged escalation event; it does not dial a phone.
- The database column `companies.render_deployment_status` (and the other `render_*` columns) come from the project's earlier Render design. They are kept so existing databases keep working: `live` means the clinic is provisioned and `not_created` means it is not. The `app_users.manus_open_id` column is likewise unused legacy schema.
