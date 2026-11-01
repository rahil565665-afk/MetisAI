# DentDesk Pipecat agent

The voice agent that runs in each clinic's Cloudflare Container (see [the architecture notes](../docs/architecture.md)). It is an open-source Python/Pipecat FastAPI service. It serves `/health` and a bearer-token-authorized `/ws` endpoint using Pipecat's protobuf WebSocket transport and the maintained `@pipecat-ai/websocket-transport` browser client. It does not use Pipecat Cloud.

## Local setup

In production the container is built from `Dockerfile` by `wrangler deploy` and started by the console with its environment; you do not run it by hand. For local agent development use Python 3.11 or newer. From this directory, install pinned dependencies and provide local-only service configuration in the shell or an untracked `.env` file:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
set -a; . ./.env; set +a
python main.py
```

`PORT` defaults to `10000`. Uvicorn access logging is disabled because the WebSocket URL carries a short-lived bearer token. `/health` returns `{"status":"ok"}` without provider checks or user data. Never commit `.env` or real keys.

## Tenant isolation and data bridge

Every clinic container is pinned to one UUID `TENANT_ID`, one per-tenant `VOICE_TOKEN_SIGNING_SECRET`, and the configured `DASHBOARD_ORIGIN`. The browser receives a short-lived HS256 JWT from the dashboard and connects using `client.connect({ wsUrl, token })`. The service verifies expiry, purpose, tenant ID, output mode, and the exact browser `Origin` before accepting audio. The signing key is not exposed to the browser.

Clinic containers do **not** receive the central Supabase secret key. For clinic settings and call/appointment metadata they make outbound HTTPS requests to the dashboard using a tenant-specific, 60-second bridge JWT. The dashboard verifies that the token belongs to the fixed tenant assigned to that service, then queries or updates only that tenant's records. Audio, transcripts, caller identity, and conversation history are not written to Supabase. The agent records metadata-only call lifecycle events and appointment lifecycle records on a best-effort basis.

The dashboard stores clinic text, opening greeting, structured FAQs, Cal.com selector, Cartesia voice ID, time zone, and selected output mode in `companies.receptionist_config`. FAQ and knowledge text is treated as data in the system context; this starter does not ingest files or create embeddings.

## Voice modes

- The default `native` mode streams browser microphone audio to Pipecat's Gemini Live service and streams Gemini's native audio response back.
- A clinic may select `cartesia` mode in the dashboard. The signed per-session token carries that choice; the service uses Gemini Live text modality followed by Cartesia streaming TTS with the clinic's configured voice ID. Recent Gemini Live models may not support text output. If they do not, the selected Cartesia mode fails with a safe message; the app does not silently change to a different voice.
- Only one active browser session is accepted per agent process in this evaluation demo. Load testing and horizontal scaling have not been completed.

## Cal.com actions

`CALCOM_API_KEY` and a valid event selector are required for scheduling tools. Use a numeric event type ID, or an event slug plus exactly one username or team slug. Availability is read-only. Booking, rescheduling, and cancellation pause until the browser user approves the exact action. Rescheduling/cancellation also require the supplied attendee email to match the existing booking; this is a basic check, not a substitute for a clinic-approved identity-verification policy. If the event selector is incomplete or verification fails, the assistant must not claim or perform an appointment change.

The `request_human_transfer` tool sends a visible browser escalation event and writes a metadata flag to the call log. There is no Twilio SDK, webhook, media stream, or telephone call in this demo. The dashboard only provides fields to store Twilio credentials for future work and keeps `TWILIO_ENABLED=false`.

## Container lifecycle

The clinic's Durable Object starts this container when a user presses **Start voice test** and waits for `/health` before connecting. The container sleeps after 10 idle minutes; there is no keep-alive pinger or scheduled job. An active WebSocket can still disconnect during a restart, redeploy or cold start; the browser shows a disconnected state and lets the user retry.

## Required environment

Required for the deployed agent: `TENANT_ID`, `VOICE_TOKEN_SIGNING_SECRET`, `DASHBOARD_ORIGIN`, and `GEMINI_API_KEY`. `CALCOM_API_KEY` is needed when appointment actions are enabled. `CARTESIA_API_KEY` is needed only when Cartesia output is selected. `PORT` defaults to `10000`, which the console expects. No Supabase URL or Supabase secret key is required in an agent container; the console sets these variables, scoped to the one clinic, each time it starts the container.

## References

- [Pipecat FastAPI WebSocket server transport](https://docs.pipecat.ai/api-reference/server/services/transport/websocket-server)
- [Pipecat JavaScript WebSocket transport](https://docs.pipecat.ai/api-reference/client/js/transports/websocket)
- [Pipecat Gemini Live](https://docs.pipecat.ai/api-reference/server/services/s2s/gemini-live)
- [Pipecat Cartesia TTS](https://docs.pipecat.ai/api-reference/server/services/tts/cartesia)
- [Pipecat RTVI custom messaging](https://docs.pipecat.ai/client/guides/custom-messaging)
- [Cal.com API v2](https://cal.com/docs/api-reference/v2/introduction)
