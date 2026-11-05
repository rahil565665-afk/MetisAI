import { Router, type Request } from 'express';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody, UUID_PATTERN } from '../http.js';
import { requirePlatformAdmin, requireTenantRole, requireUser } from '../auth/authorization.js';
import { assertTrustedOrigin, login, logout } from '../auth/passcode.js';
import {
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
  updateIntegrationStatus,
} from '../registry/index.js';
import {
  clearTenantProviderSecrets,
  mergeAndEncryptTenantProviderSecrets,
  readTenantProviderSecrets,
  type ProviderSecretUpdate,
} from '../integrations/tenantProviderSecrets.js';
import {
  checkClinicDatabase,
  cleanSupabaseKey,
  clinicDatabase,
  connectClinicDatabase,
  getUsageSummary,
  listRecentCalls,
  normalizeSupabaseUrl,
} from '../integrations/clinicDatabase.js';
import { parseCalSelector, selectorIsComplete, type CalSelector } from '../integrations/calcomSelector.js';
import { checkCalCom, checkGeminiKey } from '../integrations/providerChecks.js';
import type { Company, IntegrationState } from '../types.js';
import { getClinicAgentRuntime } from '../agent-runtime.js';
import { assertServerConfig, voiceTokenSigningKeyHex } from '../config.js';

export const apiRouter = Router();

/** A clinic is provisioned ('live') once it has stored credentials and may take voice calls. */
const isProvisioned = (company: Company): boolean => company.agent_status === 'live';

const GEMINI_REJECTED = 'Google rejected that Gemini API key. Create a key in Google AI Studio and check you copied all of it.';
const CALCOM_REJECTED = 'Cal.com rejected that API key. Create a new API key in Cal.com (Settings → Developer → API keys) and paste it again.';
const CALCOM_NOT_FOUND = 'Cal.com could not find that event. Check the event type ID (it is the number in the event’s address in Cal.com) or the link.';
const DATABASE_UNREADABLE = 'Could not read this clinic’s Supabase database. Check the connection under Integrations.';

function tenantId(req: Request): string {
  const raw = req.params.tenantId;
  const value = Array.isArray(raw) ? raw[0] ?? '' : String(raw ?? '');
  if (!UUID_PATTERN.test(value)) throw new HttpError(400, 'The clinic identifier is invalid.');
  return value.toLowerCase();
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function configuredStatus(company: Company, provider: string): IntegrationState {
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
  await requirePlatformAdmin(req);
  res.json({ tenants: await listCompanies() });
}));

const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'The service slug may use only lowercase letters, numbers and single dashes.').max(80),
  timezone: z.string().trim().min(1).max(64),
  receptionist_config: z.object({
    greeting: z.string().trim().min(1).max(800),
    knowledge_base: z.string().trim().min(1).max(16000),
  }).strict(),
  integrations: z.object({
    geminiApiKey: z.string().trim().min(1, 'Enter the clinic’s Gemini API key.').max(4096),
    supabaseUrl: z.string().trim().min(1, 'Enter the clinic’s Supabase project URL.').max(300),
    supabaseSecretKey: z.string().trim().min(1, 'Enter the clinic’s Supabase secret key.').max(2048),
    calcomApiKey: z.string().trim().max(4096).optional(),
    calcomEventTypeId: z.number().int().positive().nullable().optional(),
    calcomEventLink: z.string().trim().max(300).optional(),
  }).strict(),
}).strict();

