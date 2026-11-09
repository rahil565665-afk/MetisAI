import { Router, type Request } from 'express';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { asyncRoute, HttpError, parseBody, UUID_PATTERN } from '../http.js';
import { requirePlatformAdmin, requireTenantRole, requireUser } from '../auth/authorization.js';
import { assertTrustedOrigin, login, logout } from '../auth/passcode.js';
import {
  createCompany,
  exportBackup,
  getCompany,
  listCompanies,
  restoreBackup,
  updateCompany,
  updateIntegrationStatus,
} from '../registry/index.js';
import {
  clearTenantProviderSecrets,
  mergeAndEncryptTenantProviderSecrets,
  readTenantProviderSecretsSafe,
  SECRETS_UNREADABLE_PROBLEM,
  type ProviderSecretUpdate,
} from '../integrations/tenantProviderSecrets.js';
import { DatabaseAdviceError, clinicDatabase, getCallDetail, getUsageSummary, listRecentCalls } from '../integrations/clinicDatabase.js';
import type { CalSelector } from '../integrations/calcomSelector.js';
import { cleanKnowledgeFile, cleanKnowledgeText } from '../integrations/knowledge.js';
import { parseEventTypeId, setupCalendar, setupDatabase, setupGemini, type ProviderResult } from '../integrations/providerSetup.js';
import type { Company, IntegrationState } from '../types.js';
import { getClinicAgentRuntime } from '../agent-runtime.js';
import { assertServerConfig, voiceTokenSigningKeyHex } from '../config.js';

export const apiRouter = Router();

/** A clinic is provisioned ('live') once it has stored credentials and may take voice calls. */
const isProvisioned = (company: Company): boolean => company.agent_status === 'live';

const DEFAULT_GREETING = 'Thank you for calling. How can I help you today?';
const DATABASE_NOT_CONNECTED = 'No Supabase database is connected to this clinic yet, so call history is not saved. Add it under Integrations → Clinic Supabase database.';
const DATABASE_UNREADABLE = 'Could not read this clinic’s Supabase database. Check the connection under Integrations.';

/** Why the clinic's database cannot be read: what the last check found, or a general message. */
async function databaseProblem(id: string): Promise<string> {
  try {
    const saved = await readTenantProviderSecretsSafe(id);
    if (saved.unreadable) return SECRETS_UNREADABLE_PROBLEM;
    if (!saved.secrets.supabaseUrl || !saved.secrets.supabaseSecretKey) return DATABASE_NOT_CONNECTED;
    const status = nestedRecord(nestedRecord((await getCompany(id)).integration_status).supabase);
    return typeof status.problem === 'string' && status.problem ? status.problem : DATABASE_UNREADABLE;
  } catch { return DATABASE_UNREADABLE; }
}

const PROVIDERS = ['gemini', 'calcom', 'supabase', 'twilio'] as const;

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

/**
 * A downloadable copy of every clinic and its settings, with each clinic's provider keys still encrypted
 * (they can only be read by a Worker with the same TENANT_CREDENTIALS_ENCRYPTION_KEY). Restoring only ever
 * adds clinics that are missing.
 */
const BACKUP_APP = 'metisai-clinics';

apiRouter.get('/backup', asyncRoute(async (req, res) => {
  await requirePlatformAdmin(req);
  const data = await exportBackup();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename="metisai-clinics-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ app: BACKUP_APP, version: 1, exported_at: new Date().toISOString(), ...data });
}));

const uuidText = z.string().regex(UUID_PATTERN);
const restoreSchema = z.object({
  app: z.literal(BACKUP_APP),
  version: z.literal(1),
  companies: z.array(z.object({
    id: uuidText,
    slug: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    business_type: z.string().max(80),
    is_active: z.boolean(),
    timezone: z.string().max(64),
    receptionist_config: z.record(z.string(), z.unknown()),
    agent_status: z.enum(['not_created', 'live', 'failed']),
    integration_status: z.record(z.string(), z.object({ configured: z.boolean() }).passthrough()),
    created_at: z.string().max(40),
    updated_at: z.string().max(40),
  })).max(200),
  secrets: z.array(z.object({
    tenant_id: uuidText,
    ciphertext: z.string().max(200_000),
    nonce: z.string().max(64),
    key_version: z.number().int().positive(),
    created_at: z.string().max(40),
    updated_at: z.string().max(40),
  })).max(200),
}).passthrough();

