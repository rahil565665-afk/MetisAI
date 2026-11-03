import { Router, type Request } from 'express';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody, UUID_PATTERN } from '../http.js';
import { requirePlatformAdmin, requireTenantRole, requireUser } from '../auth/authorization.js';
import { assertTrustedOrigin, login, logout } from '../auth/passcode.js';
import {
  createCompany,
  getCompany,
  getUsageSummary,
  listCompanies,
  listRecentCalls,
  updateCompany,
  updateDeployment,
  updateIntegrationStatus,
  type ManagedCompany,
} from '../integrations/supabase.js';
import {
  clearTenantProviderSecrets,
  mergeAndEncryptTenantProviderSecrets,
  type ProviderSecretUpdate,
} from '../integrations/tenantProviderSecrets.js';
import { getClinicAgentRuntime } from '../agent-runtime.js';
import { assertServerConfig, voiceTokenSigningKeyHex } from '../config.js';

export const apiRouter = Router();

/**
 * The `companies.render_deployment_status` column predates Cloudflare. It is reused, unchanged,
 * to record whether a clinic voice agent is provisioned: 'live' means the clinic has stored
 * credentials and may take voice calls; 'not_created' means it does not.
 */
const PROVISIONED = 'live' as const;
const NOT_PROVISIONED = 'not_created' as const;
const isProvisioned = (company: ManagedCompany): boolean => company.render_deployment_status === PROVISIONED;

function tenantId(req: Request): string {
  const raw = req.params.tenantId;
  const value = Array.isArray(raw) ? raw[0] ?? '' : String(raw ?? '');
  if (!UUID_PATTERN.test(value)) throw new HttpError(400, 'The clinic identifier is invalid.');
  return value.toLowerCase();
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configuredStatus(company: ManagedCompany, provider: string): { configured: boolean; updatedAt?: string; note?: string } {
  const entry = company.integration_status?.[provider];
  return entry ?? { configured: false };
}

/** End a clinic's in-progress voice test so changed credentials or status apply. Best effort. */
async function endClinicCall(id: string): Promise<boolean> {
  try {
    return await getClinicAgentRuntime().endCall(id);
  } catch {
    // Local Node development has no voice runtime. A failed stop only means an in-progress call
    // keeps running until it ends; new calls always read current settings. Never log provider values.
    console.warn('[agent-end-call] Could not end the clinic call; changes apply to the next call.');
    return false;
  }
}

apiRouter.get('/health', (_req, res) => {
  try {
    assertServerConfig();
    res.json({ ok: true, service: 'dentdesk-dashboard', configurationReady: true });
  } catch {
    res.status(503).json({ ok: false, service: 'dentdesk-dashboard', configurationReady: false });
  }
});

apiRouter.get('/session', asyncRoute(async (req, res) => {
  if (!req.user) return res.json({ authenticated: false, user: null });
  const user = await requireUser(req);
  res.json({ authenticated: true, user: { id: user.id, email: user.email, name: user.display_name, isPlatformAdmin: user.is_platform_admin } });
}));

apiRouter.post('/auth/login', asyncRoute(async (req, res) => { await login(req, res); }));
apiRouter.post('/auth/logout', asyncRoute(async (req, res) => { logout(req, res); }));

apiRouter.get('/tenants', asyncRoute(async (req, res) => {
  const user = await requirePlatformAdmin(req);
  res.json({ tenants: await listCompanies(user) });
}));

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  timezone: z.string().trim().min(1).max(64),
  receptionist_config: z.object({
    greeting: z.string().trim().min(1).max(800),
    knowledge_base: z.string().trim().min(1).max(16000),
  }).strict(),
  integrations: z.object({
    geminiApiKey: z.string().trim().min(1).max(4096),
    calcomApiKey: z.string().trim().max(4096),
    calcomEventTypeId: z.number().int().positive().nullable(),
    calcomEventTypeSlug: z.string().trim().max(160),
    calcomUsername: z.string().trim().max(160),
    calcomTeamSlug: z.string().trim().max(160),
  }).strict(),
}).strict();