apiRouter.post('/tenants', asyncRoute(async (req, res) => {
  await requirePlatformAdmin(req);
  const input = parseBody(createTenantSchema, req.body);
  const integration = input.integrations;
  try { assertServerConfig(); } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'The server configuration is incomplete.');
  }

  // Check everything that can be wrong before anything is stored, so a failed attempt leaves nothing behind.
  const calcom = parseCalSelector({ eventTypeId: integration.calcomEventTypeId, eventLink: integration.calcomEventLink });
  const supabaseUrl = normalizeSupabaseUrl(integration.supabaseUrl);
  const supabaseSecretKey = cleanSupabaseKey(integration.supabaseSecretKey);
  const id = crypto.randomUUID();
  await checkClinicDatabase(connectClinicDatabase(supabaseUrl, supabaseSecretKey), id);
  if (await checkGeminiKey(integration.geminiApiKey) === 'rejected') throw new HttpError(400, GEMINI_REJECTED);
  const calcomKey = integration.calcomApiKey || '';
  if (calcomKey && calcom) {
    const result = await checkCalCom(calcom.selector, calcomKey);
    if (result === 'rejected') throw new HttpError(400, CALCOM_REJECTED);
    if (result === 'not_found') throw new HttpError(400, CALCOM_NOT_FOUND);
  }

  const receptionistConfig: Record<string, unknown> = {
    clinic_name: input.name,
    greeting: input.receptionist_config.greeting,
    knowledge_base: input.receptionist_config.knowledge_base,
    faqs: [],
    transfer_enabled: true,
    calcom: calcom?.selector ?? { event_type_id: null, event_type_slug: null, username: null, team_slug: null },
  };
  const company = await createCompany({
    id,
    slug: input.slug,
    name: input.name,
    business_type: 'dental_clinic',
    timezone: input.timezone,
    receptionist_config: receptionistConfig,
  });
  const updatedAt = new Date().toISOString();
  const secrets: ProviderSecretUpdate = { geminiApiKey: integration.geminiApiKey, supabaseUrl, supabaseSecretKey };
  if (calcomKey) secrets.calcomApiKey = calcomKey;
  try {
    await mergeAndEncryptTenantProviderSecrets(company.id, secrets);
    const calcomReady = Boolean(calcomKey) && selectorIsComplete(calcom?.selector);
    const tenant = await updateCompany(company.id, {
      agent_status: 'live',
      integration_status: {
        gemini: { configured: true, updatedAt, note: 'Stored encrypted' },
        calcom: { configured: calcomReady, updatedAt, note: calcomReady ? 'API key stored encrypted; event is clinic configuration' : 'Optional; add an API key and an event to enable scheduling' },
        supabase: { configured: true, updatedAt, note: 'Stored encrypted; call history is written to the clinic’s own project' },
        twilio: { configured: false, note: 'Not connected' },
      },
    });
    res.status(201).json({ tenant });
  } catch (error) {
    await updateCompany(company.id, { agent_status: 'failed' }).catch(() => undefined);
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
  res.json({
    integrations: {
      gemini: configuredStatus(company, 'gemini'),
      calcom: configuredStatus(company, 'calcom'),
      supabase: configuredStatus(company, 'supabase'),
      twilio: configuredStatus(company, 'twilio'),
    },
  });
}));

