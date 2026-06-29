-- Autonomous trajectory builder jobs.

create table if not exists weles_trajectory_builds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null,
  platform text not null,
  url text not null,
  objective text not null,
  constraints jsonb not null default '{}'::jsonb,
  env jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  source_run_id uuid references account_action_logs(id) on delete set null,
  trajectory_id uuid references weles_trajectories(id) on delete set null,
  test_run_id uuid references account_action_logs(id) on delete set null,
  idempotency_key text,
  error text,
  result jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_weles_trajectory_builds_tenant_idempotency
  on weles_trajectory_builds(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_weles_trajectory_builds_status on weles_trajectory_builds(status);
create index if not exists idx_weles_trajectory_builds_source_run_id on weles_trajectory_builds(source_run_id);
create index if not exists idx_weles_trajectory_builds_trajectory_id on weles_trajectory_builds(trajectory_id);
create index if not exists idx_weles_trajectory_builds_test_run_id on weles_trajectory_builds(test_run_id);

alter table weles_trajectory_builds enable row level security;
