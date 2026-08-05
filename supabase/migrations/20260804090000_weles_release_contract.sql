-- Expand-only release-contract migration. Existing readers remain compatible.

create table if not exists weles_schema_migrations (
  version integer primary key check (version > 0),
  migration_name text not null unique,
  source_revision text not null check (source_revision ~ '^[0-9a-f]{40}$' or source_revision = 'baseline'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now(),
  applied_by text not null
);

insert into weles_schema_migrations (version, migration_name, source_revision, checksum, applied_by)
values
  (1, '001_weles_schema.sql', 'baseline', '181188e29c91ff2016d1b0a6a9e733626b87ec60078b37e748cbacab44ba57f2', '005_weles_release_contract.sql'),
  (2, '002_weles_public_api.sql', 'baseline', 'b13d77863658bf95c4745c55e2d415919fad6fcd401cbd777e02a08456b8383a', '005_weles_release_contract.sql'),
  (3, '003_weles_saved_trajectories.sql', 'baseline', 'b99aca041b753f8964f29cd8c9141ce621ed3d26ac1dfa43d5d49a3b437907fd', '005_weles_release_contract.sql'),
  (4, '004_weles_trajectory_builds.sql', 'baseline', '8ceb390efe9f9113414df2ca49b0d87b969d71a923e67d9609543c3ecfafdc77', '005_weles_release_contract.sql'),
  (5, '005_weles_release_contract.sql', '0a727938e0376bc892f49136319a5744dafbcbad', '504a5f9f6d2149ea5f3786c0c71a0c329ec97b534908c79161fd1fe2ec4c15ef', '005_weles_release_contract.sql')
on conflict (version) do nothing;

alter table account_action_logs add column if not exists api_schema text;
alter table account_action_logs add column if not exists origin text;
alter table account_action_logs add column if not exists credential_refs text[] not null default '{}';
alter table account_action_logs add column if not exists evidence_policy text not null default 'receipt';
alter table account_action_logs add column if not exists justification text;
alter table account_action_logs add column if not exists cancel_reason text;
alter table account_action_logs add column if not exists cancel_idempotency_key text;
alter table account_action_logs add column if not exists request_fingerprint text;
alter table account_action_logs add column if not exists receipt jsonb;
alter table account_action_logs add column if not exists lease_generation bigint not null default 0;
alter table account_action_logs add column if not exists lease_deployment_id text;

create index if not exists idx_account_action_logs_api_schema on account_action_logs(api_schema) where api_schema is not null;
create index if not exists idx_account_action_logs_origin on account_action_logs(origin) where origin is not null;

create table if not exists weles_deployment_receipts (
  deployment_id text not null,
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  host_id text not null,
  ring text not null check (ring in ('candidate', 'development', 'canary', 'production')),
  worker_version text not null,
  source_revision text not null check (source_revision ~ '^[0-9a-f]{40}$'),
  web_deployment_id text not null,
  web_source_revision text not null check (web_source_revision ~ '^[0-9a-f]{40}$'),
  worker_artifact_sha256 text not null check (worker_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  chromium_release text not null,
  chromium_artifact_sha256 text not null check (chromium_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  firefox_artifact_sha256 text not null check (firefox_artifact_sha256 ~ '^[0-9a-f]{64}$'),
  client_minimum_version text not null,
  firefox_release text not null,
  database_schema_version integer not null check (database_schema_version > 0),
  status text not null check (status in ('installed', 'activated', 'rolled_back', 'failed')),
  previous_manifest_sha256 text,
  evidence jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  primary key (manifest_sha256, host_id, status, recorded_at)
);

alter table weles_schema_migrations enable row level security;
alter table weles_deployment_receipts add column if not exists deployment_id text;
alter table weles_deployment_receipts add column if not exists web_deployment_id text;
alter table weles_deployment_receipts add column if not exists web_source_revision text;
alter table weles_deployment_receipts add column if not exists chromium_artifact_sha256 text;
alter table weles_deployment_receipts add column if not exists firefox_artifact_sha256 text;
alter table weles_deployment_receipts add column if not exists client_minimum_version text;
alter table weles_deployment_receipts enable row level security;

create or replace function enforce_weles_worker_lease()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  active_lease jsonb;
begin
  if old.status = 'queued' and new.status = 'running' then
    select value into active_lease
    from system_settings
    where key = 'weles_active_worker_lease';

    if active_lease is not null and (
      new.lease_deployment_id is distinct from active_lease->>'deploymentId'
      or new.lease_generation is distinct from (active_lease->>'generation')::bigint
    ) then
      raise exception 'worker lease does not match active deployment'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_weles_worker_lease_on_claim on account_action_logs;
create trigger enforce_weles_worker_lease_on_claim
before update on account_action_logs
for each row execute function enforce_weles_worker_lease();
