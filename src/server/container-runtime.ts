export interface ClinicContainerStatus {
  provisioned: boolean;
  runtimeReady: boolean;
  status: string;
}

export interface ClinicContainerRuntime {
  /** Read state only. Implementations must not start or wake a Container. */
  status(tenantId: string): Promise<ClinicContainerStatus>;
  /** Stop the tenant Container immediately; the next voice request cold-starts it. */
  stop(tenantId: string): Promise<void>;
}

const unavailableRuntime: ClinicContainerRuntime = {
  async status() {
    return { provisioned: false, runtimeReady: false, status: 'unavailable' };
  },
  async stop() {
    throw new Error('Clinic Container runtime is unavailable in this environment.');
  },
};

let configuredRuntime: ClinicContainerRuntime | undefined;

/** Install the runtime adapter supplied by the current execution environment. */
export function configureClinicContainerRuntime(runtime: ClinicContainerRuntime): void {
  configuredRuntime = runtime;
}

/** Return the configured adapter, or an explicit unavailable implementation in local Node. */
export function getClinicContainerRuntime(): ClinicContainerRuntime {
  return configuredRuntime ?? unavailableRuntime;
}
