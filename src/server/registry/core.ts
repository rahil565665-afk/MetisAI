import type { Company } from '../types.js';

/**
 * The console's registry: the list of clinics, their non-secret settings, and each clinic's
 * encrypted credential blob. It is the only state the console itself keeps. Everything a clinic
 * generates (call logs, appointments) is written to that clinic's own Supabase project instead.
 *
 * The logic is written against a tiny key-value interface so the same code runs on Durable Object
 * storage in production and on a plain Map in tests and local development.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<T[]>;
}

export interface SecretRecord {
  tenant_id: string;
  ciphertext: string;
  nonce: string;
  key_version: number;
  created_at: string;
  updated_at: string;
}

export interface NewCompany {
  id?: string;
  slug: string;
  name: string;
  business_type: string;
  timezone: string;
  receptionist_config: Company['receptionist_config'];
}

export type CompanyChanges = Partial<Pick<Company,
  'name' | 'business_type' | 'timezone' | 'is_active' | 'receptionist_config' | 'agent_status' | 'integration_status'>>;

/** Everything the registry holds, for a downloadable backup. Credentials stay encrypted. */
export interface BackupData { companies: Company[]; secrets: SecretRecord[] }

export interface RestoreResult { restored: number; skipped: number; renamed: number }

export type CreateResult = { ok: true; company: Company } | { ok: false; reason: 'slug_taken' };

export interface RegistryApi {
  listCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | null>;
  createCompany(input: NewCompany): Promise<CreateResult>;
  updateCompany(id: string, changes: CompanyChanges): Promise<Company | null>;
  getSecretRecord(id: string): Promise<SecretRecord | null>;
  putSecretRecord(id: string, record: Pick<SecretRecord, 'ciphertext' | 'nonce' | 'key_version'>): Promise<void>;
  deleteSecretRecord(id: string): Promise<void>;
  exportAll(): Promise<BackupData>;
  importAll(data: BackupData): Promise<RestoreResult>;
}

const COMPANY_PREFIX = 'company:';
const SECRET_PREFIX = 'secret:';

export class RegistryCore implements RegistryApi {
  constructor(private readonly store: KeyValueStore, private readonly now: () => Date = () => new Date()) {}

  async listCompanies(): Promise<Company[]> {
    const companies = await this.store.list<Company>(COMPANY_PREFIX);
    return companies.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getCompany(id: string): Promise<Company | null> {
    return (await this.store.get<Company>(`${COMPANY_PREFIX}${id}`)) ?? null;
  }

  async createCompany(input: NewCompany): Promise<CreateResult> {
    const existing = await this.store.list<Company>(COMPANY_PREFIX);
    if (existing.some((company) => company.slug === input.slug)) return { ok: false, reason: 'slug_taken' };
    const at = this.now().toISOString();
    const company: Company = {
      id: input.id ?? crypto.randomUUID(),
      slug: input.slug,
      name: input.name,
      business_type: input.business_type,
      is_active: true,
      timezone: input.timezone,
      receptionist_config: input.receptionist_config,
      agent_status: 'not_created',
      integration_status: {},
      created_at: at,
      updated_at: at,
    };
    await this.store.put(`${COMPANY_PREFIX}${company.id}`, company);
    return { ok: true, company };
  }

  async updateCompany(id: string, changes: CompanyChanges): Promise<Company | null> {
    const current = await this.getCompany(id);
    if (!current) return null;
    const next: Company = { ...current, ...changes, id: current.id, slug: current.slug, created_at: current.created_at, updated_at: this.now().toISOString() };
    await this.store.put(`${COMPANY_PREFIX}${id}`, next);
    return next;
  }

  async getSecretRecord(id: string): Promise<SecretRecord | null> {
    return (await this.store.get<SecretRecord>(`${SECRET_PREFIX}${id}`)) ?? null;
  }

  async putSecretRecord(id: string, record: Pick<SecretRecord, 'ciphertext' | 'nonce' | 'key_version'>): Promise<void> {
    const previous = await this.getSecretRecord(id);
    const at = this.now().toISOString();
    await this.store.put<SecretRecord>(`${SECRET_PREFIX}${id}`, {
      tenant_id: id,
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      key_version: record.key_version,
      created_at: previous?.created_at ?? at,
      updated_at: at,
    });
  }

  async deleteSecretRecord(id: string): Promise<void> {
    await this.store.delete(`${SECRET_PREFIX}${id}`);
  }

  async exportAll(): Promise<BackupData> {
    return {
      companies: await this.listCompanies(),
      secrets: await this.store.list<SecretRecord>(SECRET_PREFIX),
    };
  }

  /**
   * Add clinics from a backup. A clinic that already exists is never overwritten, and a service name that is
   * already taken by a different clinic gets a number added, so a restore can only ever add.
   */
  async importAll(data: BackupData): Promise<RestoreResult> {
    const existing = await this.store.list<Company>(COMPANY_PREFIX);
    const ids = new Set(existing.map((company) => company.id));
    const slugs = new Set(existing.map((company) => company.slug));
    const secrets = new Map(data.secrets.map((record) => [record.tenant_id, record]));
    const result: RestoreResult = { restored: 0, skipped: 0, renamed: 0 };
    for (const company of data.companies) {
      if (ids.has(company.id)) { result.skipped += 1; continue; }
      let slug = company.slug;
      for (let n = 2; slugs.has(slug); n += 1) slug = `${company.slug}-${n}`;
      if (slug !== company.slug) result.renamed += 1;
      await this.store.put(`${COMPANY_PREFIX}${company.id}`, { ...company, slug });
      const record = secrets.get(company.id);
      if (record) await this.store.put(`${SECRET_PREFIX}${company.id}`, record);
      ids.add(company.id);
      slugs.add(slug);
      result.restored += 1;
    }
    return result;
  }
}

/** In-memory store for tests and plain-Node local development. */
export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return data.has(key) ? structuredClone(data.get(key)) as T : undefined;
    },
    async put<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      data.delete(key);
    },
    async list<T>(prefix: string) {
      return [...data.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value) as T);
    },
  };
}
