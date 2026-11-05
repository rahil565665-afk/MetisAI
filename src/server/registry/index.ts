import { HttpError } from '../http.js';
import type { Company, IntegrationState } from '../types.js';
import { RegistryCore, memoryStore, type CompanyChanges, type NewCompany, type RegistryApi, type SecretRecord } from './core.js';

export type { CompanyChanges, NewCompany, RegistryApi, SecretRecord } from './core.js';

let configured: RegistryApi | undefined;
let developmentFallback: RegistryApi | undefined;

/** The Worker installs the Durable Object registry; tests install an in-memory one. */
export function configureRegistry(next: RegistryApi | undefined): void {
  configured = next;
}

function registry(): RegistryApi {
  if (configured) return configured;
  // Only an explicit local development run may keep clinics in memory; anywhere else a missing
  // registry must fail loudly instead of quietly losing data.
  if (process.env.NODE_ENV === 'development') return (developmentFallback ??= new RegistryCore(memoryStore()));
  throw new Error('The clinic registry is not configured.');
}

export async function listCompanies(): Promise<Company[]> {
  return registry().listCompanies();
}

export async function getCompany(id: string): Promise<Company> {
  const company = await registry().getCompany(id);
  if (!company) throw new HttpError(404, 'That clinic was not found.');
  return company;
}

export async function createCompany(input: NewCompany): Promise<Company> {
  const result = await registry().createCompany(input);
  if (!result.ok) throw new HttpError(409, 'A clinic with that service slug already exists. Choose a different slug.');
  return result.company;
}

export async function updateCompany(id: string, changes: CompanyChanges): Promise<Company> {
  const company = await registry().updateCompany(id, changes);
  if (!company) throw new HttpError(404, 'That clinic was not found.');
  return company;
}

export async function updateIntegrationStatus(id: string, provider: string, status: IntegrationState): Promise<Company> {
  const company = await getCompany(id);
  return updateCompany(id, { integration_status: { ...company.integration_status, [provider]: status } });
}

export async function getSecretRecord(id: string): Promise<SecretRecord | null> {
  return registry().getSecretRecord(id);
}

export async function putSecretRecord(id: string, record: Pick<SecretRecord, 'ciphertext' | 'nonce' | 'key_version'>): Promise<void> {
  await registry().putSecretRecord(id, record);
}

export async function deleteSecretRecord(id: string): Promise<void> {
  await registry().deleteSecretRecord(id);
}