const integrationUpdateSchema = z.object({
  provider: z.enum(['gemini', 'calcom', 'supabase', 'twilio']),
  apiKey: z.string().trim().max(4096).optional(),
  eventTypeId: z.number().int().positive().nullable().optional(),
  eventLink: z.string().trim().max(300).optional(),
  eventTypeSlug: z.string().trim().max(300).optional(),
  username: z.string().trim().max(300).optional(),
  teamSlug: z.string().trim().max(300).optional(),
  supabaseUrl: z.string().trim().max(300).optional(),
  supabaseSecretKey: z.string().trim().max(2048).optional(),
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
  const updatedAt = new Date().toISOString();
  const secretUpdate: ProviderSecretUpdate = {};
  let nextStatus: IntegrationState = { ...configuredStatus(company, input.provider) };
  const config = { ...company.receptionist_config } as Record<string, unknown>;
  let message = 'Saved. Secret values are not shown again. Changes apply the next time you start a voice test.';

  if (input.provider === 'gemini') {
    if (!input.apiKey) throw new HttpError(400, 'Enter a Gemini API key.');
    if (await checkGeminiKey(input.apiKey) === 'rejected') throw new HttpError(400, GEMINI_REJECTED);
    secretUpdate.geminiApiKey = input.apiKey;
    nextStatus = { configured: true, updatedAt, note: 'Stored encrypted' };
  } else if (input.provider === 'calcom') {
    const parsed = parseCalSelector({
      eventTypeId: input.eventTypeId, eventLink: input.eventLink,
      eventTypeSlug: input.eventTypeSlug, username: input.username, teamSlug: input.teamSlug,
    });
    if (!input.apiKey && !parsed) throw new HttpError(400, 'Enter a Cal.com API key, an event type ID, or an event link.');
    if (input.apiKey) secretUpdate.calcomApiKey = input.apiKey;
    if (parsed) config.calcom = parsed.selector;
    const stored = await readTenantProviderSecrets(id);
    const apiKey = input.apiKey || stored.calcomApiKey || '';
    const selector = (parsed?.selector ?? nestedRecord(config.calcom)) as unknown as CalSelector;
    const complete = selectorIsComplete(selector);
    if (apiKey && complete) {
      const result = await checkCalCom(selector, apiKey);
      if (result === 'rejected') throw new HttpError(400, CALCOM_REJECTED);
      if (result === 'not_found') throw new HttpError(400, CALCOM_NOT_FOUND);
      if (result === 'unknown') message = 'Saved, but Cal.com could not be reached to confirm it just now. Try a voice test to check.';
    }
    const missing = !apiKey ? 'Add the API key' : !complete ? 'Add the event type ID or an event link' : '';
    message = missing ? `Saved. ${missing} to turn scheduling on.` : message;
    if (parsed?.note) message = `${message} ${parsed.note}`;
    nextStatus = {
      configured: Boolean(apiKey) && complete,
      updatedAt,
      note: 'API key stored encrypted; event is clinic configuration',
    };
  } else if (input.provider === 'supabase') {
    const stored = await readTenantProviderSecrets(id);
    const url = normalizeSupabaseUrl(input.supabaseUrl || stored.supabaseUrl || '');
    const key = cleanSupabaseKey(input.supabaseSecretKey || stored.supabaseSecretKey || '');
    await checkClinicDatabase(connectClinicDatabase(url, key), id);
    secretUpdate.supabaseUrl = url;
    secretUpdate.supabaseSecretKey = key;
    nextStatus = { configured: true, updatedAt, note: 'Stored encrypted; call history is written to the clinic’s own project' };
    message = 'Connected. Call history and appointments will now be saved to this Supabase project.';
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
    message = 'Credentials saved encrypted. Twilio remains disabled; no Twilio API or phone configuration was used.';
  }

  const secretChanged = Object.keys(secretUpdate).length > 0;
  if (secretChanged) await mergeAndEncryptTenantProviderSecrets(id, secretUpdate);
  if (input.provider === 'calcom') await updateCompany(id, { receptionist_config: config });
  if (input.provider === 'gemini' && !isProvisioned(company)) await updateCompany(id, { agent_status: 'live' });
  await updateIntegrationStatus(id, input.provider, nextStatus);
  if (secretChanged || input.provider === 'calcom') await endClinicCall(id);
  res.json({ ok: true, provider: input.provider, message });
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
  await updateCompany(id, { agent_status: 'not_created' });
  const updatedAt = new Date().toISOString();
  for (const provider of ['gemini', 'calcom', 'supabase', 'twilio'] as const) {
    await updateIntegrationStatus(id, provider, {
      configured: false,
      updatedAt,
      note: 'Agent removed; add a Gemini API key to provision it again',
    });
  }
  res.json({ ok: true, tenant: await getCompany(id), message: 'Clinic agent removed; stored credentials were deleted. Call and appointment history stays in the clinic’s own Supabase project.' });
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
  const db = await clinicDatabase(id);
  if (!db) return res.json({ calls: 0, appointments: 0, escalationCount: 0, talkSeconds: 0, periodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), connected: false });
  let summary: Awaited<ReturnType<typeof getUsageSummary>>;
  try { summary = await getUsageSummary(db, id); } catch { throw new HttpError(502, DATABASE_UNREADABLE); }
  res.json({ ...summary, connected: true });
}));

apiRouter.get('/tenants/:tenantId/calls', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const db = await clinicDatabase(id);
  if (!db) return res.json({ calls: [], connected: false });
  let calls: unknown[];
  try { calls = await listRecentCalls(db, id); } catch { throw new HttpError(502, DATABASE_UNREADABLE); }
  res.json({ calls, connected: true });
}));