apiRouter.post('/backup/restore', asyncRoute(async (req, res) => {
  await requirePlatformAdmin(req);
  const parsed = restoreSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'That file is not a clinic backup from this console. Choose a file downloaded with Download backup.');
  const result = await restoreBackup({ companies: parsed.data.companies as Company[], secrets: parsed.data.secrets });
  res.json({ ...result, tenants: await listCompanies() });
}));

/** A string that is cut to a length instead of being refused for being too long. */
const clamped = (max: number) => z.string().transform((value) => value.trim().slice(0, max));

const createTenantSchema = z.object({
  name: z.string().trim().min(1, 'Enter the clinic’s name.').max(160),
  slug: clamped(80).optional(),
  timezone: clamped(64).optional(),
  receptionist_config: z.object({
    greeting: clamped(800).optional(),
    knowledge_base: z.string().optional(),
    knowledge_base_file: z.unknown().optional(),
  }).strict().optional(),
  integrations: z.object({
    geminiApiKey: clamped(4096).optional(),
    supabaseUrl: clamped(300).optional(),
    supabaseSecretKey: clamped(2048).optional(),
    calcomApiKey: clamped(4096).optional(),
    calcomEventTypeId: z.union([z.number(), z.string()]).nullable().optional(),
    calcomEventLink: clamped(300).optional(),
  }).strict().optional(),
}).strict();

function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '') || 'clinic';
}

const NOT_SET_UP: Record<string, IntegrationState> = {
  gemini: { configured: false, note: 'Not added yet' },
  calcom: { configured: false, note: 'Optional; add an API key and an event to enable scheduling' },
  supabase: { configured: false, note: 'Not connected' },
  twilio: { configured: false, note: 'Not connected' },
};

apiRouter.post('/tenants', asyncRoute(async (req, res) => {
  await requirePlatformAdmin(req);
  const input = parseBody(createTenantSchema, req.body);
  try { assertServerConfig(); } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'The server configuration is incomplete.');
  }
  const given = input.integrations ?? {};
  const config = input.receptionist_config ?? {};

  // Nothing about a clinic's providers can stop it being created. The clinic is made first (a name clash
  // just gets a number added), then each provider is saved and checked, and whatever is wrong is reported.
  const knowledge = cleanKnowledgeText(config.knowledge_base);
  const knowledgeFile = knowledge ? cleanKnowledgeFile(config.knowledge_base_file, knowledge.length) : null;
  const receptionistConfig: Record<string, unknown> = {
    clinic_name: input.name,
    greeting: config.greeting || DEFAULT_GREETING,
    knowledge_base: knowledge,
    ...(knowledgeFile ? { knowledge_base_file: knowledgeFile } : {}),
    faqs: [],
    transfer_enabled: true,
    calcom: { event_type_id: null, event_type_slug: null, username: null, team_slug: null },
  };
  const base = slugify(input.slug || input.name);
  let company: Company | null = null;
  for (let attempt = 1; attempt <= 50 && !company; attempt += 1) {
    try {
      company = await createCompany({ slug: attempt === 1 ? base : `${base}-${attempt}`, name: input.name, business_type: 'dental_clinic', timezone: input.timezone || 'UTC', receptionist_config: receptionistConfig });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
  }
  if (!company) throw new HttpError(409, 'Could not find a free service name for this clinic. Try a different clinic name.');
  const clinic = company;

  const warnings: string[] = [];
  const secrets: ProviderSecretUpdate = {};
  const statuses: Record<string, IntegrationState> = { ...NOT_SET_UP };
  const attempt = async (provider: string, label: string, run: () => Promise<ProviderResult>): Promise<ProviderResult | null> => {
    try {
      const result = await run();
      Object.assign(secrets, result.secrets);
      statuses[provider] = result.status;
      if (result.warning) warnings.push(result.warning);
      return result;
    } catch (error) {
      warnings.push(error instanceof HttpError ? error.message : `${label} could not be set up just now. Add it again under Integrations.`);
      return null;
    }
  };

  if (given.supabaseUrl || given.supabaseSecretKey) {
    await attempt('supabase', 'The clinic database', () => setupDatabase(clinic.id, given.supabaseUrl ?? '', given.supabaseSecretKey ?? ''));
  } else {
    warnings.push('No database is connected, so call history will not be saved. Add the clinic’s Supabase project under Integrations → Clinic Supabase database.');
  }
  if (given.geminiApiKey) {
    await attempt('gemini', 'The Gemini key', () => setupGemini(given.geminiApiKey ?? ''));
  } else {
    warnings.push('No Gemini API key yet, so the voice agent is off. Add one under Integrations → Gemini Live to turn it on.');
  }
  let calendar: CalSelector | undefined;
  if (given.calcomApiKey || given.calcomEventLink || (given.calcomEventTypeId !== null && given.calcomEventTypeId !== undefined && String(given.calcomEventTypeId).trim())) {
    const result = await attempt('calcom', 'Cal.com', () => setupCalendar({
      apiKey: given.calcomApiKey,
      eventTypeId: parseEventTypeId(given.calcomEventTypeId),
      eventLink: given.calcomEventLink,
    }, {}));
    calendar = result?.calendar;
  }

  try {
    if (Object.keys(secrets).length) await mergeAndEncryptTenantProviderSecrets(clinic.id, secrets);
    const tenant = await updateCompany(clinic.id, {
      agent_status: secrets.geminiApiKey ? 'live' : 'not_created',
      integration_status: statuses,
      ...(calendar ? { receptionist_config: { ...receptionistConfig, calcom: calendar } } : {}),
    });
    res.status(201).json({ tenant, warnings });
  } catch (error) {
    await updateCompany(clinic.id, { agent_status: 'failed' }).catch(() => undefined);
    throw error;
  }
}));

