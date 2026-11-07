# Architecture

## Components

| Component | Where | Role |
| --- | --- | --- |
| Dashboard | `src/client`, served by Workers Static Assets | React single-page app: sign-in, clinics, integrations, call history, voice tester. |
| Browser voice client | `src/client/voice` | Captures the microphone (AudioWorklet), downsamples to 16 kHz, sends 100 ms chunks; plays the assistant's 24 kHz audio gap-free and stops it instantly on interruption. |
| API | `src/server`, Express 5 on the Worker | Auth, clinic and integration management, voice-token issuing. Run inside the Worker through `cloudflare:node`'s `handleAsNodeRequest`. |
| `ClinicAgent` Durable Object | `src/worker/clinic-agent.ts` | One per clinic (named by clinic UUID). Validates the voice token and origin, loads that clinic's settings and decrypts its keys, and runs one `VoiceSession` at a time. |
| `VoiceSession` | `src/worker/voice/session.ts` | One call: relays audio between the browser and Gemini Live, accumulates transcripts, runs tool calls, enforces time and idle limits, writes the call log. |
| Receptionist | `src/worker/voice/receptionist.ts` | System prompt, the five tools, and their input validation. |
| Cal.com client | `src/worker/voice/calcom.ts` | Availability, booking, rescheduling, cancellation, with attendee-identity checks. |
| Approval gate | `src/worker/voice/approval.ts` | Holds a tool call until the browser approves it; denies on timeout, interruption or disconnect. |
| `LoginLimiter` Durable Object | `src/worker/login-limiter.ts` | Counts failed sign-ins per client address (hashed). |
| `Registry` Durable Object | `src/worker/registry.ts`, logic in `src/server/registry/core.ts` | The list of clinics and each clinic's encrypted provider keys (one object named `registry`, free SQLite-backed storage). |
| Clinic database | One Supabase project **per clinic** | That clinic's call metadata and appointments. Credentials come from the clinic's encrypted keys; `supabase/clinic-schema.sql` creates the tables. |

`src/worker/index.ts` routes requests: `/agents/<uuid>/ws` to the clinic's Durable Object, `/api/*` to the Express app, everything else to static assets (single-page-app fallback).

## A voice test, step by step

1. The administrator presses **Start browser test**. The page creates its audio engine (this must happen during the click), asks for the microphone, then calls `POST /api/tenants/:id/voice-token` (cookie-authenticated, same-origin only). The API checks the clinic is provisioned and active and returns a 3-minute token.
2. The browser opens `wss://<console>/agents/<clinicId>/ws`, offering two subprotocols: `dentdesk-voice-v1` and `bearer.<token>`.
3. The Worker forwards the upgrade to that clinic's `ClinicAgent`. The Durable Object checks the method and the exact browser `Origin`, verifies the token (signature, expiry, purpose, clinic) with a key derived for that clinic, and refuses with 409 if a call is already running. Otherwise it accepts the WebSocket (selecting `dentdesk-voice-v1`) and starts a `VoiceSession`.
4. From here problems are reported over the open socket as `{type:"error"}` messages, because a browser cannot read the body of a failed WebSocket handshake. The session loads the clinic and its encrypted keys, opens an outbound WebSocket to Gemini Live (key in an `x-goog-api-key` header), sends the setup message — model, voice, system instruction, five tool declarations — and waits for `setupComplete`.
5. The session sends `{type:"ready"}` to the browser and asks Gemini to greet the caller. Microphone audio now flows browser → Durable Object → Gemini as binary frames; Gemini's speech flows back the same way, with live transcripts as JSON messages.
6. When Gemini calls a tool the session validates the arguments. Booking, rescheduling and cancelling first send `approval_request` to the browser and wait for the person to click Approve. Reads (availability) and escalation do not wait.
7. The call ends when the person hangs up, the browser disconnects, an administrator ends it from the dashboard, the Gemini connection is lost and cannot be restored, it reaches 30 minutes, or 3 minutes pass with no speech (the browser is warned 30 seconds before either). Gemini limits a connection to about 10 minutes and announces its end with `goAway`; the session asks for resumable sessions with sliding-window context compression, and on `goAway` or an unexpected drop it opens a replacement connection with the latest resumption handle, moves the call across without repeating the greeting, and retires the old connection. If the service refuses the long-call settings the session retries once without them; if reconnecting fails it ends the call with the service's reason. The session denies any open approval, closes both sockets, and marks the call log `completed`, `error` or `transfer_requested`.

## Trust boundaries

