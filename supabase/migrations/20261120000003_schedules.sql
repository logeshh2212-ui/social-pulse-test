-- Scheduling: pg_cron calls the Edge Functions every minute via pg_net.
--
-- Required Vault secrets (never committed):
--   project_url  - e.g. https://<project-ref>.supabase.co   (set once per project)
--   cron_secret  - generated below; Edge Functions check it in the x-cron-secret header

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Generate the shared cron secret inside the database, so nobody has to
-- handle it by hand.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'cron_secret',
      'Shared secret pg_cron sends to Edge Functions');
  end if;
end $$;

create or replace function public.invoke_edge_function(p_name text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'Vault secrets project_url and cron_secret must exist';
  end if;
  return net.http_post(
    url                  := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    headers              := jsonb_build_object('Content-Type', 'application/json',
                                               'x-cron-secret', v_secret),
    body                 := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;

revoke all on function public.invoke_edge_function(text) from public, anon, authenticated;
grant execute on function public.invoke_edge_function(text) to service_role;

select cron.schedule('collect-every-minute', '* * * * *',
                     $$ select public.invoke_edge_function('collect') $$);
select cron.schedule('deliver-every-minute', '* * * * *',
                     $$ select public.invoke_edge_function('deliver') $$);

-- Housekeeping so the free-plan database (500 MB) doesn't fill with logs.
select cron.schedule('cleanup-logs-daily', '15 3 * * *', $$
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  delete from public.collection_events where created_at < now() - interval '30 days';
$$);
