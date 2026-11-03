export interface ClinicAgentStatus {
  provisioned: boolean;
  /** True while a voice test call is in progress for this clinic. */
  inCall: boolean;
  status: 'idle' | 'in_call' | 'unavailable';
}

export interface ClinicAgentRuntime {
  /** Read state only. */
  status(tenantId: string): Promise<ClinicAgentStatus>;
  /** End the clinic's in-progress voice test, if any. Resolves true when a call was ended. */
  endCall(tenantId: string): Promise<boolean>;
}

const unavailableRuntime: ClinicAgentRuntime = {
  async status() {
    return { provisioned: false, inCall: false, status: 'unavailable' };
  },
  async endCall() {
    throw new Error('The clinic voice agent is unavailable in this environment.');
  },
};

let configuredRuntime: ClinicAgentRuntime | undefined;

/** Install the runtime adapter supplied by the current execution environment (the Cloudflare Worker). */
export function configureClinicAgentRuntime(runtime: ClinicAgentRuntime): void {
  configuredRuntime = runtime;
}

/** Return the configured adapter, or an explicit unavailable implementation in local Node. */
export function getClinicAgentRuntime(): ClinicAgentRuntime {
  return configuredRuntime ?? unavailableRuntime;
}
