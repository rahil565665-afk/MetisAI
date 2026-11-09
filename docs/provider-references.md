# Provider integration references

These official provider references inform the server adapters. Confirm the current versions and field requirements before changing an API integration.

## Gemini Live API

- Overview and WebSocket architecture: https://ai.google.dev/gemini-api/docs/live-api
- Live API WebSocket reference: https://ai.google.dev/api/live
- Tool use / function-call response: https://ai.google.dev/gemini-api/docs/live-api/tools
- Audio formats and real-time input: https://ai.google.dev/gemini-api/docs/live-api/capabilities

Each business's Durable Object opens one server-to-server WebSocket to the Live API (`BidiGenerateContent`, API key in the `x-goog-api-key` header) and streams the browser's audio through it, so the Gemini credential never reaches a browser. Input is 16 kHz 16-bit mono PCM; output is 24 kHz. Native-audio speech is the only voice mode. The model and voice are the defaults in `src/worker/voice/gemini.ts` and can be overridden with the `GEMINI_LIVE_MODEL` and `GEMINI_VOICE_NAME` variables. Provider credentials being configured is not proof of a successful live session: model availability depends on the key, and the implementation has not been exercised against the real service yet.

## Cal.com API v2

- API v2 authentication and key guidance: https://cal.com/docs/api-reference/v2/introduction
- Availability slots and numeric ID or slug + username/team selectors: https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type
- Create booking with numeric ID or slug + username/team: https://cal.com/docs/api-reference/v2/bookings/create-a-booking
- Get booking and attendee fields by UID: https://cal.com/docs/api-reference/v2/bookings/get-a-booking
- Reschedule booking: https://cal.com/docs/api-reference/v2/bookings/reschedule-a-booking
- Cancel booking: https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking

The implementation (`src/worker/voice/calcom.ts`) supports availability lookup, booking, rescheduling and cancellation. It accepts a numeric event type ID or an event slug paired with exactly one owner username or team slug. Booking changes require browser approval. Reschedule/cancel compare the supplied attendee email to the existing Cal.com booking; this is only a basic match, not a business-approved identity-verification procedure. Live provider behavior remains unverified until a deployed end-to-end test.

## Cloudflare

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects pricing and the Free plan: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Durable Objects WebSockets (and the incoming-message billing ratio): https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/

## Supabase

- API keys: https://supabase.com/docs/guides/getting-started/api-keys
- Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security

Each business has its own Supabase project. The Worker holds that business's secret key encrypted and enforces tenant scope before database operations; the voice agent's database access is bound to the business it serves. `supabase/clinic-schema.sql` enables RLS and revokes direct browser-role access to the two application tables.

See [the Twilio configuration boundary](twilio-transport.md). The current application has no phone transport.
