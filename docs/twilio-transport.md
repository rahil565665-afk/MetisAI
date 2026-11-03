# Twilio: configuration fields only

The current audio transport is the browser WebSocket tester: the dashboard connects to the clinic's Durable Object, which relays audio to Gemini Live. The dashboard provides optional per-clinic Twilio Account SID, Auth Token and E.164 phone-number fields. Saving these values stores them encrypted in the console's database, but `TWILIO_ENABLED` remains `false` and the interface labels Twilio as not connected.

There is no Twilio SDK/API call, number provisioning, phone webhook, Media Streams WebSocket endpoint, signature validation, PSTN routing, or human telephone transfer in this release. A request for a human in the browser only emits an escalation event and call-log flag.

If telephony is added later, it needs a separately implemented and tested Twilio Media Streams adapter, signature validation, audio format conversion (Twilio sends 8 kHz mu-law; the voice session works in 16 kHz and 24 kHz PCM), interruption/backpressure handling, secure stream teardown, and an explicit call-control flow for live transfer. The `ClinicAgent` Durable Object and `VoiceSession` are the natural place to attach it, since a `VoiceSession` only needs a socket that carries audio frames and approval messages. None of those steps is implied by the current settings form. See the main [README](../README.md) for the current transport and deployment limits.
