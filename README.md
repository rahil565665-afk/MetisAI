# Metis AI — multi-business voice receptionist builder

Metis AI is an admin console for setting up one AI voice receptionist per business. Choose a starter template—Dental, Salon/Spa, Medical, Legal, Restaurant, Home services, Fitness, or General—then tailor its greeting, persona, tone, services, hours, safety guidance, FAQs, booking language, and enabled actions. The receptionist can be tested by speaking to it in the browser.

The application runs on Cloudflare Workers, including the Free plan. Each business has its own settings, encrypted provider credentials, voice agent, and Supabase project for call history. Gemini Live provides the browser voice test; Cal.com is an optional booking integration. Phone calls are not implemented.

- **Voice:** Gemini Live native speech over a WebSocket held by the business's Durable Object.
- **Booking:** optional Cal.com API v2 integration for availability, bookings, changes, and cancellations. The caller must confirm the exact read-back and a user must approve the change in the browser.
- **Data:** each business connects its own Supabase project. Call history and booking records stay in that project; provider credentials are encrypted and used only by the Worker.
- **Telephony:** not implemented. Twilio fields store credentials only; they do not enable phone calls.

> This is a browser-tested receptionist, not a phone system, and it is not certified for healthcare or other regulatory compliance. Before using real caller information, complete your own privacy, consent, retention, and applicable compliance review.

## Create your first receptionist

Start with the short [Create your first receptionist guide](docs/first-receptionist.md). It covers choosing a template, setting the receptionist's behavior, connecting only the services you need, and testing safely.

## How it fits together

```
Browser ──HTTPS──▶ Cloudflare Worker  (src/worker/index.ts)
  │                  ├─ static dashboard (React, Workers Assets)
  │                  ├─ /api/tenants/*  Express 5 app (src/server)
  │                  ├─ Registry Durable Object (business settings + encrypted keys)
  │                  ├─ LoginLimiter Durable Object (brute-force protection)
  │                  └─ /agents/<businessId>/ws
  │                        └─▶ ClinicAgent Durable Object (one per business; legacy class name)
  │                               ├─▶ Gemini Live (outbound WebSocket)
  └── microphone / speaker        ├─▶ Cal.com API (optional)
      audio over one WebSocket    └─▶ that business's Supabase project
```

A voice test opens a WebSocket from the browser to the business's Durable Object. The object connects to Gemini, relays audio, and runs only for the duration of the call. See [docs/architecture.md](docs/architecture.md) for the trust boundaries and booking approval flow.

## Deploy on Cloudflare

Follow [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md). In short:

1. Import the repository as a Worker with Workers Builds (`pnpm build`, then `npx wrangler deploy`). The Worker name must remain `metisai`.
2. Add the four Cloudflare Secrets listed below, then sign in.
3. For each business whose call history should be saved, create its Supabase project and run `supabase/clinic-schema.sql` in that project's SQL Editor. The filename is retained for existing instructions and links.
4. Add a business from the console, choose a template, and enter provider details. Only the business name is required; a missing or rejected provider does not block creation.

## Configuration

Production values belong in Cloudflare **Secrets** (type *Secret*, not *Text*). `wrangler.jsonc` uses `keep_vars: true` so deploys do not delete dashboard variables. For local runs, use `.dev.vars` or `.env` as described in the deployment guide.

| Secret | Purpose |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | Sign-in passcode, 8–128 characters. |
| `DASHBOARD_SESSION_SECRET` | 32 random bytes (64 hex). Signs sessions and derives each business's voice-token key. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes (64 hex). Encrypts saved provider keys. Back it up and never regenerate it; if changed, provider keys must be entered again, but businesses and settings remain. |
| `APP_PUBLIC_URL` | Exact public HTTPS origin, e.g. `https://metisai.<your-subdomain>.workers.dev`, without a path. |

Generate random keys with `openssl rand -hex 32`. Optional non-secret variables are `GEMINI_LIVE_MODEL` and `GEMINI_VOICE_NAME`; defaults are documented in the Cloudflare guide.

