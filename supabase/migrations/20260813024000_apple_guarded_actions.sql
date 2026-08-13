-- Apple authentication guards protect every action that can submit the account
-- password, not only the original apple_login trajectory.
create or replace function public.apple_auth_assert_action(
  p_action_log_id uuid,
  p_account_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.account_action_logs l
    where l.id = p_action_log_id
      and l.account_id = p_account_id
      and pg_catalog.lower(l.platform) = 'apple'
      and l.action in ('apple_login', 'apple_create_developer_id')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'Action log is not a guarded Apple authentication action for this account';
  end if;
end;
$$;

revoke all on function public.apple_auth_assert_action(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.apple_auth_assert_action(uuid, uuid)
  to service_role;
