# Deploying to Cloudflare

This deploys the console Worker and the per-clinic voice-agent containers from this repository using Workers Builds (Cloudflare builds on every push to `main`).

## 0. What you need

- A **Cloudflare account on the Workers Paid plan.** Containers are not available on the free plan.
- A **Supabase project** (free tier is fine to start).
- Provider accounts for the clinics you will configure later: a Gemini API key, optionally Cartesia and Cal.com keys. These are entered in the console, not here.

## 1. Create the database

In the Supabase dashboard open **SQL Editor** and run these files from `supabase/migrations/`, **in order, once each**:

1. `202610260001_initial_schema.sql`
2. `202610270002_render_agents.sql`
3. `202610290003_tenant_provider_secrets.sql`

Then copy **Project URL** and the **secret / service-role key** from *Project Settings → API*. The secret key bypasses row-level security; it belongs only in Worker secrets, never in a browser or in git.

## 2. Create the Worker from this repository

1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** and choose `rahil565665-afk/MetisAI`, branch `main`.
2. **Worker name: `dentdesk-console`.** It must match `name` in `wrangler.jsonc`, otherwise Workers Builds reports a name mismatch. (To use another name, change `name` in `wrangler.jsonc` and commit.)
3. Build settings:
   - Build command: `pnpm build`
   - Deploy command: `npx wrangler deploy`
   - Root directory: leave empty.
4. Save and deploy. The first build typechecks, builds the dashboard, builds the agent's Docker image, pushes it to Cloudflare's registry and deploys the Worker.

Notes:

- The Worker URL responds as soon as it is deployed, but Cloudflare needs **several more minutes** to provision the container image on the first deploy. Voice tests fail until that finishes; `npx wrangler containers list` shows its status.
- Only builds of the **production branch** (`main`) publish the container image and roll out containers. Workers Builds' default command for other branches, `wrangler versions upload`, uploads Worker code only.
- The first deploy succeeds without secrets, but sign-in will not work until step 3.

## 3. Add the secrets

Worker → **Settings → Variables and Secrets → Add**, type **Secret** (use *runtime* variables, not *build* variables):

| Name | Value |
| --- | --- |
| `DASHBOARD_ADMIN_PASSCODE` | A long passphrase of your choice (8–128 characters). |
| `DASHBOARD_SESSION_SECRET` | Output of `openssl rand -hex 32`. |
| `TENANT_CREDENTIALS_ENCRYPTION_KEY` | A *different* output of `openssl rand -hex 32`. Store a copy in your password manager. |
| `SUPABASE_URL` | Your Supabase Project URL. |
| `SUPABASE_SECRET_KEY` | Your Supabase secret key. |
| `APP_PUBLIC_URL` | The Worker's exact origin, e.g. `https://dentdesk-console.<your-subdomain>.workers.dev` (or your custom domain). HTTPS, no trailing slash or path. |

Equivalent from a terminal: `npx wrangler secret put DASHBOARD_ADMIN_PASSCODE` (and so on).

Secrets are kept across deployments. `wrangler.jsonc` only sets the non-secret `NODE_ENV=production`; do not add secrets there.

## 4. Sign in and create a clinic

1. Open the Worker URL and sign in with `DASHBOARD_ADMIN_PASSCODE`.
2. **Create clinic**: give it a name, greeting and knowledge text, and paste the clinic's Gemini API key (required). Add Cal.com and Cartesia details if the clinic uses them.
3. Open the clinic and press **Start voice test**, allow the microphone, and talk. The first test starts the clinic's container, which takes a few seconds.

## Operating notes

- **Changing a provider key** — save it in the clinic's integrations. The running container is stopped and picks up the new key on the next voice test.
- **Remove agent** deletes the clinic's stored provider keys and marks it unprovisioned; add a Gemini key again to re-provision. Clinic history in Supabase is kept.
- **Locked out?** After 8 wrong passcodes an address is blocked for up to 15 minutes, even if the next attempt is correct. Changing the `DASHBOARD_ADMIN_PASSCODE` secret takes effect immediately for new sign-ins.
- **Rotating `DASHBOARD_SESSION_SECRET`** signs everyone out and rotates every clinic's voice key; no other action is needed.
- **Rotating `TENANT_CREDENTIALS_ENCRYPTION_KEY`** makes existing saved provider keys undecryptable. Re-enter each clinic's keys afterwards.
- **Logs**: Worker → *Observability* → Logs. Server errors log the error type and message, never secrets or request bodies.
- **Cost**: Workers Paid is $5 per month and includes some monthly Container usage; beyond that, Containers are billed for the time they are actively running. Clinic containers sleep after 10 idle minutes. See [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) before enabling many clinics.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Build fails at the container step | The account is not on Workers Paid, or Containers is not enabled for it. |
| Sign-in says the passcode is invalid | `DASHBOARD_ADMIN_PASSCODE` is not set as a Worker secret, or was set as a *build* variable. |
| Sign-in or saving a clinic returns "server is not configured" | One of the six secrets is missing or malformed (`APP_PUBLIC_URL` with a path, keys not 64 hex characters). |
| Every state-changing request returns 403 | `APP_PUBLIC_URL` does not exactly match the origin you are browsing. |
| Voice test fails right after the first deploy | The container image is still provisioning (several minutes). Retry, and check `npx wrangler containers list` and Observability logs. |
| A clinic's keys can no longer be read after a deploy | `TENANT_CREDENTIALS_ENCRYPTION_KEY` was changed or lost. |

## Before using it with real callers

This repository has been verified by typecheck, unit tests, and an end-to-end run of the Worker in the local Workers runtime against a stand-in database. A real container start and a live spoken call can only be confirmed on your Cloudflare account — make a test call after deploying, with fake patient details, and confirm booking, rescheduling and cancellation against a test Cal.com event before relying on it.

If an earlier version of this project exposed any provider or database keys (for example in a pasted file or chat), rotate them before going live: Supabase secret key first, then Gemini and Cartesia.
