-- Initial schema for the multi-tenant AI receptionist.
-- The existing public.appointments table belongs to an older CRM schema. Leave it intact;
-- this application uses public.receptionist_appointments to avoid changing legacy data.
-- The dashboard server's elevated key bypasses RLS, so every API route must enforce its
-- passcode-session role and tenant scope before reading or changing a clinic's data.

create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  manus_open_id text not null unique,
  email text not null,
  display_name text not null default '',
  is_platform_admin boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  business_type text not null default 'dental_clinic',
  is_active boolean not null default true,
  timezone text not null default 'America/New_York',
  receptionist_config jsonb not null default '{"greeting":"Thank you for calling. How can I help you today?","faqs":[],"transfer_enabled":true}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint companies_name_length check (char_length(name) between 1 and 160),
  constraint companies_timezone_length check (char_length(timezone) between 1 and 64)
);

create table if not exists public.tenant_memberships (
  tenant_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role text not null check (role in ('owner', 'manager', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists public.receptionist_appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.companies(id) on delete cascade,
  cal_booking_uid text not null,
  status text not null default 'accepted' check (status in ('accepted', 'pending', 'cancelled', 'rescheduled', 'rejected', 'unknown')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  appointment_type text not null default 'dental_visit',
  attendee_name text not null,
  attendee_email text,
  attendee_phone text,
  last_call_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, cal_booking_uid)
);
create index if not exists receptionist_appointments_tenant_start_idx on public.receptionist_appointments (tenant_id, starts_at desc);

create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references public.app_users(id) on delete set null,
  transport text not null check (transport in ('browser', 'twilio')),
  status text not null default 'active' check (status in ('active', 'completed', 'error', 'transfer_requested')),
  caller_name text,
  caller_phone text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  transfer_requested boolean not null default false,
  transfer_reason text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists call_logs_tenant_started_idx on public.call_logs (tenant_id, started_at desc);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.companies(id) on delete cascade,
  call_id uuid not null references public.call_logs(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists conversation_messages_call_idx on public.conversation_messages (tenant_id, call_id, created_at);

alter table public.app_users enable row level security;
alter table public.companies enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.receptionist_appointments enable row level security;
alter table public.call_logs enable row level security;
alter table public.conversation_messages enable row level security;

-- No browser role accesses these tables directly. The server uses a Supabase
-- secret key only after checking application role and tenant scope.
revoke all on table public.app_users, public.companies, public.tenant_memberships,
  public.receptionist_appointments, public.call_logs,
  public.conversation_messages from anon, authenticated;
grant all on table public.app_users, public.companies, public.tenant_memberships,
  public.receptionist_appointments, public.call_logs,
  public.conversation_messages to service_role;

grant usage on schema public to service_role;
