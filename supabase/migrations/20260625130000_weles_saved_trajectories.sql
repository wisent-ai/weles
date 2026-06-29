-- Saved/promoted generic browser trajectories.
alter table weles_api_keys alter column scopes set default array['runs:create', 'runs:read', 'runs:cancel', 'actions:read', 'trajectories:read', 'trajectories:write'];


create table if not exists weles_trajectories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null,
  action text not null,
  site text not null,
  url text not null,
  objective text not null,
  definition jsonb not null default '{}'::jsonb,
  created_from_run_id uuid references account_action_logs(id) on delete set null,
  status text not null default 'active',
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_weles_trajectories_tenant_action
  on weles_trajectories(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), action);
create index if not exists idx_weles_trajectories_status on weles_trajectories(status);
create index if not exists idx_weles_trajectories_site on weles_trajectories(site);
create index if not exists idx_weles_trajectories_created_from_run_id on weles_trajectories(created_from_run_id);

alter table weles_trajectories enable row level security;