Provider details (each business's Supabase URL and secret key, Gemini API key, optional Cal.com key/event, and unused Twilio fields) are entered in the console, not stored as environment variables. The console checks connections but saves the business even when a provider check fails, then reports what needs attention.

## Local development and checks

Requires Node 22+ and pnpm 11.

```bash
pnpm install
cp .env.example .env        # fill in local values
pnpm dev                    # API on :3001, web on :3000
```

`pnpm dev` keeps its in-memory business list only until the API restarts. Voice tests need the Worker runtime; see [e2e/README.md](e2e/README.md) for the local Worker setup.

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck and run unit tests. |
| `pnpm build` | Typecheck and build the dashboard into `dist/client`. |
| `pnpm e2e` | Run the local Worker and browser end-to-end suites against service fakes. |
| `pnpm types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`. |

The end-to-end fakes cover business creation and templates, browser booking approval, call history, responsive Overview states, restart, and backup/restore. They do not verify that real Gemini Live, Cal.com, or Supabase accepts the requests; those require a controlled test on the owner's accounts. E2E suites are not part of CI.

## Security and compatibility

- Passcode sign-in is rate-limited and issues an 8-hour signed `HttpOnly`, `SameSite=Lax`, `Secure` cookie. Mutating browser requests must come from the console's own origin.
- Provider keys are encrypted before storage, bound to the business as authenticated data, never returned to the browser, and decrypted only when needed. Public Supabase keys are refused.
- A three-minute token authorizes the browser voice test for one business only. The agent checks the browser `Origin` and token; the token is carried in a WebSocket subprotocol, not the URL.
- Booking, rescheduling, and cancellation require a caller's clear spoken confirmation of the exact read-back and a separate approval click in the browser. Disabled actions are omitted from model tools and rejected server-side.
- Raw audio is not recorded. Call transcripts and caller details may be personal information; call history is stored in the business's own Supabase project. Configure retention and consent yourself.
- The Registry and encrypted provider keys live in a SQLite-backed Durable Object, not in a central Supabase database. Downloaded backups retain the legacy `app: "metisai-clinics"` format and include encrypted keys; restoration requires the same `TENANT_CREDENTIALS_ENCRYPTION_KEY` and only adds businesses.
- Existing data contracts are deliberately retained: `/api/tenants`, the Durable Object classes `Registry`, `ClinicAgent`, and `LoginLimiter`, the encryption-context strings and WebSocket subprotocol still use their established names. Existing `call_logs` and `receptionist_appointments` tables and columns are not renamed. There is no schema migration for the template settings; they are stored additively in the existing Registry configuration.
- Requests from older clients that omit `business_type` keep the established dental default (`dental_clinic`); the new picker defaults to General. Existing dental businesses retain dental safety rules.

## Project layout

| Path | Contents |
| --- | --- |
| `src/client/` | React dashboard, voice tester, and browser microphone/audio client. |
| `src/server/` | Express API, authorization, integrations, and Registry logic. |
| `src/worker/` | Worker entry, `ClinicAgent`, `Registry`, and `LoginLimiter` Durable Objects. |
| `src/worker/voice/` | Gemini Live protocol, receptionist prompt/tools, session, Cal.com client, approval gate. |
| `src/shared/businessTemplates.ts` | The eight template defaults and helper functions. |
| `supabase/clinic-schema.sql` | Existing per-business schema; its legacy filename and table/column names are retained. |
| `docs/` | Architecture, first-receptionist guide, Cloudflare deployment, and provider references. |

## Known limits

- **Live providers have not been verified by the automated tests.** The local Worker and Chrome have been exercised against fakes, not real Gemini Live, Cal.com, or Supabase. Do a controlled test call and booking after deployment; never use real customer details in a first test.
- The Free plan's 10 ms CPU limit for HTTP requests has not been measured in production. See the architecture guide for the budget and caveats.
- One browser test call per business at a time. A deploy or Cloudflare restart can end an active call.
- The only supported voice mode is Gemini's native audio. The knowledge base is text extracted in the browser from one PDF plus FAQs; the PDF is not stored, and embeddings/vector search are not implemented.
- Staff handoff records an event in the call history; it does not transfer a phone call. Twilio phone transport is not implemented.
- A business without a connected Supabase project can still be created and tested, but its calls and messages cannot be saved to call history. With Supabase connected but no usable Cal.com scheduling, enabled non-booking actions remain available.
- Earlier versions may have used a central Supabase database; that data is not automatically migrated. Existing per-business deployments and their call/booking tables are preserved.
