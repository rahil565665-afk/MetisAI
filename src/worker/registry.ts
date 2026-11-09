import { DurableObject } from 'cloudflare:workers';
import {
  RegistryCore,
  type BackupData,
  type CompanyChanges,
  type CreateResult,
  type KeyValueStore,
  type NewCompany,
  type RegistryApi,
  type RestoreResult,
  type SecretRecord,
} from '../server/registry/core.js';
import type { Company } from '../server/types.js';

function durableStore(storage: DurableObjectStorage): KeyValueStore {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    put: async <T>(key: string, value: T) => { await storage.put(key, value); },
    delete: async (key) => { await storage.delete(key); },
    list: async <T>(prefix: string) => [...(await storage.list<T>({ prefix })).values()],
  };
}

/**
 * The console's clinic registry: one Durable Object (named "registry") holding the clinic list,
 * their non-secret settings and each clinic's encrypted credentials. It uses Cloudflare's free
 * SQLite-backed storage, so no database has to be created or connected. Clinic call history is not
 * kept here; it goes to each clinic's own Supabase project.
 *
 * Each method runs to completion before another one starts reading its storage, so read-then-write
 * updates (such as a slug uniqueness check) cannot interleave.
 */
export class Registry extends DurableObject implements RegistryApi {
  private readonly core: RegistryCore;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.core = new RegistryCore(durableStore(ctx.storage));
  }

  listCompanies(): Promise<Company[]> { return this.core.listCompanies(); }
  getCompany(id: string): Promise<Company | null> { return this.core.getCompany(id); }
  createCompany(input: NewCompany): Promise<CreateResult> { return this.core.createCompany(input); }
  updateCompany(id: string, changes: CompanyChanges): Promise<Company | null> { return this.core.updateCompany(id, changes); }
  getSecretRecord(id: string): Promise<SecretRecord | null> { return this.core.getSecretRecord(id); }
  putSecretRecord(id: string, record: Pick<SecretRecord, 'ciphertext' | 'nonce' | 'key_version'>): Promise<void> { return this.core.putSecretRecord(id, record); }
  deleteSecretRecord(id: string): Promise<void> { return this.core.deleteSecretRecord(id); }
  exportAll(): Promise<BackupData> { return this.core.exportAll(); }
  importAll(data: BackupData): Promise<RestoreResult> { return this.core.importAll(data); }
}
