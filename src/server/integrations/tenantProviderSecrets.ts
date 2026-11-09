import { deleteSecretRecord, getSecretRecord, putSecretRecord } from '../registry/index.js';

export const PROVIDER_SECRET_KEYS = [
  'geminiApiKey',
  'calcomApiKey',
  'supabaseUrl',
  'supabaseSecretKey',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
] as const;

export type ProviderSecretKey = (typeof PROVIDER_SECRET_KEYS)[number];
export type TenantProviderSecrets = Partial<Record<ProviderSecretKey, string>>;
export type ProviderSecretUpdate = Partial<Record<ProviderSecretKey, string | null>>;
export type ProviderSecretConfiguredFlags = Record<ProviderSecretKey, boolean>;

/** The stored credentials exist but this Worker cannot decrypt them (the encryption key is not the one that saved them). */
export class SecretsUnreadableError extends Error {
  constructor() {
    super('Could not decrypt stored provider secrets. Verify the encryption key and stored record.');
    this.name = 'SecretsUnreadableError';
  }
}

export const SECRETS_UNREADABLE_PROBLEM = 'The saved key could not be read, because this Worker’s TENANT_CREDENTIALS_ENCRYPTION_KEY is not the one that saved it. Enter the key again here; the business and all its settings are kept.';

const KEY_VERSION = 1;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SECRET_KEY_SET = new Set<string>(PROVIDER_SECRET_KEYS);

function tenantContext(tenantId: string): Buffer {
  if (!tenantId || !tenantId.trim()) throw new Error('A tenant ID is required.');
  return Buffer.from(`dentdesk-provider-secrets:${KEY_VERSION}:${tenantId}`, 'utf8');
}

function encryptionKey(): Uint8Array {
  const configured = process.env.TENANT_CREDENTIALS_ENCRYPTION_KEY?.trim();
  if (!configured) throw new Error('TENANT_CREDENTIALS_ENCRYPTION_KEY must be configured.');

  if (/^[0-9a-fA-F]{64}$/.test(configured)) return Uint8Array.from(Buffer.from(configured, 'hex'));

  // Accept canonical, unpadded base64url only; Buffer's decoder is otherwise permissive.
  if (!/^[A-Za-z0-9_-]+$/.test(configured)) {
    throw new Error('TENANT_CREDENTIALS_ENCRYPTION_KEY must be 64 hexadecimal characters or base64url encoding of 32 bytes.');
  }
  const decoded = Buffer.from(configured, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== configured) {
    throw new Error('TENANT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return Uint8Array.from(decoded);
}

function arrayBufferCopy(value: ArrayLike<number>): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

async function importedEncryptionKey(usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto AES-GCM is unavailable.');
  return subtle.importKey('raw', arrayBufferCopy(encryptionKey()), { name: 'AES-GCM' }, false, [usage]);
}

export function assertTenantProviderSecretEncryptionKey(): void {
  void encryptionKey();
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto AES-GCM is unavailable.');
}

function decodeBase64Url(value: string, field: 'ciphertext' | 'nonce'): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Stored provider secret ${field} is invalid.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error(`Stored provider secret ${field} is invalid.`);
  return decoded;
}

function validateTenantSecrets(value: unknown): TenantProviderSecrets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored provider secret payload is invalid.');
  }

  const validated: TenantProviderSecrets = {};
  for (const [key, secret] of Object.entries(value)) {
    if (!SECRET_KEY_SET.has(key) || typeof secret !== 'string' || secret.length === 0) {
      throw new Error('Stored provider secret payload is invalid.');
    }
    validated[key as ProviderSecretKey] = secret;
  }
  return validated;
}