apiRouter.post('/tenants', asyncRoute(async (req, res) => {
  await requirePlatformAdmin(req);
  const input = parseBody(createTenantSchema, req.body);
  const integration = input.integrations;
  const hasEventId = integration.calcomEventTypeId !== null;
  const hasEventSlug = Boolean(integration.calcomEventTypeSlug);
  if ((hasEventId && hasEventSlug) || (hasEventSlug && Boolean(integration.calcomUsername) === Boolean(integration.calcomTeamSlug))) {
    throw new HttpError(400, 'Use a numeric Cal.com event type ID, or a slug with exactly one username or team slug.');
  }
  try { assertServerConfig(); } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'The server configuration is incomplete.');
  }

  const calcomSelectorReady = hasEventId || (hasEventSlug && Boolean(integration.calcomUsername || integration.calcomTeamSlug));
  const receptionistConfig: Record<string, unknown> = {
    clinic_name: input.name,
    greeting: input.receptionist_config.greeting,
    knowledge_base: input.receptionist_config.knowledge_base,
    faqs: [],
    transfer_enabled: true,
    calcom: {
      event_type_id: integration.calcomEventTypeId,
      event_type_slug: integration.calcomEventTypeSlug || null,
      username: integration.calcomUsername || null,
      team_slug: integration.calcomTeamSlug || null,
    },
  };
  const company = await createCompany({
    slug: input.slug,
    name: input.name,
    businessType: 'dental_clinic',
    timezone: input.timezone,
    receptionistConfig,
  });
  await updateDeployment(company.id, { render_deployment_status: 'creating' });
  const updatedAt = new Date().toISOString();
  const secrets: ProviderSecretUpdate = { geminiApiKey: integration.geminiApiKey };
  if (integration.calcomApiKey) secrets.calcomApiKey = integration.calcomApiKey;
  try {
    await mergeAndEncryptTenantProviderSecrets(company.id, secrets);
    const tenant = await updateCompany(company.id, {
      render_deployment_status: PROVISIONED,
      integration_status: {
        gemini: { configured: true, updatedAt, note: 'Stored encrypted' },
        calcom: { configured: Boolean(integration.calcomApiKey) && calcomSelectorReady, updatedAt, note: integration.calcomApiKey && calcomSelectorReady ? 'API key stored encrypted; event selector is clinic configuration' : 'Optional; configure an API key and event selector to enable scheduling' },
        supabase: { configured: true, updatedAt, note: 'Central Supabase configuration present' },
        twilio: { configured: false, note: 'Not connected' },
      },
    });
    res.status(201).json({ tenant });
  } catch (error) {
    await updateDeployment(company.id, { render_deployment_status: 'failed' }).catch(() => undefined);
    throw error;
  }
}));

apiRouter.get('/tenants/:tenantId', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  res.json({ tenant: await getCompany(id) });
}));

const receptionistConfigSchema = z.object({
  clinic_name: z.string().trim().max(120).optional(),
  greeting: z.string().trim().min(1).max(800).optional(),
  knowledge_base: z.string().trim().max(16000).optional(),
  faqs: z.array(z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) })).max(50).optional(),
  transfer_enabled: z.boolean().optional(),
  calcom: z.object({
    event_type_id: z.number().int().positive().nullable().optional(),
    event_type_slug: z.string().trim().max(160).nullable().optional(),
    username: z.string().trim().max(160).nullable().optional(),
    team_slug: z.string().trim().max(160).nullable().optional(),
  }).optional(),
}).passthrough();

apiRouter.patch('/tenants/:tenantId', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id, ['owner', 'manager']);
  const schema = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    business_type: z.string().trim().min(1).max(80).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    is_active: z.boolean().optional(),
    receptionist_config: receptionistConfigSchema.optional(),
  }).strict();
  const changes = parseBody(schema, req.body);
  const tenant = await updateCompany(id, changes);
  // Deactivating a clinic ends any call in progress; other changes apply to the next call.
  if (changes.is_active === false) await endClinicCall(id);
  res.json({ tenant });
}));

