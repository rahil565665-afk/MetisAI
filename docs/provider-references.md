# Provider integration references

These official provider references inform the server adapters. Confirm the current versions and field requirements before changing an API integration.

## Gemini Live API

- Overview and WebSocket architecture: https://ai.google.dev/gemini-api/docs/live-api
- Ephemeral tokens for client-to-server connections: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- Tool use / function-call response: https://ai.google.dev/gemini-api/docs/live-api/tools
- Audio formats and real-time input: https://ai.google.dev/gemini-api/docs/live-api/capabilities

The current application keeps the Gemini credential server-side and streams browser audio through the Pipecat agent. Gemini Live native audio is the default. Cartesia mode requires Gemini text output; model modality support must be verified for the selected model. Provider credentials being configured is not proof of a successful live session.

## Cartesia

- TTS WebSocket: https://docs.cartesia.ai/api-reference/tts/websocket
- TTS bytes REST API: https://docs.cartesia.ai/api-reference/tts/bytes
- Short-lived access tokens: https://docs.cartesia.ai/api-reference/auth/access-token

Cartesia is optional streaming TTS. It requires a Cartesia API key and voice ID, is called from the clinic agent, and is not exposed directly to browser code. The user's actual voice/output should be verified after the agent is deployed.

## Cal.com API v2

- API v2 authentication and key guidance: https://cal.com/docs/api-reference/v2/introduction
- Availability slots and numeric ID or slug + username/team selectors: https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type
- Create booking with numeric ID or slug + username/team: https://cal.com/docs/api-reference/v2/bookings/create-a-booking
- Get booking and attendee fields by UID: https://cal.com/docs/api-reference/v2/bookings/get-a-booking
- Reschedule booking: https://cal.com/docs/api-reference/v2/bookings/reschedule-a-booking
- Cancel booking: https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking

The implementation supports availability lookup, booking, rescheduling and cancellation. It accepts a numeric event type ID or an event slug paired with exactly one owner username or team slug. Booking changes require browser approval. Reschedule/cancel compare the supplied attendee email to the existing Cal.com booking; this is only a basic match, not a clinic-approved identity-verification procedure. Live provider behavior remains unverified until a deployed end-to-end test.

## Supabase

- API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security

The dashboard server holds the Supabase secret key and enforces tenant scope before database operations. The initial migration enables RLS and revokes direct browser-role access to application tables. Clinic agents do not receive the Supabase secret key; a tenant-scoped signed bridge carries settings and call/appointment metadata.

See [the Twilio configuration boundary](twilio-transport.md). The current application has no phone transport.
