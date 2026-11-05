import { env } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { app } from '../server/app.js';
import { configureLoginRateLimiter } from '../server/auth/passcode.js';
import { configureClinicAgentRuntime } from '../server/agent-runtime.js';
import { configureRegistry } from '../server/registry/index.js';
import { ClinicAgent } from './clinic-agent.js';
import { LoginLimiter } from './login-limiter.js';
import { Registry } from './registry.js';
import { UUID_PATTERN } from './voiceAuth.js';

export { ClinicAgent, LoginLimiter, Registry };

const EXPRESS_PORT = 3000;
app.listen(EXPRESS_PORT);

function agentStub(tenantId: string) {
  if (!UUID_PATTERN.test(tenantId)) throw new Error('Invalid clinic identifier.');
  return (env.CLINIC_AGENTS as unknown as DurableObjectNamespace<ClinicAgent>).getByName(tenantId.toLowerCase());
}

function limiterStub(key: string) {
  return (env.LOGIN_LIMITER as unknown as DurableObjectNamespace<LoginLimiter>).getByName(key);
}

function registryStub() {
  return (env.REGISTRY as unknown as DurableObjectNamespace<Registry>).getByName('registry');
}

// Bindings are read lazily inside these callbacks, never at module load.
configureRegistry({
  listCompanies: () => registryStub().listCompanies() as ReturnType<Registry['listCompanies']>,
  getCompany: (id) => registryStub().getCompany(id) as ReturnType<Registry['getCompany']>,
  createCompany: (input) => registryStub().createCompany(input) as ReturnType<Registry['createCompany']>,
  updateCompany: (id, changes) => registryStub().updateCompany(id, changes) as ReturnType<Registry['updateCompany']>,
  getSecretRecord: (id) => registryStub().getSecretRecord(id) as ReturnType<Registry['getSecretRecord']>,
  putSecretRecord: (id, record) => registryStub().putSecretRecord(id, record),
  deleteSecretRecord: (id) => registryStub().deleteSecretRecord(id),
});

configureClinicAgentRuntime({
  status: (tenantId) => agentStub(tenantId).status(tenantId),
  endCall: (tenantId) => agentStub(tenantId).endCall(tenantId),
});

configureLoginRateLimiter({
  isBlocked: (key) => limiterStub(key).isBlocked(),
  recordFailure: (key) => limiterStub(key).recordFailure(),
  clear: (key) => limiterStub(key).clear(),
});

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request, workerEnv, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/agents/')) {
      const match = /^\/agents\/([^/]+)\/ws$/.exec(pathname);
      if (!match) return plain(404, 'Not found.');
      const tenantId = match[1]!.toLowerCase();
      if (!UUID_PATTERN.test(tenantId)) return plain(400, 'Invalid clinic identifier.');
      return workerEnv.CLINIC_AGENTS.getByName(tenantId).fetch(request);
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        return await handleAsNodeRequest(EXPRESS_PORT, request, workerEnv, ctx);
      } catch {
        return new Response(JSON.stringify({ error: 'The request could not be completed. Check configuration and try again.' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
    }

    // Everything else is a static dashboard asset (single-page-app fallback is handled by Workers Assets).
    return workerEnv.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