- **Browser → Worker:** session cookie (`HttpOnly`, `SameSite=Lax`, `Secure`) plus an `Origin` check on every mutating request. The voice WebSocket uses a short-lived per-clinic token and a required `Origin`.
- **Model output is untrusted.** Every tool argument is validated: email shape, booking-ID format, ISO date-times that carry a time zone, IANA zone names, future-dated and bounded windows, text length and control characters. Clinic knowledge and FAQs are placed in the prompt marked as data, not instructions. The knowledge base is the text of an uploaded PDF, extracted in the administrator's browser with pdf.js (the Free plan allows only 10 ms of CPU per request, too little to parse PDFs in the Worker); only the text, the file name and the page count are stored, the PDF is not. The server strips control characters, tidies blank lines and keeps the first 60,000 characters.
- **Appointment changes need a human click.** The model cannot approve its own action, spoken agreement is not approval, and an unanswered prompt is a "no". Rescheduling and cancelling re-check attendee identity both before the prompt and after approval.
- **Per-clinic keys:** voice tokens are signed with `HKDF-SHA256(DASHBOARD_SESSION_SECRET, info = "dentdesk-voice-session-v1", salt = "dentdesk-voice:<tenantId>")`. A token minted for one clinic fails verification for every other clinic.
- **Stored provider keys:** AES-256-GCM with a fresh random IV per save and authenticated data `dentdesk-provider-secrets:1:<tenantId>`, so a ciphertext copied to another clinic's row will not decrypt.
- **Isolation:** each clinic's call runs in its own Durable Object, and a call reads only that clinic's row and keys. A clinic's database credentials are decrypted only inside its own call or API request, so one clinic's key can never reach another clinic's data, and every query is still scoped by `tenant_id`.
- **Errors:** provider error text is never forwarded to the browser or the logs; users get fixed, actionable messages and logs carry only a status code or error class.

## Data

The **Registry** holds clinic records and settings, integration status (configured / not configured, never values) and the encrypted provider-key blobs. Each clinic's **own Supabase project** holds its call logs and appointment records; direct browser-role access to those tables is revoked and row-level security is on, so only the clinic's secret key (held encrypted by the Worker) reads or writes them. Audio, transcripts, caller identity and conversation history are not persisted.

When a clinic is added or its database is re-entered, the console test-writes and deletes one call-log row and reads the appointments table, so a wrong key, a wrong project or a missing schema is reported immediately. The result never blocks anything: the URL and key are stored, a failed check is recorded as a `problem` on that connection (shown as *Needs attention* with the reason), and the clinic is created regardless. If the database reports a foreign-key violation against a `companies` table (a project from an earlier version of this design), the Worker upserts the one `companies` row for that clinic and retries the write; this applies to the connection test, call logs and appointment records. A clinic whose database later becomes unreachable still takes calls; history is skipped (best-effort, logging only an error class) and the dashboard shows that the database is not connected.

## Scheduling

Cal.com API v2. The clinic is configured with a pasted event link (`https://cal.com/<user>/<event>` or `https://cal.com/team/<team>/<event>`), which the server turns into an event slug plus the username or team slug, or with a numeric event-type ID (which wins if both are given). When saved, availability for the event is read once to confirm the API key and event; a rejected key or unknown event is saved and flagged as *Needs attention* rather than refused, while a Cal.com outage is not flagged, since it says nothing about the key. Availability is read-only; booking, rescheduling and cancellation pause until the person approves the exact action in the browser. Rescheduling and cancellation also require the supplied attendee email to match the existing booking — a basic check, not a substitute for a clinic-approved identity-verification procedure.

## Free-plan budget

The design avoids anything the Workers Free plan does not include (no Containers, no Queues, no paid add-ons).

| Resource | Free allowance | One minute of talking |
| --- | --- | --- |
| Durable Object requests | 100,000 / day | The browser sends 10 audio messages a second. Incoming WebSocket messages are billed 20:1 and outgoing ones are free, so a minute is about 600 ÷ 20 = **30 billed requests**. |
| Durable Object duration | 13,000 GB-s / day | The object cannot hibernate during a call (it holds an outbound WebSocket), so it is billed for the wall-clock time at 128 MB: **7.7 GB-s** a minute. |
| Worker requests | 100,000 / day | Setting up a call is a handful; static assets are free. |
| Subrequests | 50 external per request | One (the Gemini WebSocket) plus a few Cal.com and Supabase calls per call. |

So roughly 3,000 minutes of calls a day by request count and 28 hours by duration, shared with dashboard use — far more than testing needs. Sending audio in 100 ms chunks (rather than 20 ms) is what keeps the request count low. When a limit is exhausted Cloudflare rejects further requests until 00:00 UTC; the console keeps working for anything that has capacity left.

Not measured: the 10 ms CPU limit on dashboard API requests. It cannot be enforced or measured in local development. The work per request is small (a few calls to the clinic's Supabase, one hash or token operation), but it is the first place to look if you see Cloudflare error 1102.

## Telephony

Not implemented. See [twilio-transport.md](twilio-transport.md).
