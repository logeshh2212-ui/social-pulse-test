-- Database functions used by the collect / deliver Edge Functions.
-- All are SECURITY DEFINER and executable only by service_role, so the public
-- anon key cannot call them through the REST API.

-- 1. Claim a batch of due sources. SKIP LOCKED + pushing next_run_at forward
--    (a "lease") means two overlapping runs never process the same source.
--    If a run crashes, the source is retried when the lease expires.
create or replace function public.claim_due_accounts(
  p_limit integer default 10,
  p_lease_seconds integer default 300
) returns setof public.monitored_accounts
language sql security definer set search_path = public as $$
  update public.monitored_accounts a
     set next_run_at = now() + make_interval(secs => p_lease_seconds)
   where a.id in (
     select id from public.monitored_accounts
      where status in ('active', 'degraded')
        and monitoring_mode in ('poll', 'feed')
        and next_run_at <= now()
      order by next_run_at
      limit p_limit
      for update skip locked)
  returning a.*;
$$;

-- 2. Save fetched posts. New posts and their outbox rows are written in the
--    same transaction. On a source's first run (baseline) posts are saved
--    without outbox rows so adding a source doesn't flood Slack.
create or replace function public.ingest_posts(p_account_id uuid, p_posts jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_acc      public.monitored_accounts;
  v_dest     text;
  v_ids      uuid[];
  v_new      integer;
  v_notified integer;
begin
  select * into v_acc from public.monitored_accounts where id = p_account_id for update;
  if not found then
    raise exception 'monitored account % not found', p_account_id;
  end if;

  select coalesce(b.slack_webhook_secret, c.slack_webhook_secret) into v_dest
    from public.brands b join public.clients c on c.id = b.client_id
   where b.id = v_acc.brand_id;

  with ins as (
    insert into public.posts (account_id, platform, external_post_id, post_url,
                              content_text, media_type, published_at, raw_metadata)
    select p_account_id, v_acc.platform,
           p->>'external_post_id', p->>'post_url', p->>'content_text',
           p->>'media_type', (p->>'published_at')::timestamptz, p->'raw_metadata'
      from jsonb_array_elements(p_posts) p
     where coalesce(p->>'external_post_id', '') <> ''
    on conflict (platform, external_post_id) do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_ids from ins;
  v_new := cardinality(v_ids);

  v_notified := 0;
  if v_acc.baseline_completed then
    insert into public.notification_outbox (post_id, destination)
    select unnest(v_ids), v_dest
    on conflict (post_id, destination) do nothing;
    get diagnostics v_notified = row_count;
  else
    update public.monitored_accounts set baseline_completed = true where id = p_account_id;
  end if;

  return jsonb_build_object('new_posts', v_new, 'notified', v_notified,
                            'baseline', not v_acc.baseline_completed);
end $$;

-- 3. Record the outcome of one check and schedule the next one.
--    Failures back off exponentially (capped at 1 h); after 5 consecutive
--    failures an active source becomes 'degraded'. p_new_status lets the
--    adapter report auth_required / permission_required / unsupported.
create or replace function public.record_check_result(
  p_account_id    uuid,
  p_ok            boolean,
  p_event_status  text,                       -- ok / not_modified / error / skipped
  p_new_posts     integer default 0,
  p_ms            integer default null,
  p_error         text default null,
  p_etag          text default null,
  p_last_modified text default null,
  p_new_status    public.source_status default null,
  p_event_type    text default 'poll'
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_platform public.platform;
begin
  update public.monitored_accounts a set
    last_checked_at      = now(),
    etag                 = case when p_ok then coalesce(p_etag, a.etag) else a.etag end,
    last_modified        = case when p_ok then coalesce(p_last_modified, a.last_modified) else a.last_modified end,
    consecutive_failures = case when p_ok then 0 else a.consecutive_failures + 1 end,
    last_error           = case when p_ok then null else left(p_error, 1000) end,
    status = case
      when p_new_status is not null then p_new_status
      when p_ok and a.status = 'degraded' then 'active'::public.source_status
      when not p_ok and a.status = 'active' and a.consecutive_failures + 1 >= 5
        then 'degraded'::public.source_status
      else a.status
    end,
    next_run_at = now() + make_interval(secs => case
      when p_ok then a.poll_interval_seconds
      else least(a.poll_interval_seconds * power(2, least(a.consecutive_failures + 1, 6))::integer, 3600)
    end)
  where a.id = p_account_id
  returning a.platform into v_platform;

  insert into public.collection_events
    (account_id, platform, event_type, status, new_posts, execution_time_ms, error_message)
  values
    (p_account_id, v_platform, p_event_type, p_event_status, coalesce(p_new_posts, 0), p_ms, left(p_error, 1000));
end $$;

-- 4. Claim pending outbox rows for delivery, with everything needed to format
--    the Slack message. Rows stuck in 'processing' for 10+ min (crashed run)
--    are reclaimed.
create or replace function public.claim_outbox(p_limit integer default 20)
returns table (
  outbox_id    uuid,
  destination  text,
  attempts     integer,
  client_name  text,
  brand_name   text,
  region       text,
  platform     public.platform,
  username     text,
  profile_url  text,
  post_url     text,
  content_text text,
  media_type   text,
  published_at timestamptz
)
language sql security definer set search_path = public as $$
  with claimed as (
    update public.notification_outbox o
       set status = 'processing', claimed_at = now(), attempts = o.attempts + 1
     where o.id in (
       select id from public.notification_outbox
        where (status = 'pending' and next_attempt_at <= now())
           or (status = 'processing' and claimed_at < now() - interval '10 minutes')
        order by next_attempt_at
        limit p_limit
        for update skip locked)
    returning o.*
  )
  select c.id, c.destination, c.attempts, cl.name, b.name, a.region, a.platform,
         a.username, a.profile_url, p.post_url, p.content_text, p.media_type, p.published_at
    from claimed c
    join public.posts p              on p.id = c.post_id
    join public.monitored_accounts a on a.id = p.account_id
    join public.brands b             on b.id = a.brand_id
    join public.clients cl           on cl.id = b.client_id
   order by p.published_at nulls last;
$$;

-- 5. Mark a delivery attempt. Failures retry with exponential backoff
--    (30 s, 60 s, 120 s ... capped at 1 h) or Slack's Retry-After; after
--    p_max_attempts the row is marked 'failed'.
create or replace function public.complete_outbox(
  p_outbox_id           uuid,
  p_ok                  boolean,
  p_error               text default null,
  p_retry_after_seconds integer default null,
  p_max_attempts        integer default 8
) returns void
language sql security definer set search_path = public as $$
  update public.notification_outbox o set
    status = case
      when p_ok then 'sent'::public.outbox_status
      when o.attempts >= p_max_attempts then 'failed'::public.outbox_status
      else 'pending'::public.outbox_status
    end,
    delivered_at    = case when p_ok then now() else null end,
    last_error      = case when p_ok then null else left(p_error, 1000) end,
    claimed_at      = null,
    next_attempt_at = case
      when p_ok then o.next_attempt_at
      else now() + make_interval(secs => coalesce(
        p_retry_after_seconds,
        least(30 * power(2, greatest(o.attempts - 1, 0)), 3600)::integer))
    end
  where o.id = p_outbox_id;
$$;

-- 6. Read a secret from Supabase Vault. Only names with known prefixes are
--    readable, and only by service_role. Callers must never log the result.
create or replace function public.get_secret(p_name text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_secret text;
begin
  if p_name !~ '^(slack_webhook_|token_|cron_secret$)' then
    raise exception 'secret name not allowed: %', p_name;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = p_name;
  return v_secret;
end $$;

-- Lock down: only service_role may execute these.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.claim_due_accounts(integer, integer)',
    'public.ingest_posts(uuid, jsonb)',
    'public.record_check_result(uuid, boolean, text, integer, integer, text, text, text, public.source_status, text)',
    'public.claim_outbox(integer)',
    'public.complete_outbox(uuid, boolean, text, integer, integer)',
    'public.get_secret(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