apiRouter.get('/tenants/:tenantId', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  res.json({ tenant: await getCompany(id) });
}));

// Saving settings never fails because a value is a little too long or a section was left empty:
// text is cut to its limit, an empty greeting falls back to the standard one, and extra FAQs are dropped.
const receptionistConfigSchema = z.object({
  clinic_name: clamped(160).optional(),
  greeting: clamped(800).optional(),
  knowledge_base: z.string().optional(),
  knowledge_base_file: z.unknown().optional(),
  faqs: z.array(z.object({ question: clamped(300), answer: clamped(2000) })).transform((list) => list.slice(0, 50)).optional(),
  transfer_enabled: z.boolean().optional(),
  calcom: z.object({
    event_type_id: z.number().int().positive().nullable().optional(),
    event_type_slug: clamped(160).nullable().optional(),
    username: clamped(160).nullable().optional(),
    team_slug: clamped(160).nullable().optional(),
  }).optional(),
}).passthrough();

apiRouter.patch('/tenants/:tenantId', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id, ['owner', 'manager']);
  const schema = z.object({
    name: z.string().trim().min(1, 'The clinic name cannot be empty.').max(160).optional(),
    business_type: clamped(80).optional(),
    timezone: clamped(64).optional(),
    is_active: z.boolean().optional(),
    receptionist_config: receptionistConfigSchema.optional(),
  }).strict();
  const changes = parseBody(schema, req.body);
  if (changes.receptionist_config && 'greeting' in changes.receptionist_config && !changes.receptionist_config.greeting) {
    changes.receptionist_config = { ...changes.receptionist_config, greeting: DEFAULT_GREETING };
  }
  if (changes.receptionist_config && typeof changes.receptionist_config.knowledge_base === 'string') {
    const knowledge = cleanKnowledgeText(changes.receptionist_config.knowledge_base);
    const file = knowledge ? cleanKnowledgeFile(changes.receptionist_config.knowledge_base_file, knowledge.length) : null;
    changes.receptionist_config = { ...changes.receptionist_config, knowledge_base: knowledge, knowledge_base_file: file };
  }
  const tenant = await updateCompany(id, changes);
  // Deactivating a clinic ends any call in progress; other changes apply to the next call.
  if (changes.is_active === false) await endClinicCall(id);
  res.json({ tenant });
}));

apiRouter.get('/tenants/:tenantId/integrations', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const company = await getCompany(id);
  // If the Worker's encryption key is not the one that saved this clinic's keys, say so on every provider
  // that had a key, instead of showing them as working.
  const { unreadable } = await readTenantProviderSecretsSafe(id);
  const status = (provider: string): IntegrationState => {
    const entry = configuredStatus(company, provider);
    return unreadable && entry.configured ? { ...entry, configured: false, problem: SECRETS_UNREADABLE_PROBLEM } : entry;
  };
  res.json({ integrations: Object.fromEntries(PROVIDERS.map((provider) => [provider, status(provider)])) });
}));