apiRouter.get('/tenants/:tenantId/integrations', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const company = await getCompany(id);
  const centralSupabase = Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SECRET_KEY?.trim());
  res.json({
    integrations: {
      gemini: configuredStatus(company, 'gemini'),
      calcom: configuredStatus(company, 'calcom'),
      twilio: configuredStatus(company, 'twilio'),
      supabase: { configured: centralSupabase, note: 'Managed centrally by the server' },
    },
  });
}));

const integrationUpdateSchema = z.object({
  provider: z.enum(['gemini', 'calcom', 'twilio']),
  apiKey: z.string().trim().max(4096).optional(),
  eventTypeId: z.number().int().positive().nullable().optional(),
  eventTypeSlug: z.string().trim().max(160).optional(),
  username: z.string().trim().max(160).optional(),
  teamSlug: z.string().trim().max(160).optional(),
  accountSid: z.string().trim().max(128).optional(),
  authToken: z.string().trim().max(512).optional(),
  phoneNumber: z.string().trim().max(32).optional(),
}).strict();

apiRouter.put('/tenants/:tenantId/integrations', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id, ['owner', 'manager']);
  const input = parseBody(integrationUpdateSchema, req.body);
  const company = await getCompany(id);
  // A clinic is provisioned by giving it a Gemini key; every other provider needs that first.
  if (!isProvisioned(company) && input.provider !== 'gemini') {
    throw new HttpError(409, 'Add a Gemini API key to provision this clinic agent before configuring other integrations.');
  }
  try { assertServerConfig(); } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'The server configuration is incomplete.');
  }
  const existingStatus = configuredStatus(company, input.provider);
  const updatedAt = new Date().toISOString();
  const secretUpdate: ProviderSecretUpdate = {};
  let nextStatus: { configured: boolean; updatedAt?: string; note?: string } = { ...existingStatus };
  const config = { ...company.receptionist_config } as Record<string, unknown>;

  if (input.provider === 'gemini') {
    if (!input.apiKey) throw new HttpError(400, 'Enter a Gemini API key.');
    secretUpdate.geminiApiKey = input.apiKey;
    nextStatus = { configured: true, updatedAt, note: 'Stored encrypted' };
  } else if (input.provider === 'calcom') {
    if (input.apiKey) secretUpdate.calcomApiKey = input.apiKey;
    const calcom = nestedRecord(config.calcom);
    const hasNewId = typeof input.eventTypeId === 'number' && Number.isInteger(input.eventTypeId) && input.eventTypeId > 0;
    const hasNewSlug = Boolean(input.eventTypeSlug);
    if (hasNewId && hasNewSlug) throw new HttpError(400, 'Use either a numeric Cal.com event type ID or a slug, not both.');
    if (hasNewId) {
      config.calcom = { ...calcom, event_type_id: input.eventTypeId, event_type_slug: null, username: null, team_slug: null };
    } else if (hasNewSlug) {
      const username = input.username || null;
      const teamSlug = input.teamSlug || null;
      if (Boolean(username) === Boolean(teamSlug)) throw new HttpError(400, 'A Cal.com event slug needs exactly one username or team slug.');
      config.calcom = { ...calcom, event_type_id: null, event_type_slug: input.eventTypeSlug, username, team_slug: teamSlug };
    } else if (input.username || input.teamSlug) {
      if (Boolean(input.username) === Boolean(input.teamSlug)) throw new HttpError(400, 'Use either a username or team slug.');
      config.calcom = { ...calcom, username: input.username || null, team_slug: input.teamSlug || null };
    }
    if (!input.apiKey && !hasNewId && !hasNewSlug && !input.username && !input.teamSlug) throw new HttpError(400, 'Enter a Cal.com API key or event selector.');
    const resolved = nestedRecord(config.calcom);
    nextStatus = {
      configured: Boolean(existingStatus.configured || input.apiKey) && Boolean(resolved.event_type_id || (resolved.event_type_slug && (resolved.username || resolved.team_slug))),
      updatedAt,
      note: 'API key stored encrypted; event selector is clinic configuration',
    };
  } else {
    const accountSid = input.accountSid?.trim() ?? '';
    const authToken = input.authToken?.trim() ?? '';
    const phoneNumber = input.phoneNumber?.trim() ?? '';
    if (!/^AC[a-zA-Z0-9]{20,64}$/.test(accountSid) || authToken.length < 16 || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      throw new HttpError(400, 'Enter a Twilio Account SID, Auth Token and E.164 phone number. Values are stored only; Twilio remains disconnected.');
    }
    secretUpdate.twilioAccountSid = accountSid;
    secretUpdate.twilioAuthToken = authToken;
    secretUpdate.twilioPhoneNumber = phoneNumber;
    nextStatus = { configured: true, updatedAt, note: 'Credentials stored encrypted only; phone transport remains disabled and no Twilio API calls are made' };
  }

  const secretChanged = Object.keys(secretUpdate).length > 0;
  if (secretChanged) await mergeAndEncryptTenantProviderSecrets(id, secretUpdate);
  if (input.provider === 'calcom') await updateCompany(id, { receptionist_config: config });
  if (input.provider === 'gemini' && !isProvisioned(company)) await updateDeployment(id, { render_deployment_status: PROVISIONED });
  await updateIntegrationStatus(id, input.provider, nextStatus);
  if (secretChanged || input.provider === 'calcom') await endClinicCall(id);
  res.json({ ok: true, provider: input.provider, message: input.provider === 'twilio'
    ? 'Credentials saved encrypted. Twilio remains disabled; no Twilio API or phone configuration was used.'
    : 'Configuration saved server-side. Secret values are not returned. Changes apply the next time you start a voice test.' });
}));

