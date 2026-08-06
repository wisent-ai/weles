-- Fail-closed, one-attempt Apple authentication authorization and audit.
-- This migration intentionally exposes transitions only through service-role RPCs.

create table if not exists public.apple_auth_submit_guards (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'apple',
  account_id uuid not null references public.social_accounts(id) on delete restrict,
  state text not null default 'authorized',
  expires_at timestamptz not null,
  created_by text not null,
  reason text not null,
  execution_host text not null,
  execution_agent text not null,
  action_log_id uuid references public.account_action_logs(id) on delete restrict,
  lease_owner text,
  attempt_count integer not null default 0,
  real_password_submit_count integer not null default 0,
  authorized_at timestamptz not null default clock_timestamp(),
  lease_acquired_at timestamptz,
  password_submitted_at timestamptz,
  challenge_detected_at timestamptz,
  closing_at timestamptz,
  closed_at timestamptz,
  observable_postcondition text,
  failure_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint apple_auth_submit_guards_provider_check check (provider = 'apple'),
  constraint apple_auth_submit_guards_state_check check (
    state in ('authorized', 'password_submitted', 'challenge_open', 'closing', 'closed', 'failed_open')
  ),
  constraint apple_auth_submit_guards_text_check check (
    char_length(btrim(created_by)) between 1 and 200
    and char_length(btrim(reason)) between 1 and 1000
    and char_length(btrim(execution_host)) between 1 and 253
    and char_length(btrim(execution_agent)) between 1 and 200
    and (lease_owner is null or char_length(btrim(lease_owner)) between 1 and 500)
  ),
  constraint apple_auth_submit_guards_count_check check (
    attempt_count in (0, 1)
    and real_password_submit_count in (0, 1)
    and attempt_count = real_password_submit_count
  ),
  constraint apple_auth_submit_guards_expiry_check check (expires_at > authorized_at),
  constraint apple_auth_submit_guards_state_shape_check check (
    (
      state = 'authorized'
      and attempt_count = 0
      and password_submitted_at is null
      and challenge_detected_at is null
      and closing_at is null
      and closed_at is null
      and observable_postcondition is null
      and failure_reason is null
      and (
        (lease_owner is null and lease_acquired_at is null)
        or (action_log_id is not null and lease_owner is not null and lease_acquired_at is not null)
      )
    )
    or (
      state = 'password_submitted'
      and action_log_id is not null and lease_owner is not null and lease_acquired_at is not null
      and attempt_count = 1 and password_submitted_at is not null
      and challenge_detected_at is null and closing_at is null and closed_at is null
      and observable_postcondition is null and failure_reason is null
    )
    or (
      state = 'challenge_open'
      and action_log_id is not null and lease_owner is not null and lease_acquired_at is not null
      and attempt_count = 1 and password_submitted_at is not null and challenge_detected_at is not null
      and closing_at is null and closed_at is null
      and observable_postcondition is null and failure_reason is null
    )
    or (
      state = 'closing'
      and action_log_id is not null and lease_owner is not null and lease_acquired_at is not null
      and attempt_count = 1 and password_submitted_at is not null and closing_at is not null
      and closed_at is null and observable_postcondition is null and failure_reason is null
    )
    or (
      state = 'closed'
      and closed_at is not null and char_length(btrim(observable_postcondition)) > 0
      and failure_reason is null
      and (
        (attempt_count = 0 and password_submitted_at is null and challenge_detected_at is null)
        or (attempt_count = 1 and action_log_id is not null and password_submitted_at is not null and closing_at is not null)
      )
    )
    or (
      state = 'failed_open'
      and action_log_id is not null and lease_owner is not null and lease_acquired_at is not null
      and attempt_count = 1 and password_submitted_at is not null
      and closed_at is null and observable_postcondition is null
      and char_length(btrim(failure_reason)) > 0
    )
  )
);

create unique index if not exists apple_auth_submit_guards_one_active_per_account
  on public.apple_auth_submit_guards (provider, account_id)
  where state <> 'closed';

create unique index if not exists apple_auth_submit_guards_one_action_log
  on public.apple_auth_submit_guards (action_log_id)
  where action_log_id is not null;

create index if not exists apple_auth_submit_guards_account_created
  on public.apple_auth_submit_guards (account_id, created_at desc);

