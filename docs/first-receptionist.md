# Create your first receptionist

This guide takes you from a blank console to a safe browser test. You can create a business with only its name and add providers later; however, without a Supabase project, call history and messages will not be saved, and without a Gemini key, the voice agent cannot start.

## 1. Choose the closest template

In the Metis AI console, choose **Add business receptionist**, enter a business name, then select one of the eight templates: Dental, Salon/Spa, Medical, Legal, Restaurant, Home services, Fitness, or General. The template is a starting point, not a fixed workflow. Existing businesses and older clients that do not send `business_type` keep the previous Dental behavior.

## 2. Set the receptionist's behavior

Under **Reception setup**, review the greeting, persona name, tone, services, opening hours, business safety guidance, booking language, FAQs, and knowledge-base text. Replace examples with information the business has confirmed. If hours or a policy are not known, leave them unconfigured rather than asking the assistant to guess. A PDF knowledge file is read in your browser; only its text and basic file details are saved.

Choose the **Enabled actions** carefully:

- **Booking** allows availability and booking changes. It still requires a connected Cal.com event, the caller's clear spoken confirmation of the exact read-back, and your approval click in the browser.
- **Take messages** saves a message to that call's history if Supabase is connected. It does not call staff or transfer the call.
- **Hand off to staff** records a separate handoff event. In this browser-only release it cannot transfer a phone call.

Disabled actions are not offered to the model and are also rejected by the Worker if called anyway. Booking may be switched off independently.

For the Dental and Medical templates, keep the supplied guardrails: the receptionist does not diagnose, routes urgent symptoms to emergency services, and must not request date of birth, insurance, or payment details. Other templates do not inherit those medical rules; review their own business-specific safety guidance instead.

## 3. Connect only what you need

Each business uses its own provider accounts and its own Supabase project—there is no shared customer database.

- Add a **Gemini API key** to enable the browser voice test.
- Add the business's **Supabase project URL and secret key** if you want call history, messages, and booking activity saved. Run `supabase/clinic-schema.sql` in that project's SQL Editor first. The schema filename is historical and intentionally retained; existing table and column names are not renamed.
- Add **Cal.com** only when booking is enabled. Enter the API key and either an event link or numeric event type ID. A missing or rejected provider will not block business creation; Integrations reports what needs attention.
- Twilio fields currently store credentials only. They do not connect a phone line.

Never use a public/publishable Supabase key. Secrets are stored encrypted. Keep the Cloudflare `TENANT_CREDENTIALS_ENCRYPTION_KEY` safe and unchanged: restoring a backup that contains encrypted provider keys requires the same key.

## 4. Test with non-sensitive details

Open **Voice test** and start a browser test using a microphone. Use invented test details, not real customer information. Check that the greeting and business terminology sound right. The call page reports whether booking is ready and whether call history is being saved.

If booking is enabled and Cal.com is ready, the assistant must check availability, read the caller's exact name/contact/time back, hear a clear yes, and then wait for an explicit **Approve action** click. Do not approve a request you did not intend to make. If booking is disabled or Cal.com is unavailable, the assistant must not claim that a booking was submitted; other enabled actions can still be used.

## 5. Review and back up

Open **Call activity** to review the saved outcome and conversation text. Raw browser audio is not recorded, but transcripts and contact details can still be personal information. Set consent, access, retention, and deletion practices before real use.

On **Overview**, download a backup of the Registry. Provider keys inside are encrypted, not portable by themselves: store the backup together with the same `TENANT_CREDENTIALS_ENCRYPTION_KEY`. Restore is additive and does not overwrite businesses already present.

## Important limits

This release is a browser voice tester, not phone service. Automated tests use local fakes and do not validate real Gemini Live, Cal.com, or Supabase accounts. Before using real callers, perform a controlled test on the business owner's accounts and confirm privacy and compliance obligations.
