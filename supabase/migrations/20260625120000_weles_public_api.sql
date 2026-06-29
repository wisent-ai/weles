-- Public/internal API support for queued Weles runs.

alter table account_action_logs add column if not exists tenant_id uuid;
alter table account_action_logs add column if not exists idempotency_key text;
alter table account_action_logs add column if not exists priority integer not null default 0;
alter table account_action_logs add column if not exists webhook_url text;
alter table account_action_logs add column if not exists cancel_requested boolean not null default false;
alter table account_action_logs add column if not exists queued_by text;

create index if not exists idx_account_action_logs_tenant_id on account_action_logs(tenant_id);
create index if not exists idx_account_action_logs_idempotency_key on account_action_logs(idempotency_key) where idempotency_key is not null;
create index if not exists idx_account_action_logs_priority_schedule on account_action_logs(status, priority desc, scheduled_at asc);

create unique index if not exists idx_account_action_logs_tenant_idempotency
  on account_action_logs(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key)
  where idempotency_key is not null;

create table if not exists weles_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  label text not null,
  key_hash text not null unique,
  scopes text[] not null default array['runs:create', 'runs:read', 'runs:cancel', 'actions:read'],
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index if not exists idx_weles_api_keys_tenant_id on weles_api_keys(tenant_id);
create index if not exists idx_weles_api_keys_revoked_at on weles_api_keys(revoked_at);

alter table weles_api_keys enable row level security;