async function decryptRecord(
  tenantId: string,
  record: { ciphertext: string; nonce: string; key_version: number },
): Promise<TenantProviderSecrets> {
  if (record.key_version !== KEY_VERSION) throw new SecretsUnreadableError();

  let nonce: Buffer;
  let encrypted: Buffer;
  try {
    nonce = decodeBase64Url(record.nonce, 'nonce');
    encrypted = decodeBase64Url(record.ciphertext, 'ciphertext');
  } catch {
    throw new SecretsUnreadableError();
  }
  if (nonce.length !== NONCE_BYTES || encrypted.length <= AUTH_TAG_BYTES) throw new SecretsUnreadableError();

  try {
    const plaintext = await globalThis.crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: arrayBufferCopy(nonce),
      additionalData: arrayBufferCopy(tenantContext(tenantId)),
      tagLength: AUTH_TAG_BYTES * 8,
    }, await importedEncryptionKey('decrypt'), arrayBufferCopy(encrypted));
    const decoded = new TextDecoder().decode(plaintext);
    return validateTenantSecrets(JSON.parse(decoded) as unknown);
  } catch {
    // Do not expose secret material, authentication details, or crypto-library errors.
    throw new SecretsUnreadableError();
  }
}

async function encryptSecrets(tenantId: string, secrets: TenantProviderSecrets): Promise<{ ciphertext: string; nonce: string; key_version: number }> {
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  const encrypted = await globalThis.crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: arrayBufferCopy(nonce),
    additionalData: arrayBufferCopy(tenantContext(tenantId)),
    tagLength: AUTH_TAG_BYTES * 8,
  }, await importedEncryptionKey('encrypt'), arrayBufferCopy(new TextEncoder().encode(JSON.stringify(secrets))));
  return {
    ciphertext: Buffer.from(new Uint8Array(encrypted)).toString('base64url'),
    nonce: Buffer.from(nonce).toString('base64url'),
    key_version: KEY_VERSION,
  };
}

/** Read and decrypt a clinic's credentials. Never log or expose the returned values to clients. */
export async function readTenantProviderSecrets(tenantId: string): Promise<TenantProviderSecrets> {
  tenantContext(tenantId);
  const record = await getSecretRecord(tenantId);
  return record ? await decryptRecord(tenantId, record) : {};
}

/**
 * Like `readTenantProviderSecrets`, but a clinic whose saved keys cannot be decrypted is reported as
 * `unreadable` instead of failing. The clinic itself is still fine; only its keys need entering again.
 */
export async function readTenantProviderSecretsSafe(tenantId: string): Promise<{ secrets: TenantProviderSecrets; unreadable: boolean }> {
  try {
    return { secrets: await readTenantProviderSecrets(tenantId), unreadable: false };
  } catch (error) {
    if (error instanceof SecretsUnreadableError) return { secrets: {}, unreadable: true };
    throw error;
  }
}

/**
 * Merge a partial credential update, persist only encrypted material, and return presence flags.
 * Keys that can no longer be read are dropped rather than blocking the save, so a clinic can always be
 * repaired by entering its keys again.
 */
export async function mergeAndEncryptTenantProviderSecrets(
  tenantId: string,
  update: ProviderSecretUpdate,
): Promise<ProviderSecretConfiguredFlags> {
  tenantContext(tenantId);
  const current = (await readTenantProviderSecretsSafe(tenantId)).secrets;
  const merged: TenantProviderSecrets = { ...current };

  for (const [key, value] of Object.entries(update)) {
    if (!SECRET_KEY_SET.has(key)) throw new Error('Unsupported provider secret key.');
    if (value === undefined) continue;
    if (value === null) {
      delete merged[key as ProviderSecretKey];
    } else {
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Provider secret ${key} must be a non-empty string or null.`);
      }
      merged[key as ProviderSecretKey] = value;
    }
  }

  const encrypted = await encryptSecrets(tenantId, merged);
  await putSecretRecord(tenantId, encrypted);
  return configuredFlags(merged);
}

/** Return presence-only status; secret values are never included in the result. */
export async function getTenantProviderSecretConfiguredFlags(
  tenantId: string,
): Promise<ProviderSecretConfiguredFlags> {
  return configuredFlags(await readTenantProviderSecrets(tenantId));
}

/** Delete all encrypted provider credentials for a clinic. */
export async function clearTenantProviderSecrets(tenantId: string): Promise<void> {
  tenantContext(tenantId);
  await deleteSecretRecord(tenantId);
}

function configuredFlags(secrets: TenantProviderSecrets): ProviderSecretConfiguredFlags {
  return Object.fromEntries(PROVIDER_SECRET_KEYS.map((key) => [key, Boolean(secrets[key])])) as ProviderSecretConfiguredFlags;
}