apiRouter.get('/tenants/:tenantId/deployment-status', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const company = await getCompany(id);
  if (!isProvisioned(company)) {
    return res.json({ provisioned: false, inCall: null, status: 'not_provisioned', message: 'This clinic has no provisioned agent. Add a Gemini API key to provision it.' });
  }
  try {
    const runtime = await getClinicAgentRuntime().status(id);
    res.json({
      provisioned: true,
      inCall: runtime.inCall,
      status: runtime.status,
      message: 'The voice agent runs only while a voice test is open and uses no resources between calls.',
    });
  } catch {
    res.json({ provisioned: true, inCall: null, status: 'unavailable', message: 'Voice agent status is not available in this environment.' });
  }
}));

apiRouter.post('/tenants/:tenantId/end-call', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requirePlatformAdmin(req);
  const company = await getCompany(id);
  if (!isProvisioned(company)) throw new HttpError(409, 'This clinic has no provisioned agent.');
  const ended = await endClinicCall(id);
  res.json({
    ok: true,
    ended,
    message: ended ? 'The call in progress was ended.' : 'No call was in progress.',
  });
}));

apiRouter.delete('/tenants/:tenantId/agent', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requirePlatformAdmin(req);
  const company = await getCompany(id);
  if (!isProvisioned(company)) throw new HttpError(409, 'This clinic has no provisioned agent to remove.');
  await endClinicCall(id);
  await clearTenantProviderSecrets(id);
  await updateDeployment(id, { render_deployment_status: NOT_PROVISIONED });
  const updatedAt = new Date().toISOString();
  for (const provider of ['gemini', 'calcom', 'twilio'] as const) {
    await updateIntegrationStatus(id, provider, {
      configured: false,
      updatedAt,
      note: 'Agent removed; add a Gemini API key to provision it again',
    });
  }
  res.json({ ok: true, tenant: await getCompany(id), message: 'Clinic agent removed; stored credentials were deleted and call and appointment history was preserved.' });
}));

apiRouter.post('/tenants/:tenantId/voice-token', asyncRoute(async (req, res) => {
  assertTrustedOrigin(req);
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const company = await getCompany(id);
  if (!company.is_active) throw new HttpError(409, 'This clinic is inactive.');
  if (!isProvisioned(company)) throw new HttpError(409, 'This clinic has no provisioned voice agent.');
  const token = await new SignJWT({ tenantId: id, purpose: 'voice' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('3m')
    .sign(new TextEncoder().encode(voiceTokenSigningKeyHex(id)));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ token, expiresInSeconds: 180 });
}));

apiRouter.get('/tenants/:tenantId/usage', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  res.json(await getUsageSummary(id));
}));

apiRouter.get('/tenants/:tenantId/calls', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  res.json({ calls: await listRecentCalls(id) });
}));
