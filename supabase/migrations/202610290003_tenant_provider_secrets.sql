-- Encrypted provider credentials are isolated from company metadata and appointment data.
create table public.tenant_provider_secrets (
  tenant_id uuid primary key references public.companies(id) on delete cascade,
  ciphertext text not null,
  nonce text not null,
  key_version smallint not null check (key_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tenant_provider_secrets is
  'Per-clinic provider secrets encrypted by the server with AES-256-GCM; ciphertext is base64url and includes the authentication tag.';
comment on column public.tenant_provider_secrets.ciphertext is
  'Base64url AES-256-GCM ciphertext concatenated with the 16-byte authentication tag.';
comment on column public.tenant_provider_secrets.nonce is
  'Base64url AES-256-GCM nonce (12 bytes).';
comment on column public.tenant_provider_secrets.key_version is
  'Encryption key format/version identifier used to decrypt ciphertext.';

alter table public.tenant_provider_secrets enable row level security;
revoke all on table public.tenant_provider_secrets from anon, authenticated;
grant all on table public.tenant_provider_secrets to service_role;
