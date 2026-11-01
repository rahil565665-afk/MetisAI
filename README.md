# MetisAI — multi-tenant voice receptionist for dental clinics

An admin console for running one AI voice receptionist per clinic. An administrator signs in with a passcode, creates clinics, saves each clinic's provider keys, and tests the receptionist by talking to it in the browser. Everything runs on **Cloudflare**: the console is a Worker, and each clinic's voice agent runs in its own container managed by a Durable Object.

- **Voice:** open-source [Pipecat](https://github.com/pipecat-ai/pipecat) (Python) with Gemini Live native speech. Cartesia streaming TTS is an optional per-clinic output mode.
- **Scheduling:** Cal.com API v2 — availability, booking, rescheduling, cancellation. Changes need the person on the call to approve the exact action in the browser.
- **Data:** Supabase (Postgres). The console is the only component that holds the Supabase secret key.
- **Telephony:** not implemented. Twilio fields store credentials only; `TWILIO_ENABLED` stays `false`.

> This is a browser-tested receptionist, not a phone system, and it is not certified for healthcare compliance (HIPAA, GDPR, etc.). Do not use real patient data until you have completed your own privacy, consent and retention review.

## How it fits together

```
Browser ──HTTPS──▶ Cloudflare Worker  (src/worker/index.ts)
                     ├─ static dashboard (React, served from Workers Assets)
                     ├─ /api/*     Express 5 app (src/server) ──▶ Supabase
                     ├─ LoginLimiter Durable Object  (brute-force protection)
                     └─ /agents/<clinicId>/ws|health
                           └─▶ ClinicAgent Durable Object  (one per clinic)
                                  └─▶ Container "clinic-agent"  (agent/, Python + Pipecat)
                                         └─▶ Gemini · Cartesia · Cal.com
                                         └─▶ /api/agent/*  (signed, tenant-scoped callbacks)
```

Each clinic's container starts on demand when someone starts a voice test and sleeps after 10 idle minutes. It receives only that clinic's own provider keys — never the Supabase key or another clinic's keys. Details are in [docs/architecture.md](docs/architecture.md).

## Deploy

Follow **[docs/deploy-cloudflare.md](docs/deploy-cloudflare.md)**. In short:

1. Create a Supabase project and run the three SQL files in `supabase/migrations/` in order.
2. Use a Cloudflare account on the **Workers Paid** plan (Containers are not available on the free plan).
3. Import this repository as a Worker with Workers Builds (build `pnpm build`, deploy `npx wrangler deploy`).
4. Add six secrets to the Worker, set `APP_PUBLIC_URL` to its final HTTPS origin, then sign in.

## Configuration

All values are Cloudflare **Secrets** in production (`.dev.vars` for `pnpm dev:worker`, `.env` for `pnpm dev`).

| Name | Purpose |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | Sign-in passcode, 8–128 characters. |
| `DASHBOARD_SESSION_SECRET` | 32 random bytes (64 hex). Signs sessions and derives each clinic's voice/bridge key. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | 32 random bytes (64 hex). Encrypts saved provider keys (AES-256-GCM). **Back it up** — losing it means re-entering every clinic's keys. |
| `APP_PUBLIC_URL` | Exact public origin, e.g. `https://dentdesk-console.<you>.workers.dev`. HTTPS, no path. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SECRET_KEY` | Supabase service-role / secret key. Server-only. |

Generate the two random keys with `openssl rand -hex 32`. The server refuses to run with a missing or malformed value rather than falling back to a default.

Per-clinic provider keys (Gemini, Cartesia, Cal.com, Twilio) are entered in the console UI, not as environment variables.

## Local development

Requires Node 22+ and pnpm 11.

```bash
pnpm install
cp .env.example .env        # fill in the values
pnpm dev                    # API on :3001, web on :3000
```

`pnpm dev` runs the API and dashboard on plain Node, so sign-in, clinic management and integrations work, but there is no container runtime — starting a voice test reports that agent containers are unavailable. To exercise voice end-to-end locally run `pnpm dev:worker` (uses `.dev.vars`; needs Docker for the agent container).

| Command | What it does |
| --- | --- |
| `pnpm check` | Typecheck and run the unit tests. |
| `pnpm build` | Typecheck and build the dashboard into `dist/client`. |
| `pnpm types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`. |
| `pnpm deploy` | Build and deploy from your machine (needs `wrangler login` and Docker). |

## Security model

- Passcode sign-in is rate-limited per client IP in a Durable Object (8 failures per 15 minutes), compared in constant time, and issues an 8-hour signed `HttpOnly`, `SameSite=Lax`, `Secure` session cookie. There is no hard-coded fallback secret; production fails closed if one is missing.
- Mutating browser requests must come from the console's own origin. Agent callbacks use short-lived bearer tokens instead of cookies.
- Provider keys are encrypted before storage, bound to their clinic as authenticated data, never returned to the browser, and decrypted only at the moment a clinic's container is started.
- Browsers connect to a clinic's agent with a 3-minute token signed with a key derived for that clinic only; a token for one clinic is rejected by every other clinic. The agent also checks the browser `Origin`.
- Agents hold no database credentials. They call back to `/api/agent/*` with a 60-second, tenant-scoped token and can read only their own clinic's settings and write call/appointment metadata.
- Audio, transcripts and caller identity are not stored. Call logs are metadata only; appointment records can include the attendee's name and email.

## Project layout

| Path | Contents |
| --- | --- |
| `src/client/` | React dashboard and browser voice tester. |
| `src/server/` | Express API: auth, clinics, integrations, agent callbacks. |
| `src/worker/` | Worker entry, `ClinicAgent` and `LoginLimiter` Durable Objects, token helpers. |
| `agent/` | Python/Pipecat agent and its `Dockerfile`. |
| `supabase/migrations/` | Database schema, applied in filename order. |
| `docs/` | Architecture, deployment guide, provider references. |

## Known limits

- One live voice session per clinic container at a time; load testing and scaling beyond one container per clinic have not been done.
- Containers cold-start in a few seconds when a test begins; a restart or deploy can interrupt a live call.
- The knowledge base is plain text and FAQs. Uploaded documents, embeddings and vector search are not implemented.
- Human hand-off in the browser raises a logged escalation event; it does not dial a phone.
- The database column `companies.render_deployment_status` (and the other `render_*` columns) come from the project's earlier Render design. They are kept so existing databases keep working: `live` means the clinic is provisioned and `not_created` means it is not. The `app_users.manus_open_id` column is likewise unused legacy schema.