const integrationUpdateSchema = z.object({
  provider: z.enum(['gemini', 'calcom', 'supabase', 'twilio']),
  apiKey: z.string().trim().max(4096).optional(),
  eventTypeId: z.union([z.number(), z.string()]).nullable().optional(),
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
  try { assertServerConfig(); } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'The server configuration is incomplete.');
  }
  const { secrets: stored, unreadable } = await readTenantProviderSecretsSafe(id);
  let result: ProviderResult;

  if (input.provider === 'gemini') {
    result = await setupGemini(input.apiKey ?? '');
  } else if (input.provider === 'calcom') {
    result = await setupCalendar({
      apiKey: input.apiKey,
      eventTypeId: parseEventTypeId(input.eventTypeId),
      eventLink: input.eventLink, eventTypeSlug: input.eventTypeSlug, username: input.username, teamSlug: input.teamSlug,
    }, { apiKey: stored.calcomApiKey, selector: nestedRecord(company.receptionist_config.calcom) });
  } else if (input.provider === 'supabase') {
    result = await setupDatabase(id, input.supabaseUrl || stored.supabaseUrl || '', input.supabaseSecretKey || stored.supabaseSecretKey || '');
  } else {
    const accountSid = input.accountSid?.trim() ?? '';
    const authToken = input.authToken?.trim() ?? '';
    const phoneNumber = input.phoneNumber?.trim() ?? '';
    if (!/^AC[a-zA-Z0-9]{20,64}$/.test(accountSid) || authToken.length < 16 || !/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
      throw new HttpError(400, 'Enter a Twilio Account SID, Auth Token and E.164 phone number. Values are stored only; Twilio remains disconnected.');
    }
    result = {
      secrets: { twilioAccountSid: accountSid, twilioAuthToken: authToken, twilioPhoneNumber: phoneNumber },
      status: { configured: true, updatedAt: new Date().toISOString(), note: 'Credentials stored encrypted only; phone transport remains disabled and no Twilio API calls are made' },
      message: 'Credentials saved encrypted. Twilio remains disabled; no Twilio API or phone configuration was used.',
    };
  }

  const secretChanged = Object.keys(result.secrets).length > 0;
  if (secretChanged) await mergeAndEncryptTenantProviderSecrets(id, result.secrets);
  const changes: Parameters<typeof updateCompany>[1] = {};
  if (result.calendar) changes.receptionist_config = { ...company.receptionist_config, calcom: result.calendar };
  if (input.provider === 'gemini' && result.secrets.geminiApiKey) changes.agent_status = 'live';
  if (Object.keys(changes).length) await updateCompany(id, changes);
  await updateIntegrationStatus(id, input.provider, result.status);
  if (unreadable) {
    // The old keys could not be read and were dropped to make this save possible. Mark every other
    // provider that had one as needing its key again, so nothing looks connected when it is not.
    for (const provider of PROVIDERS) {
      const entry = configuredStatus(company, provider);
      if (provider === input.provider || !entry.configured) continue;
      await updateIntegrationStatus(id, provider, { ...entry, configured: false, problem: SECRETS_UNREADABLE_PROBLEM });
    }
    if (input.provider !== 'gemini') await updateCompany(id, { agent_status: 'not_created' });
  }
  if (secretChanged || input.provider === 'calcom') await endClinicCall(id);
  const message = input.provider !== 'gemini' && !isProvisioned(company) && !stored.geminiApiKey
    ? `${result.message} The voice agent stays off until a Gemini API key is added.`
    : result.message;
  res.json({ ok: true, provider: input.provider, message, ...(result.warning ? { warning: result.warning } : {}) });
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
  try { summary = await getUsageSummary(db, id); } catch {
    return res.json({ calls: 0, appointments: 0, escalationCount: 0, talkSeconds: 0, periodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), connected: false, problem: await databaseProblem(id) });
  }
  res.json({ ...summary, connected: true });
}));

apiRouter.get('/tenants/:tenantId/calls', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const db = await clinicDatabase(id);
  if (!db) return res.json({ calls: [], connected: false, problem: await databaseProblem(id) });
  let calls: Awaited<ReturnType<typeof listRecentCalls>>;
  try { calls = await listRecentCalls(db, id); } catch (error) {
    return res.json({ calls: [], connected: false, problem: error instanceof DatabaseAdviceError ? error.message : await databaseProblem(id) });
  }
  res.json({ calls, connected: true });
}));

apiRouter.get('/tenants/:tenantId/calls/:callId', asyncRoute(async (req, res) => {
  const id = tenantId(req);
  await requireTenantRole(req, id);
  const callId = String(req.params.callId ?? '');
  if (!UUID_PATTERN.test(callId)) throw new HttpError(400, 'The call identifier is invalid.');
  const db = await clinicDatabase(id);
  if (!db) throw new HttpError(409, await databaseProblem(id));
  let call: Awaited<ReturnType<typeof getCallDetail>>;
  try { call = await getCallDetail(db, id, callId); } catch (error) {
    throw new HttpError(502, error instanceof DatabaseAdviceError ? error.message : await databaseProblem(id));
  }
  if (!call) throw new HttpError(404, 'That call was not found for this clinic.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ call });
}));
