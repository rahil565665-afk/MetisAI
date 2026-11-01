-- Add Render deployment metadata for one independently hosted Pipecat service per clinic.
-- Provider API keys remain in service-level Render environment variables, not in Supabase.
-- Apply after 202610260001_initial_schema.sql using the Supabase SQL Editor or CLI.

alter table public.companies
  add column if not exists render_service_id text,
  add column if not exists render_service_url text,
  add column if not exists render_deployment_status text not null default 'not_created',
  add column if not exists render_last_deploy_id text,
  add column if not exists render_last_deploy_at timestamptz,
  add column if not exists integration_status jsonb not null default '{}'::jsonb;

create unique index if not exists companies_render_service_id_unique
  on public.companies (render_service_id)
  where render_service_id is not null;

create index if not exists companies_render_status_idx
  on public.companies (render_deployment_status);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'companies_render_deployment_status_check'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
      add constraint companies_render_deployment_status_check
      check (render_deployment_status in ('not_created', 'creating', 'building', 'live', 'failed', 'suspended'));
  end if;
end $$;

comment on column public.companies.render_service_id is
  'Render service identifier only; provider credential values are never stored in this table.';
comment on column public.companies.render_service_url is
  'Public service URL; status is not a guarantee that a free service is awake.';
comment on column public.companies.integration_status is
  'Presence-only status metadata such as configured, updatedAt and deployment status; never store provider keys here.';

-- Restrict the new fields to the same server-only policy as the existing company table.
-- The service_role grant and RLS policy from the initial schema continue to apply.
