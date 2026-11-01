# Architecture

## Components

| Component | Where | Role |
| --- | --- | --- |
| Dashboard | `src/client`, served by Workers Static Assets | React single-page app: sign-in, clinics, integrations, call history, voice tester. |
| API | `src/server`, Express 5 on the Worker | Auth, clinic and integration management, voice-token issuing, agent callbacks. Run inside the Worker through `cloudflare:node`'s `handleAsNodeRequest`. |
| `ClinicAgent` Durable Object | `src/worker/clinic-agent.ts` | One per clinic (named by clinic UUID). Owns that clinic's container: validates the voice token and origin, starts the container with only that clinic's keys, forwards the WebSocket. |
| `LoginLimiter` Durable Object | `src/worker/login-limiter.ts` | Counts failed sign-ins per client address (hashed). |
| Clinic agent | `agent/`, container `clinic-agent` | Python/FastAPI + Pipecat. Speaks with Gemini Live, optionally Cartesia, books through Cal.com. |
| Database | Supabase | Clinics, call metadata, appointments, encrypted provider keys. |

`src/worker/index.ts` routes requests: `/agents/<uuid>/(health|ws)` to the clinic's Durable Object, `/api/*` to the Express app, everything else to static assets (single-page-app fallback).

## A voice test, step by step

1. The administrator presses **Start voice test**. The browser calls `POST /api/tenants/:id/voice-token` (cookie-authenticated, same-origin only). The API checks the clinic is provisioned and active and returns a 3-minute token.
2. The browser opens `wss://<console>/agents/<clinicId>/ws?token=…`.
3. The Worker forwards it to that clinic's `ClinicAgent`. The Durable Object verifies the exact browser `Origin`, verifies the token (signature, expiry, purpose, clinic) using a key derived for that clinic, loads and decrypts that clinic's provider keys, and starts the container if it is not running.
4. The container's `/ws` verifies the same token and `Origin` again. Audio then streams in both directions over the Pipecat protobuf WebSocket.
5. During the call the agent reads the clinic's settings and writes call and appointment metadata through `/api/agent/*`, authenticated with a 60-second bearer token signed for that clinic.
6. After 10 idle minutes the container sleeps. Nothing pings it to keep it awake.

## Trust boundaries

- **Browser → Worker:** session cookie (`HttpOnly`, `SameSite=Lax`, `Secure`) plus an `Origin` check on every mutating request.
- **Worker → container:** the container receives environment variables for exactly one clinic: its Gemini key, and its Cartesia and Cal.com keys when set, plus its tenant ID, bridge signing key, console origin and output mode. It never receives the Supabase key, the passcode, the session secret, the encryption key, Twilio credentials, or any other clinic's data.
- **Container → API:** bearer token, `purpose: agent_bridge`, claims `tenantId`, `iat`, `exp` (≤ 2 minutes of age accepted). The API serves only the token's own tenant.
- **Per-clinic keys:** voice and bridge tokens are signed with `HKDF-SHA256(DASHBOARD_SESSION_SECRET, info = "dentdesk-voice-session-v1", salt = "dentdesk-voice:<tenantId>")`. A token minted for one clinic fails verification for every other clinic.
- **Stored provider keys:** AES-256-GCM with a fresh random IV per save and authenticated data `dentdesk-provider-secrets:1:<tenantId>`, so a ciphertext copied to another clinic's row will not decrypt.

## Data

Supabase holds clinic records and settings, integration status (configured / not configured, never values), call logs, appointment lifecycle records and the encrypted provider-key table. Direct browser-role access to application tables is revoked and row-level security is on; only the Worker's secret key reads or writes them. Audio, transcripts, caller identity and conversation history are not persisted.

`companies.render_deployment_status` stores whether a clinic is provisioned (`live`) or not (`not_created`). The name is historical; see the README.

## Voice modes

- `native` (default): Gemini Live receives microphone audio and returns native speech.
- `cartesia`: Gemini Live returns text and Cartesia synthesizes speech with the clinic's voice ID. This depends on the selected Gemini model supporting text output; if it does not, the call fails with a clear message rather than silently switching voices.

## Scheduling

Cal.com API v2 with a numeric event-type ID, or an event slug plus exactly one username or team slug. Availability is read-only; booking, rescheduling and cancellation pause until the person approves the exact action in the browser. Rescheduling and cancellation also require the supplied attendee email to match the existing booking — a basic check, not a substitute for a clinic-approved identity-verification procedure.

## Telephony

Not implemented. See [twilio-transport.md](twilio-transport.md).
