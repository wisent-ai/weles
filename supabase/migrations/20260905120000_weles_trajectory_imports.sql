-- Durable, tenant- and host-scoped adoption of existing Weles trajectory exports.
alter table public.weles_trajectories
  add column if not exists execution_host text,
  add column if not exists import_source_id uuid,
  add column if not exists import_source_sha256 text,
  add column if not exists import_source_document jsonb,
  add column if not exists imported_at timestamptz;

create unique index if not exists uq_weles_trajectories_tenant_import_source
  on public.weles_trajectories(tenant_id, import_source_id)
  where import_source_id is not null;

create index if not exists idx_weles_trajectories_tenant_execution_host
  on public.weles_trajectories(tenant_id, execution_host)
  where execution_host is not null;
