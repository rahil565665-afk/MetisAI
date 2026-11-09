import { DurableObject } from 'cloudflare:workers';
import { getCompany } from '../server/registry/index.js';
import { developmentUrl } from '../server/devOverrides.js';
import { databaseFromSecrets } from '../server/integrations/clinicDatabase.js';
import { voiceTokenSigningKeyHex } from '../server/config.js';
import { readTenantProviderSecrets, SecretsUnreadableError, SECRETS_UNREADABLE_PROBLEM } from '../server/integrations/tenantProviderSecrets.js';
import type { ClinicAgentStatus } from '../server/agent-runtime.js';
import { CalComClient, CalComError } from './voice/calcom.js';
import { normalizeClinicConfig } from './voice/clinicConfig.js';
import { geminiLiveUrl, geminiSettings } from './voice/gemini.js';
import {
  GEMINI_REFUSED,
  SessionStartError,
  VoiceSession,
  type PreparedSession,
  type VoiceSocket,
} from './voice/session.js';
import type { SchedulingStatus } from './voice/receptionist.js';
import { supabaseCallStore } from './voice/store.js';
import { UUID_PATTERN, VOICE_SUBPROTOCOL, bearerToken, subprotocolToken, validOrigin, verifyVoiceToken } from './voiceAuth.js';

export interface ClinicAgentEnv {
  APP_PUBLIC_URL: string;
}

function reject(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** Open the outbound WebSocket to Gemini Live. The API key travels in a header, never in the URL. */
async function openGeminiSocket(apiKey: string): Promise<VoiceSocket> {
  let response: Response;
  try {
    response = await fetch(geminiLiveUrl(developmentUrl('GEMINI_LIVE_ORIGIN')), {
      headers: { Upgrade: 'websocket', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SessionStartError('The Gemini Live service could not be reached. Try again shortly.');
  }
  const socket = response.webSocket;
  if (response.status !== 101 || !socket) {
    await response.body?.cancel().catch(() => undefined);
    console.error('[clinic-agent] gemini upgrade refused', response.status);
    throw new SessionStartError(GEMINI_REFUSED);
  }
  // Workers deliver binary frames as Blobs unless told otherwise; the session reads ArrayBuffers.
  socket.binaryType = 'arraybuffer';
  socket.accept();
  return socket as unknown as VoiceSocket;
}

/**
 * Whether booking will really work on this call: Cal.com is configured, accepts the key, and finds the event.
 * Checked before the call starts so the receptionist is told the truth and can say so, instead of improvising.
 * The reason is advice for the administrator, never provider text.
 */
async function checkScheduling(cal: CalComClient | null, calError: string | null, timeZone: string): Promise<SchedulingStatus> {
  if (!cal) return { available: false, reason: calError ?? 'Cal.com scheduling is not configured' };
  try {
    const now = new Date();
    await cal.availableSlots(now, new Date(now.getTime() + 24 * 60 * 60 * 1000), timeZone);
    return { available: true };
  } catch (error) {
    return { available: false, reason: error instanceof CalComError ? error.message : 'Cal.com could not be checked' };
  }
}

/**
 * One Durable Object (named by clinic UUID) runs that clinic's browser voice test. The browser's
 * WebSocket terminates here and this object holds the outbound WebSocket to Gemini Live, so a
 * clinic's call state, credentials and tool calls never share memory with another clinic.
 * Nothing runs unless an authorized voice request arrives; an idle object is evicted by Cloudflare.
 */
export class ClinicAgent extends DurableObject<ClinicAgentEnv> {
  private session: VoiceSession | null = null;

  /** Read-only status for the dashboard. */
  async status(tenantId: string): Promise<ClinicAgentStatus> {
    if (!UUID_PATTERN.test(tenantId)) throw new Error('Invalid business identifier.');
    const inCall = this.session?.active ?? false;
    return { provisioned: true, inCall, status: inCall ? 'in_call' : 'idle' };
  }

  /** End an in-progress call, for example because the clinic was deactivated or its credentials changed. */
  async endCall(tenantId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(tenantId)) throw new Error('Invalid business identifier.');
    const session = this.session;
    if (!session?.active) return false;
    await session.end('admin');
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/agents\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) return reject(404, 'Not found.');
    const tenantId = match[1]!.toLowerCase();
    if (!UUID_PATTERN.test(tenantId)) return reject(400, 'Invalid business identifier.');
    if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return reject(426, 'WebSocket upgrade required.');
    }
    if (!validOrigin(request, this.env.APP_PUBLIC_URL, true)) return reject(403, 'Request Origin is not allowed.');

    let signingSecret: string;
    try {
      signingSecret = voiceTokenSigningKeyHex(tenantId);
    } catch {
      return reject(503, 'Business voice authentication is unavailable.');
    }
    const claims = await verifyVoiceToken(subprotocolToken(request) ?? bearerToken(request), tenantId, signingSecret);
    if (!claims) return reject(401, 'A valid business voice token is required.');

    // Checked and claimed with no await in between, so two simultaneous requests cannot both start.
    if (this.session?.active) return reject(409, 'A voice test is already running for this business.');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.binaryType = 'arraybuffer';
    server.accept();

    const settings = geminiSettings(process.env as Record<string, string | undefined>);
    const session = new VoiceSession({
      client: server as unknown as VoiceSocket,
      prepare: () => this.prepare(tenantId),
      connectGemini: openGeminiSocket,
      model: settings.model,
      voiceName: settings.voiceName,
    });
    this.session = session;
    // The call is written to the clinic's history after the browser disconnects, so keep this object alive for it.
    const running = session.run().finally(() => {
      if (this.session === session) this.session = null;
    });
    this.ctx.waitUntil(running);

    // Operational problems from here on are reported over the open socket, because a browser cannot
    // read the body of a failed WebSocket handshake.
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': VOICE_SUBPROTOCOL } });
  }

  private async prepare(tenantId: string): Promise<PreparedSession> {
    let company: Awaited<ReturnType<typeof getCompany>>;
    let secrets: Awaited<ReturnType<typeof readTenantProviderSecrets>>;
    try {
      [company, secrets] = await Promise.all([getCompany(tenantId), readTenantProviderSecrets(tenantId)]);
    } catch (error) {
      if (error instanceof SecretsUnreadableError) throw new SessionStartError(SECRETS_UNREADABLE_PROBLEM);
      throw new SessionStartError('Business voice configuration is unavailable.');
    }
    if (company.id.toLowerCase() !== tenantId || !company.is_active) throw new SessionStartError('This business is unavailable.');
    if (company.agent_status !== 'live') throw new SessionStartError('This business has no provisioned voice agent.');
    const geminiApiKey = secrets.geminiApiKey?.trim();
    if (!geminiApiKey) throw new SessionStartError('The business voice service is not configured. Add a Gemini API key.');

    const config = normalizeClinicConfig(company);
    let cal: CalComClient | null = null;
    let calError: string | null = null;
    try {
      cal = CalComClient.create(config.calcom, secrets.calcomApiKey, { baseUrl: developmentUrl('CALCOM_API_URL') });
    } catch (error) {
      calError = error instanceof CalComError ? error.message : 'Cal.com scheduling is not configured';
    }
    const checkedScheduling = await checkScheduling(cal, calError, config.timezone);
    const scheduling = config.enabledActions.booking
      ? checkedScheduling
      : { available: false, reason: 'Booking is turned off in Reception setup.' };
    return { config, geminiApiKey, cal, calError, scheduling, store: supabaseCallStore(tenantId, databaseFromSecrets(secrets)) };
  }
}
