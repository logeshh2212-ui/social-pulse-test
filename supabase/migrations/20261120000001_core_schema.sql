-- Core schema for the social media post monitor.
-- Hierarchy: client -> brand -> monitored account -> posts -> outbox.
-- No secrets are stored here: webhook/token columns hold the *name* of a
-- Supabase Vault secret, never the value.

create type public.source_status as enum (
  'active', 'auth_required', 'permission_required',
  'unsupported', 'degraded', 'disabled'
);
create type public.platform as enum (
  'rss', 'youtube', 'instagram', 'threads', 'facebook', 'linkedin', 'reddit', 'x'
);
create type public.monitoring_mode as enum ('poll', 'webhook', 'feed', 'manual');
create type public.environment as enum ('test', 'production');
create type public.outbox_status as enum ('pending', 'processing', 'sent', 'failed');

create table public.clients (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null unique,
  -- Vault secret name holding this client's Slack Incoming Webhook URL.
  slack_webhook_secret text not null,
  digest_enabled       boolean not null default true,
  digest_time          time not null default '18:30',
  digest_timezone      text not null default 'Asia/Kolkata',
  created_at           timestamptz not null default now()
);

create table public.brands (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients(id) on delete cascade,
  name                 text not null,
  -- Optional override: send this brand to a different channel than its client.
  slack_webhook_secret text,
  created_at           timestamptz not null default now(),
  unique (client_id, name)
);

create table public.monitored_accounts (
  id                    uuid primary key default gen_random_uuid(),
  brand_id              uuid not null references public.brands(id) on delete cascade,
  region                text,
  platform              public.platform not null,
  username              text,
  external_account_id   text,
  profile_url           text,
  -- What the collector fetches (feed URL for rss/youtube).
  source_url            text,
  -- Vault secret name for this account's API token (API platforms only).
  token_secret          text,
  monitoring_mode       public.monitoring_mode not null default 'poll',
  status                public.source_status not null default 'active',
  environment           public.environment not null default 'test',
  baseline_completed    boolean not null default false,
  poll_interval_seconds integer not null default 120 check (poll_interval_seconds >= 60),
  etag                  text,
  last_modified         text,
  last_checked_at       timestamptz,
  last_error            text,
  next_run_at           timestamptz not null default now(),
  consecutive_failures  integer not null default 0,
  created_at            timestamptz not null default now()
);
create index monitored_accounts_due_idx
  on public.monitored_accounts (next_run_at)
  where status in ('active', 'degraded') and monitoring_mode in ('poll', 'feed');

create table public.posts (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references public.monitored_accounts(id) on delete cascade,
  platform         public.platform not null,
  external_post_id text not null,
  post_url         text,
  content_text     text,
  media_type       text,
  published_at     timestamptz,
  detected_at      timestamptz not null default now(),
  raw_metadata     jsonb,
  unique (platform, external_post_id)
);
create index posts_account_published_idx on public.posts (account_id, published_at desc);

create table public.notification_outbox (
  id              uuid primary key default gen_random_uuid(),
  post_id         uuid not null references public.posts(id) on delete cascade,
  -- Vault secret name of the Slack webhook to deliver to.
  destination     text not null,
  status          public.outbox_status not null default 'pending',
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at      timestamptz,
  delivered_at    timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  unique (post_id, destination)
);
create index notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at)
  where status in ('pending', 'processing');

create table public.collection_events (
  id                bigint generated always as identity primary key,
  account_id        uuid references public.monitored_accounts(id) on delete cascade,
  platform          public.platform,
  event_type        text not null,   -- poll / webhook / deliver ...
  status            text not null,   -- ok / not_modified / error / skipped
  new_posts         integer not null default 0,
  execution_time_ms integer,
  error_message     text,
  created_at        timestamptz not null default now()
);
create index collection_events_account_idx on public.collection_events (account_id, created_at desc);

-- Lock everything down: RLS on with no policies means only the service role
-- (used by Edge Functions) can read or write. The anon key sees nothing.
alter table public.clients             enable row level security;
alter table public.brands              enable row level security;
alter table public.monitored_accounts  enable row level security;
alter table public.posts               enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.collection_events   enable row level security;