create table if not exists public.apple_auth_capability_envelopes (
  guard_id uuid primary key references public.apple_auth_submit_guards(id) on delete restrict,
  account_id uuid not null references public.social_accounts(id) on delete restrict,
  action_log_id uuid not null unique references public.account_action_logs(id) on delete restrict,
  email_capability_id text not null check (email_capability_id ~ '^[0-9a-f]{64}$'),
  password_capability_id text not null check (password_capability_id ~ '^[0-9a-f]{64}$'),
  two_factor_capability_id text not null check (two_factor_capability_id ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  constraint apple_auth_capability_envelopes_distinct check (
    email_capability_id <> password_capability_id
    and email_capability_id <> two_factor_capability_id
    and password_capability_id <> two_factor_capability_id
  )
);

create table if not exists public.apple_auth_events (
  id bigint generated always as identity primary key,
  guard_id uuid not null references public.apple_auth_submit_guards(id) on delete restrict,
  account_id uuid not null references public.social_accounts(id) on delete restrict,
  action_log_id uuid references public.account_action_logs(id) on delete restrict,
  event_type text not null,
  from_state text,
  to_state text,
  lease_owner text,
  detail text,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint apple_auth_events_type_check check (event_type in (
    'authorization_issued', 'authorization_bound', 'authorization_expired', 'authorization_cancelled',
    'lease_acquired', 'lease_denied', 'password_submit_authorized', 'password_submitted',
    'challenge_detected', 'challenge_code_captured', 'challenge_code_redeemed', 'challenge_close_attempted',
    'challenge_closed', 'cleanup_confirmed', 'cleanup_unconfirmed',
    'authorization_reuse_denied', 'retry_denied'
  )),
  constraint apple_auth_events_state_check check (
    (from_state is null or from_state in ('authorized', 'password_submitted', 'challenge_open', 'closing', 'closed', 'failed_open'))
    and (to_state is null or to_state in ('authorized', 'password_submitted', 'challenge_open', 'closing', 'closed', 'failed_open'))
  )
);

create index if not exists apple_auth_events_guard_time
  on public.apple_auth_events (guard_id, occurred_at, id);

alter table public.apple_auth_submit_guards enable row level security;
alter table public.apple_auth_events enable row level security;
alter table public.apple_auth_capability_envelopes enable row level security;
revoke all on table public.apple_auth_submit_guards from public, anon, authenticated;
revoke all on table public.apple_auth_events from public, anon, authenticated;
revoke all on table public.apple_auth_capability_envelopes from public, anon, authenticated;
grant select on table public.apple_auth_submit_guards, public.apple_auth_events to service_role;

create or replace function public.apple_auth_assert_account(p_account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.social_accounts a
    where a.id = p_account_id and pg_catalog.lower(a.platform) = 'apple'
  ) then
    raise exception using errcode = 'P0001', message = 'Apple auth account is missing or is not an Apple account';
  end if;
end;
$$;

create or replace function public.apple_auth_assert_action(p_action_log_id uuid, p_account_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.account_action_logs l
    where l.id = p_action_log_id and l.account_id = p_account_id
      and pg_catalog.lower(l.platform) = 'apple' and l.action = 'apple_login'
  ) then
    raise exception using errcode = 'P0001', message = 'Action log is not the canonical Apple login for this account';
  end if;
end;
$$;

create or replace function public.authorize_apple_auth_submit_guard(
  p_account_id uuid,
  p_created_by text,
  p_reason text,
  p_expires_at timestamptz,
  p_execution_host text,
  p_execution_agent text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_guard public.apple_auth_submit_guards%rowtype;
  v_expired public.apple_auth_submit_guards%rowtype;
begin
  perform public.apple_auth_assert_account(p_account_id);
  if p_expires_at is null or p_expires_at <= v_now then
    raise exception using errcode = '22023', message = 'Apple auth authorization expiry must be in the future';
  end if;
  if pg_catalog.char_length(pg_catalog.btrim(p_created_by)) not between 1 and 200
     or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 1 and 1000
     or pg_catalog.char_length(pg_catalog.btrim(p_execution_host)) not between 1 and 253
     or pg_catalog.char_length(pg_catalog.btrim(p_execution_agent)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'Invalid Apple auth authorization metadata';
  end if;

  for v_expired in
    select * from public.apple_auth_submit_guards
    where provider = 'apple' and account_id = p_account_id
      and state = 'authorized' and expires_at <= v_now
    for update
  loop
    update public.apple_auth_submit_guards
      set state = 'closed', closed_at = v_now,
          observable_postcondition = 'Authorization expired before claim or password submission', updated_at = v_now
      where id = v_expired.id;
    insert into public.apple_auth_events(
      guard_id, account_id, action_log_id, event_type, from_state, to_state, lease_owner, detail
    ) values(
      v_expired.id, p_account_id, v_expired.action_log_id, 'authorization_expired',
      'authorized', 'closed', v_expired.lease_owner, 'Expired before password submission'
    );
    delete from public.apple_auth_capability_envelopes where guard_id=v_expired.id;
  end loop;

  select * into v_guard from public.apple_auth_submit_guards
    where provider='apple' and account_id=p_account_id and state<>'closed'
    order by created_at desc limit 1 for update;
  if found then
    insert into public.apple_auth_events(
      guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail
    ) values(
      v_guard.id,v_guard.account_id,v_guard.action_log_id,'authorization_reuse_denied',
      v_guard.state,v_guard.state,v_guard.lease_owner,
      'A second authorization was requested while this provider/account remains active'
    );
    return;
  end if;

  insert into public.apple_auth_submit_guards(
    account_id, expires_at, created_by, reason, execution_host, execution_agent
  ) values (
    p_account_id, p_expires_at, pg_catalog.btrim(p_created_by), pg_catalog.btrim(p_reason),
    pg_catalog.btrim(p_execution_host), pg_catalog.btrim(p_execution_agent)
  ) returning * into v_guard;

  insert into public.apple_auth_events(guard_id, account_id, event_type, to_state, detail)
    values(v_guard.id, p_account_id, 'authorization_issued', 'authorized', 'max_attempts=1');
  return next v_guard;
end;
$$;

create or replace function public.bind_apple_auth_submit_guard(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare
  v_guard public.apple_auth_submit_guards%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform public.apple_auth_assert_account(p_account_id);
  perform public.apple_auth_assert_action(p_action_log_id, p_account_id);
  if not exists (
    select 1 from public.account_action_logs l
    where l.id = p_action_log_id and l.status = 'pending_review'
      and l.params->>'apple_auth_guard_id' = p_guard_id::text
  ) then
    raise exception using errcode = 'P0001', message = 'Apple login action is not in the bindable owner-authorized state';
  end if;
  select * into v_guard from public.apple_auth_submit_guards
    where id = p_guard_id and provider = 'apple' and account_id = p_account_id for update;
  if not found or v_guard.state <> 'authorized' or v_guard.attempt_count <> 0
     or v_guard.expires_at <= v_now
     or (v_guard.action_log_id is not null and v_guard.action_log_id <> p_action_log_id) then
    raise exception using errcode = 'P0001', message = 'Apple authorization cannot be bound to this action';
  end if;
  if v_guard.action_log_id is null then
    update public.apple_auth_submit_guards
      set action_log_id = p_action_log_id, updated_at = v_now
      where id = p_guard_id returning * into v_guard;
    insert into public.apple_auth_events(
      guard_id,account_id,action_log_id,event_type,from_state,to_state,detail
    ) values(
      v_guard.id,v_guard.account_id,p_action_log_id,'authorization_bound',
      'authorized','authorized','Owner authorization bound to exactly one queued Apple login'
    );
  end if;
  return next v_guard;
end;
$$;

create or replace function public.store_apple_auth_capability_envelope(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid,
  p_email_capability_id text, p_password_capability_id text, p_two_factor_capability_id text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.apple_auth_submit_guards g
    where g.id = p_guard_id and g.provider = 'apple' and g.account_id = p_account_id
      and g.action_log_id = p_action_log_id and g.state = 'authorized' and g.attempt_count = 0
      and g.expires_at > pg_catalog.clock_timestamp()
  ) then
    raise exception using errcode = 'P0001', message = 'Apple authorization is not ready for capability storage';
  end if;
  insert into public.apple_auth_capability_envelopes(
    guard_id,account_id,action_log_id,
    email_capability_id,password_capability_id,two_factor_capability_id
  ) values(
    p_guard_id,p_account_id,p_action_log_id,
    pg_catalog.lower(p_email_capability_id),pg_catalog.lower(p_password_capability_id),
    pg_catalog.lower(p_two_factor_capability_id)
  );
  return query select * from public.apple_auth_submit_guards where id=p_guard_id;
end;
$$;

create or replace function public.get_apple_auth_capability_envelope(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid
)
returns table(
  email_capability_id text,
  password_capability_id text,
  two_factor_capability_id text
)
language plpgsql security definer set search_path = '' as $$
begin
  return query
    select e.email_capability_id,e.password_capability_id,e.two_factor_capability_id
    from public.apple_auth_capability_envelopes e
    join public.apple_auth_submit_guards g on g.id = e.guard_id
    where e.guard_id = p_guard_id and e.account_id = p_account_id
      and e.action_log_id = p_action_log_id and g.action_log_id = p_action_log_id
      and g.state <> 'closed';
  if not found then
    raise exception using errcode = 'P0001', message = 'Apple capability envelope is unavailable for this action';
  end if;
end;
$$;

create or replace function public.claim_apple_auth_submit_guard(
  p_guard_id uuid,
  p_account_id uuid,
  p_action_log_id uuid,
  p_execution_host text,
  p_execution_agent text,
  p_lease_owner text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare
  v_guard public.apple_auth_submit_guards%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform public.apple_auth_assert_account(p_account_id);
  perform public.apple_auth_assert_action(p_action_log_id, p_account_id);
  select * into v_guard from public.apple_auth_submit_guards
    where id = p_guard_id and provider = 'apple' and account_id = p_account_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Apple auth authorization is unavailable';
  end if;
  if v_guard.state <> 'authorized' or v_guard.attempt_count <> 0 then
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'authorization_reuse_denied',v_guard.state,v_guard.state,v_guard.lease_owner,'Claim rejected because authorization is no longer unused');
    return;
  end if;
  if v_guard.expires_at <= v_now then
    update public.apple_auth_submit_guards set state='closed',closed_at=v_now,
      observable_postcondition='Authorization expired before password submission',updated_at=v_now
      where id=v_guard.id;
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'authorization_expired','authorized','closed',v_guard.lease_owner,'Expired during claim');
    delete from public.apple_auth_capability_envelopes where guard_id=v_guard.id;
    return;
  end if;
  if v_guard.execution_host <> pg_catalog.btrim(p_execution_host)
     or v_guard.execution_agent <> pg_catalog.btrim(p_execution_agent) then
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'lease_denied','authorized','authorized',v_guard.lease_owner,'Execution host or agent mismatch');
    return;
  end if;
  if v_guard.action_log_id is not null and (
    v_guard.action_log_id <> p_action_log_id or v_guard.lease_owner <> pg_catalog.btrim(p_lease_owner)
  ) then
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'lease_denied','authorized','authorized',v_guard.lease_owner,'Authorization already claimed by a different action or worker');
    return;
  end if;

  update public.apple_auth_submit_guards set
    action_log_id = p_action_log_id,
    lease_owner = pg_catalog.btrim(p_lease_owner),
    lease_acquired_at = coalesce(lease_acquired_at, v_now),
    updated_at = v_now
  where id = p_guard_id returning * into v_guard;

  insert into public.apple_auth_events(guard_id, account_id, action_log_id, event_type, from_state, to_state, lease_owner)
    values(v_guard.id, p_account_id, p_action_log_id, 'lease_acquired', 'authorized', 'authorized', v_guard.lease_owner);
  return next v_guard;
end;
$$;

create or replace function public.get_apple_auth_submit_guard(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
begin
  return query select g.* from public.apple_auth_submit_guards g
    where g.id = p_guard_id and g.provider = 'apple' and g.account_id = p_account_id
      and g.action_log_id = p_action_log_id;
  if not found then raise exception using errcode = 'P0001', message = 'Apple auth guard not found for action'; end if;
end;
$$;

create or replace function public.assert_apple_auth_challenge_open(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
begin
  return query select g.* from public.apple_auth_submit_guards g
    where g.id = p_guard_id and g.provider = 'apple' and g.account_id = p_account_id
      and g.action_log_id = p_action_log_id and g.state = 'challenge_open'
      and g.attempt_count = 1 and g.real_password_submit_count = 1;
  if not found then raise exception using errcode = 'P0001', message = 'Apple challenge is not open for this authorization'; end if;
end;
$$;

create or replace function public.consume_apple_auth_submit_guard(
  p_guard_id uuid, p_account_id uuid, p_action_log_id uuid, p_lease_owner text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform public.apple_auth_assert_action(p_action_log_id, p_account_id);
  select * into v_guard from public.apple_auth_submit_guards
    where id = p_guard_id and provider = 'apple' and account_id = p_account_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'Apple password submit authorization was not found';
  end if;
  if v_guard.state <> 'authorized' or v_guard.attempt_count <> 0
     or v_guard.action_log_id <> p_action_log_id or v_guard.lease_owner <> pg_catalog.btrim(p_lease_owner) then
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'retry_denied',v_guard.state,v_guard.state,v_guard.lease_owner,'Password submit denied because authorization was used, unclaimed, or owned by another lease');
    return;
  end if;
  if v_guard.expires_at <= v_now then
    update public.apple_auth_submit_guards set state='closed',closed_at=v_now,
      observable_postcondition='Authorization expired before password submission',updated_at=v_now
      where id=v_guard.id;
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
      values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'authorization_expired','authorized','closed',v_guard.lease_owner,'Expired immediately before password submit');
    return;
  end if;

  update public.apple_auth_submit_guards set
    state = 'password_submitted', attempt_count = 1, real_password_submit_count = 1,
    password_submitted_at = v_now, updated_at = v_now
  where id = p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(guard_id, account_id, action_log_id, event_type, from_state, to_state, lease_owner)
    values(v_guard.id, p_account_id, p_action_log_id, 'password_submit_authorized', 'authorized', 'password_submitted', v_guard.lease_owner);
  insert into public.apple_auth_events(guard_id, account_id, action_log_id, event_type, from_state, to_state, lease_owner, detail)
    values(v_guard.id, p_account_id, p_action_log_id, 'password_submitted', 'authorized', 'password_submitted', v_guard.lease_owner, 'real_password_submit_count=1');
  return next v_guard;
end;
$$;

create or replace function public.mark_apple_auth_challenge_open(
  p_guard_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_guard from public.apple_auth_submit_guards
    where id = p_guard_id and action_log_id = p_action_log_id for update;
  if not found or v_guard.state <> 'password_submitted' or v_guard.attempt_count <> 1 then
    raise exception using errcode = 'P0001', message = 'Apple challenge transition denied';
  end if;
  update public.apple_auth_submit_guards set state='challenge_open', challenge_detected_at=v_now, updated_at=v_now
    where id=p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'challenge_detected','password_submitted','challenge_open',v_guard.lease_owner);
  return next v_guard;
end;
$$;

create or replace function public.record_apple_auth_challenge_captured(
  p_guard_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype;
begin
  select * into v_guard from public.apple_auth_submit_guards
    where id=p_guard_id and action_log_id=p_action_log_id and state='challenge_open' for update;
  if not found then raise exception using errcode='P0001', message='Apple challenge capture audit denied'; end if;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'challenge_code_captured','challenge_open','challenge_open',v_guard.lease_owner);
  return next v_guard;
end;
$$;

create or replace function public.record_apple_auth_challenge_redeemed(
  p_guard_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype;
begin
  select * into v_guard from public.apple_auth_submit_guards
    where id=p_guard_id and action_log_id=p_action_log_id and state='challenge_open' for update;
  if not found then raise exception using errcode='P0001', message='Apple challenge redeem audit denied'; end if;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'challenge_code_redeemed','challenge_open','challenge_open',v_guard.lease_owner);
  return next v_guard;
end;
$$;

create or replace function public.begin_apple_auth_closing(
  p_guard_id uuid, p_action_log_id uuid
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_now timestamptz := pg_catalog.clock_timestamp();
begin
  select * into v_guard from public.apple_auth_submit_guards
    where id=p_guard_id and action_log_id=p_action_log_id for update;
  if not found or v_guard.state not in ('password_submitted','challenge_open') then
    raise exception using errcode='P0001', message='Apple closing transition denied';
  end if;
  update public.apple_auth_submit_guards set state='closing',closing_at=v_now,updated_at=v_now
    where id=p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'challenge_close_attempted',
      case when v_guard.challenge_detected_at is null then 'password_submitted' else 'challenge_open' end,
      'closing',v_guard.lease_owner);
  return next v_guard;
end;
$$;

create or replace function public.close_apple_auth_submit_guard(
  p_guard_id uuid, p_action_log_id uuid, p_observable_postcondition text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_now timestamptz := pg_catalog.clock_timestamp(); v_post text := pg_catalog.btrim(p_observable_postcondition);
begin
  if v_post is null or v_post='' then raise exception using errcode='22023',message='Confirmed Apple cleanup requires a postcondition'; end if;
  select * into v_guard from public.apple_auth_submit_guards
    where id=p_guard_id and action_log_id=p_action_log_id for update;
  if not found or v_guard.state <> 'closing' then
    raise exception using errcode='P0001',message='Apple authorization can close only from closing';
  end if;
  update public.apple_auth_submit_guards set state='closed',closed_at=v_now,observable_postcondition=v_post,updated_at=v_now
    where id=p_guard_id returning * into v_guard;
  if v_guard.challenge_detected_at is not null then
    insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner)
      values(v_guard.id,v_guard.account_id,p_action_log_id,'challenge_closed','closing','closed',v_guard.lease_owner);
  end if;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'cleanup_confirmed','closing','closed',v_guard.lease_owner,v_post);
  delete from public.apple_auth_capability_envelopes where guard_id=p_guard_id;
  return next v_guard;
end;
$$;

create or replace function public.fail_open_apple_auth_submit_guard(
  p_guard_id uuid, p_action_log_id uuid, p_reason text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_reason text:=pg_catalog.btrim(p_reason); v_from text;
begin
  if v_reason is null or v_reason='' then raise exception using errcode='22023',message='failed_open requires a reason'; end if;
  select * into v_guard from public.apple_auth_submit_guards
    where id=p_guard_id and action_log_id=p_action_log_id for update;
  if not found or v_guard.state not in ('password_submitted','challenge_open','closing','failed_open') then
    raise exception using errcode='P0001',message='Apple failed_open transition denied';
  end if;
  if v_guard.state='failed_open' then return next v_guard; return; end if;
  v_from:=v_guard.state;
  update public.apple_auth_submit_guards set state='failed_open',failure_reason=v_reason,updated_at=pg_catalog.clock_timestamp()
    where id=p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
    values(v_guard.id,v_guard.account_id,p_action_log_id,'cleanup_unconfirmed',v_from,'failed_open',v_guard.lease_owner,v_reason);
  return next v_guard;
end;
$$;

create or replace function public.fail_open_apple_auth_by_action_log(
  p_action_log_id uuid, p_reason text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype;
begin
  select * into v_guard from public.apple_auth_submit_guards where action_log_id=p_action_log_id for update;
  if not found then return; end if;
  if v_guard.state in ('password_submitted','challenge_open','closing','failed_open') then
    return query select * from public.fail_open_apple_auth_submit_guard(v_guard.id,p_action_log_id,p_reason);
  end if;
end;
$$;

create or replace function public.cancel_apple_auth_submit_guard(
  p_guard_id uuid, p_reason text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare v_guard public.apple_auth_submit_guards%rowtype; v_now timestamptz:=pg_catalog.clock_timestamp(); v_reason text:=pg_catalog.btrim(p_reason);
begin
  if v_reason is null or v_reason='' then raise exception using errcode='22023',message='Cancellation requires a reason'; end if;
  select * into v_guard from public.apple_auth_submit_guards where id=p_guard_id for update;
  if not found or v_guard.state <> 'authorized' or v_guard.attempt_count<>0 then
    raise exception using errcode='P0001',message='Only an unconsumed Apple authorization can be cancelled';
  end if;
  update public.apple_auth_submit_guards set state='closed',closed_at=v_now,observable_postcondition=v_reason,updated_at=v_now
    where id=p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
    values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'authorization_cancelled','authorized','closed',v_guard.lease_owner,v_reason);
  insert into public.apple_auth_events(guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail)
    values(v_guard.id,v_guard.account_id,v_guard.action_log_id,'cleanup_confirmed','authorized','closed',v_guard.lease_owner,v_reason);
  delete from public.apple_auth_capability_envelopes where guard_id=p_guard_id;
  return next v_guard;
end;
$$;

create or replace function public.resolve_apple_auth_failed_open(
  p_guard_id uuid, p_confirmed_postcondition text
)
returns setof public.apple_auth_submit_guards
language plpgsql security definer set search_path = '' as $$
declare
  v_guard public.apple_auth_submit_guards%rowtype;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_post text:=pg_catalog.btrim(p_confirmed_postcondition);
begin
  if v_post is null or v_post='' then
    raise exception using errcode='22023',message='Failed-open resolution requires a confirmed postcondition';
  end if;
  select * into v_guard from public.apple_auth_submit_guards where id=p_guard_id for update;
  if not found or v_guard.state <> 'failed_open' then
    raise exception using errcode='P0001',message='Only a failed_open Apple authorization can be resolved';
  end if;
  update public.apple_auth_submit_guards set
    state='closed', closing_at=coalesce(closing_at,v_now), closed_at=v_now,
    observable_postcondition=v_post, failure_reason=null, updated_at=v_now
    where id=p_guard_id returning * into v_guard;
  insert into public.apple_auth_events(
    guard_id,account_id,action_log_id,event_type,from_state,to_state,lease_owner,detail
  ) values(
    v_guard.id,v_guard.account_id,v_guard.action_log_id,'cleanup_confirmed',
    'failed_open','closed',v_guard.lease_owner,v_post
  );
  delete from public.apple_auth_capability_envelopes where guard_id=p_guard_id;
  return next v_guard;
end;
$$;

revoke all on function public.apple_auth_assert_account(uuid) from public, anon, authenticated;
revoke all on function public.apple_auth_assert_action(uuid,uuid) from public, anon, authenticated;
revoke all on function public.authorize_apple_auth_submit_guard(uuid,text,text,timestamptz,text,text) from public, anon, authenticated;
revoke all on function public.bind_apple_auth_submit_guard(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.store_apple_auth_capability_envelope(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.get_apple_auth_capability_envelope(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.claim_apple_auth_submit_guard(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.get_apple_auth_submit_guard(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.assert_apple_auth_challenge_open(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.consume_apple_auth_submit_guard(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.record_apple_auth_challenge_captured(uuid,uuid) from public, anon, authenticated;
revoke all on function public.mark_apple_auth_challenge_open(uuid,uuid) from public, anon, authenticated;
revoke all on function public.record_apple_auth_challenge_redeemed(uuid,uuid) from public, anon, authenticated;
revoke all on function public.begin_apple_auth_closing(uuid,uuid) from public, anon, authenticated;
revoke all on function public.close_apple_auth_submit_guard(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.fail_open_apple_auth_submit_guard(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.fail_open_apple_auth_by_action_log(uuid,text) from public, anon, authenticated;
revoke all on function public.cancel_apple_auth_submit_guard(uuid,text) from public, anon, authenticated;
revoke all on function public.resolve_apple_auth_failed_open(uuid,text) from public, anon, authenticated;

grant execute on function public.authorize_apple_auth_submit_guard(uuid,text,text,timestamptz,text,text) to service_role;
grant execute on function public.bind_apple_auth_submit_guard(uuid,uuid,uuid) to service_role;
grant execute on function public.store_apple_auth_capability_envelope(uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function public.get_apple_auth_capability_envelope(uuid,uuid,uuid) to service_role;
grant execute on function public.claim_apple_auth_submit_guard(uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function public.get_apple_auth_submit_guard(uuid,uuid,uuid) to service_role;
grant execute on function public.assert_apple_auth_challenge_open(uuid,uuid,uuid) to service_role;
grant execute on function public.consume_apple_auth_submit_guard(uuid,uuid,uuid,text) to service_role;
grant execute on function public.record_apple_auth_challenge_captured(uuid,uuid) to service_role;
grant execute on function public.mark_apple_auth_challenge_open(uuid,uuid) to service_role;
grant execute on function public.record_apple_auth_challenge_redeemed(uuid,uuid) to service_role;
grant execute on function public.begin_apple_auth_closing(uuid,uuid) to service_role;
grant execute on function public.close_apple_auth_submit_guard(uuid,uuid,text) to service_role;
grant execute on function public.fail_open_apple_auth_submit_guard(uuid,uuid,text) to service_role;
grant execute on function public.fail_open_apple_auth_by_action_log(uuid,text) to service_role;
grant execute on function public.cancel_apple_auth_submit_guard(uuid,text) to service_role;
grant execute on function public.resolve_apple_auth_failed_open(uuid,text) to service_role;
