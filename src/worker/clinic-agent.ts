import { DurableObject } from 'cloudflare:workers';
import { getCompany } from '../server/integrations/supabase.js';
import { voiceTokenSigningKeyHex } from '../server/config.js';
import { readTenantProviderSecrets, type TenantProviderSecrets } from '../server/integrations/tenantProviderSecrets.js';
import type { ClinicContainerStatus } from '../server/container-runtime.js';
import { AGENT_PORT, UUID_PATTERN, agentEnv, bearerToken, validOrigin, verifyVoiceToken } from './voiceAuth.js';

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
const HEALTH_ATTEMPTS = 150;
const HEALTH_INTERVAL_MS = 200;

export interface ClinicAgentEnv {
  APP_PUBLIC_URL: string;
}

type ContainerHandle = NonNullable<DurableObjectState['container']>;

function reject(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * One Durable Object (named by clinic UUID) owns one Container running the Pipecat agent.
 * The Container starts only when an authorized voice request reaches this object and is
 * stopped by Cloudflare after a period of inactivity. Nothing here pings or keeps it awake.
 */
export class ClinicAgent extends DurableObject<ClinicAgentEnv> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: ClinicAgentEnv) {
    super(ctx, env);
    const container = this.ctx.container;
    if (container?.running) {
      void this.ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  /** Read-only status for the dashboard. Never starts or wakes the Container. */
  async status(tenantId: string): Promise<ClinicContainerStatus> {
    if (!UUID_PATTERN.test(tenantId)) throw new Error('Invalid clinic identifier.');
    const running = this.ctx.container?.running ?? false;
    return { provisioned: true, runtimeReady: running, status: running ? 'running' : 'stopped' };
  }

  /** Stop immediately so changed credentials take effect on the next voice request. */
  async stop(tenantId: string): Promise<void> {
    if (!UUID_PATTERN.test(tenantId)) throw new Error('Invalid clinic identifier.');
    const container = this.ctx.container;
    if (container?.running) await container.destroy('Clinic agent stopped by dashboard request');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/agents\/([^/]+)\/(health|ws)$/.exec(url.pathname);
    if (!match) return reject(404, 'Not found.');
    const tenantId = match[1]!.toLowerCase();
    const route = match[2]!;
    if (!UUID_PATTERN.test(tenantId)) return reject(400, 'Invalid clinic identifier.');
    if (route === 'health' && request.method !== 'GET') return reject(405, 'Method not allowed.');
    if (route === 'ws' && (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket')) {
      return reject(426, 'WebSocket upgrade required.');
    }
    if (!validOrigin(request, this.env.APP_PUBLIC_URL, route === 'ws')) return reject(403, 'Request Origin is not allowed.');

    let signingSecret: string;
    try {
      signingSecret = voiceTokenSigningKeyHex(tenantId);
    } catch {
      return reject(503, 'Clinic voice authentication is unavailable.');
    }
    const token = bearerToken(request) ?? url.searchParams.get('token');
    const claims = await verifyVoiceToken(token, tenantId, signingSecret);
    if (!claims) return reject(401, 'A valid clinic voice token is required.');

    let company: Awaited<ReturnType<typeof getCompany>>;
    let secrets: TenantProviderSecrets;
    try {
      [company, secrets] = await Promise.all([getCompany(tenantId), readTenantProviderSecrets(tenantId)]);
    } catch {
      return reject(503, 'Clinic agent configuration is unavailable.');
    }
    if (company.id.toLowerCase() !== tenantId || !company.is_active) return reject(403, 'This clinic is unavailable.');
    const configuredMode = company.receptionist_config?.voice_output_mode === 'cartesia' ? 'cartesia' : 'native';
    if (claims.voiceOutputMode !== configuredMode) return reject(401, 'The clinic voice token is no longer valid.');
    if (!secrets.geminiApiKey?.trim()) return reject(503, 'The clinic voice service is not configured.');
    if (configuredMode === 'cartesia' && !secrets.cartesiaApiKey?.trim()) return reject(503, 'The clinic voice service is not configured.');

    const container = this.ctx.container;
    if (!container) return reject(503, 'Clinic agent containers are unavailable.');
    try {
      await this.startAndWaitForHealth(container, agentEnv(tenantId, signingSecret, this.env.APP_PUBLIC_URL, configuredMode, secrets));
      const target = new URL(request.url);
      target.protocol = 'http:';
      target.host = 'container';
      target.pathname = route === 'health' ? '/health' : '/ws';
      // The health route never needs the bearer token inside the container; /ws keeps its query token.
      if (route === 'health') target.search = '';
      const forwarded = new Request(target, request);
      forwarded.headers.delete('host');
      if (route === 'health') forwarded.headers.delete('authorization');
      return await container.getTcpPort(AGENT_PORT).fetch(forwarded);
    } catch {
      return reject(502, 'Clinic agent could not be reached.');
    }
  }

  private async startAndWaitForHealth(container: ContainerHandle, startupEnv: Record<string, string>): Promise<void> {
    this.starting ??= this.startAndWait(container, startupEnv).finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async startAndWait(container: ContainerHandle, startupEnv: Record<string, string>): Promise<void> {
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: 'lite',
        enableInternet: true,
        env: startupEnv,
      });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(AGENT_PORT);
    let lastError: unknown;
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      try {
        const response = await port.fetch('http://container/health', { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`Health endpoint returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await scheduler.wait(HEALTH_INTERVAL_MS);
    }
    throw new Error(`Clinic agent did not become ready on port ${AGENT_PORT}.`, { cause: lastError });
  }
}
