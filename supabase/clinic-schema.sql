-- MetisAI: tables for ONE clinic's own Supabase project.
--
-- Run this once per clinic, in that clinic's Supabase project:
--   Supabase dashboard -> SQL Editor -> New query -> paste this whole file -> Run.
-- It is safe to run again; nothing is deleted or overwritten.
--
-- The console never stores clinic data itself. Call history and appointments are written straight to the
-- project whose URL and secret key you give the console when you add (or later edit) the clinic.

create extension if not exists pgcrypto;

create table if not exists public.call_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
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

create table if not exists public.receptionist_appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
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

-- A project that was set up with an earlier version of this schema had these tables point at a shared
-- "companies" table. That table no longer exists in the design, so drop the old links (a no-op otherwise).
alter table public.call_logs drop constraint if exists call_logs_tenant_id_fkey;
alter table public.call_logs drop constraint if exists call_logs_user_id_fkey;
alter table public.receptionist_appointments drop constraint if exists receptionist_appointments_tenant_id_fkey;

-- Nothing in a browser may read these tables directly. Only the clinic's secret key (which Supabase maps
-- to the service_role) can, and the console keeps that key encrypted on the server.
alter table public.call_logs enable row level security;
alter table public.receptionist_appointments enable row level security;
revoke all on table public.call_logs, public.receptionist_appointments from anon, authenticated;
grant all on table public.call_logs, public.receptionist_appointments to service_role;
grant usage on schema public to service_role;
