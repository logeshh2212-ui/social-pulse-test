# AGENTS.md — Social Media Post Monitor

Context file for anyone (human or AI agent) working on this repository.
It records what has been decided so far, why, and where the project stands.

**Last updated:** 21 November 2026

---

## 1. What we are building

A tool that detects when a company's **own** social-media accounts publish a
new post and announces it in Slack.

- **Owner:** XLU, an agency that runs social media for multiple clients. The
  system is meant to serve all XLU clients.
- **First brand:** MeetMyPets (XLU's own product), which posts on all platforms
  in section 6. Before MeetMyPets, everything is tested on personal test
  accounts. Later: client brands and regional accounts.
- **Audience:** people *outside* the social-media team who want to know what
  was published.
- **Outputs:**
  1. **Real-time feed:** one Slack message per new post, in the client's own
     Slack channel.
  2. **Daily digest:** one summary message per client (proposed 6:30 PM IST).
- **Permanent log:** the database, not Slack. The Slack free plan only shows the
  last 90 days of messages.

## 2. Hard rules

- **Zero billing** for our own system. Nothing may require a credit card or
  billing account. Free tiers only. (Zapier plans are owned and paid, if needed,
  by each client — see section 7.)
- **Official access only.** Use documented APIs, webhooks and RSS/Atom feeds.
  No scraping, no automated logins with passwords, no bypassing platform limits.
  This includes tool limits: **never create multiple Zapier accounts to stay on
  the free plan** (forbidden by Zapier's Acceptable Use Policy).
- **Report honestly.** Every source has an explicit status. Never show a source
  as monitored if it isn't.
  Status values: `active`, `auth_required`, `permission_required`,
  `unsupported`, `degraded`, `disabled`.
- **No fake identities.** Test accounts may have made-up *usernames*
  (e.g. `@petfeed_test`), but every account must belong to a real person.
  Facebook and LinkedIn accounts must use the owner's real name, one per person.
- **Secrets never go in the repo.** The repo is **public**. Tokens, app secrets,
  webhook URLs and database credentials live in Supabase Vault or a password
  manager. Never log them.
- **Monitored source list lives in the database**, not in the repo, so the
  public repo does not reveal which accounts are watched.

## 3. Decision: hybrid approach (21 Nov 2026)

| Platform | Handled by | Why |
|---|---|---|
| YouTube | **Zapier** | Team preference. (Our RSS adapter already supports YouTube channel feeds for free, so this can move to our system later to save Zapier tasks.) |
| Instagram | **Zapier** | Zapier's Meta integration is already approved by Meta; our own Meta app setup hit repeated blocks (see section 8) |
| Facebook Page | **Zapier** | Same as Instagram |
| Blog / RSS | **Our system** | Free, simple, already built |
| Reddit | **Our system** | Reuses the RSS adapter |
| Threads | **Our system** | Zapier support for "new post" alerts is weak |
| LinkedIn company page | **Our system** | No reliable Zapier "new company post" trigger |
| X | **Manual logging** (our system) | X API has no free tier; `unsupported` for automatic monitoring |

**Consequences to remember:**
- Posts sent by Zapier go straight to Slack and are **not in our database**, so
  our daily digest and permanent log only cover our platforms. Fixing this
  would mean Zapier posting to our `webhook` function instead of Slack, which
  needs "Webhooks by Zapier" (a paid Zapier feature). Decide later.
- Both sides post into the **same per-client Slack channels**.

## 4. Stack

| Part | Tool | Cost | Job |
|---|---|---|---|
| Zapier | Zapier, one account per client, owned by the client | Free or client's plan | YouTube / Instagram / Facebook → Slack |
| Code hosting | GitHub (public repo) | Free | Source, migrations, tests. No secrets |
| Database | Supabase Postgres | Free | Clients, brands, accounts, posts, outbox, health log |
| Scheduler | Supabase `pg_cron` + `pg_net` | Free | Calls Edge Functions every minute; daily digest |
| Programs | Supabase Edge Functions (TypeScript on Deno) | Free | `collect`, `deliver`; later `digest`, `webhook` |
| Secrets | Supabase Vault | Free | Slack webhook URLs, platform tokens, `cron_secret` |
| Notifications | Slack Incoming Webhooks | Free | One webhook per client channel |

```text
 ZAPIER SIDE                               OUR SYSTEM (Supabase, free plan)
 ───────────                               ────────────────────────────────
 YouTube   ─┐                              Blog/RSS ─┐
 Instagram ─┼─ Zap per account ─┐          Reddit   ─┤
 Facebook  ─┘                   │          Threads  ─┼─▶ collect (every minute)
                                │          LinkedIn ─┘        │
                                │                             ▼
                                │                      Postgres (posts, outbox)
                                │                             │
                                │                       deliver (every minute)
                                ▼                             ▼
                        ┌──────────── Slack ────────────────────┐
                        │  #clientA-feed   #clientB-feed   ...  │
                        └───────────────────────────────────────┘
```

### Why not GitHub Actions for scheduling (decided)
- GitHub's terms say Actions on GitHub-hosted runners are for developing,
  testing and deploying software, not for running a 24/7 service.
- Scheduled runs are often delayed, and the minimum interval is 5 minutes.
- Actions cannot receive webhooks (no public endpoint).

GitHub Actions may still be used for CI (tests) and deployment on push.

### Supabase notes
- Free plan allows 2 active projects. Test project: `social-pulse-test`
  (ref `sxvnirhrcvjywjussczr`). The Supabase account also holds unrelated
  projects: **never touch them.** Always confirm the target ref before any
  remote command.
- Free projects pause after 7 days of inactivity. Not an issue: `pg_cron`
  queries the database every minute.
- Edge Functions have execution time limits, so each `collect` call processes a
  small batch of due sources (10) and `deliver` sends at most 20 messages.
- CLI: run via `npx supabase@3.2.0 …` (not installed globally). Remote commands
  need `--remote`; read-only SQL: `db query --remote --read-only -f file.sql`.
  Deno isn't installed either: type-check with `npx deno@2.1.4 check`.

## 5. How one cycle works (our system)

1. `pg_cron` calls `collect` every minute (via `invoke_edge_function`, which
   sends the Vault `cron_secret` in the `x-cron-secret` header; the functions
   run with `verify_jwt = false` and check that header instead).
2. `collect` claims up to 10 sources whose `next_run_at` has passed
   (`FOR UPDATE SKIP LOCKED` + a 5-minute lease, so overlapping runs never
   handle the same source).
3. Each source runs through its platform adapter. RSS uses conditional requests
   (ETag / Last-Modified). Platforms without an adapter are set to
   `unsupported`.
4. New posts are inserted with
   `ON CONFLICT (platform, external_post_id) DO NOTHING`. In the **same
   transaction**, an outbox row is created for each genuinely new post
   (`ingest_posts`).
5. **Baseline rule:** the first time a source is checked, its existing posts
   are saved *without* outbox rows, so adding a source does not flood Slack.
6. Source health is updated (`record_check_result`): failures back off
   exponentially (max 1 h); 5 consecutive failures → `degraded`; HTTP 401/403 →
   `auth_required` / `permission_required`. A `collection_events` row is written.
7. `deliver` sends pending outbox rows to Slack, one per ~1.1 s, marks them
   `sent`, and retries failures with exponential backoff (30 s doubling, max
   1 h), respecting Slack's `Retry-After`. After 8 attempts a row is `failed`.
8. Later: push events (via `webhook`) go into the same tables with the same
   deduplication, and polling continues as a backup.

**Delivery guarantee:** at-least-once. Slack webhooks have no idempotency key,
so a crash between "Slack accepted" and "marked sent" can cause a rare
duplicate. This is accepted.

## 6. Data model (live in `social-pulse-test`)

Defined in `supabase/migrations/`. RLS is enabled on every table with no
policies, so only `service_role` (the Edge Functions) can access data. All
pipeline functions are `SECURITY DEFINER` and executable only by `service_role`.

- `clients`: id, name, slack_webhook_secret (**Vault secret name**, not the
  URL), digest_enabled, digest_time, digest_timezone, created_at
- `brands`: id, client_id, name, optional slack_webhook_secret override,
  created_at
- `monitored_accounts`: id, brand_id, region, platform, username,
  external_account_id, profile_url, source_url (what `collect` fetches),
  token_secret (Vault name), monitoring_mode (poll / webhook / feed / manual),
  status, environment (`test` / `production`), baseline_completed,
  poll_interval_seconds (default 120, min 60), etag, last_modified,
  last_checked_at, last_error, next_run_at, consecutive_failures, created_at
- `posts`: id, account_id, platform, external_post_id, post_url, content_text,
  media_type, published_at, detected_at, raw_metadata (JSONB).
  `UNIQUE (platform, external_post_id)`. RSS IDs that aren't URIs are prefixed
  with the feed URL to avoid collisions.
- `notification_outbox`: id, post_id, destination (Vault secret name), status
  (pending / processing / sent / failed), attempts, next_attempt_at,
  claimed_at, delivered_at, last_error, created_at.
  `UNIQUE (post_id, destination)`
- `collection_events`: id, account_id, platform, event_type, status,
  new_posts, execution_time_ms, error_message, created_at (kept 30 days)

**Vault secret names:** `cron_secret` (auto-generated by migration),
`project_url`, `slack_webhook_<channel>` (e.g.
`slack_webhook_social_feed_test`), `token_<…>` for platform tokens.
`get_secret()` only returns names matching these prefixes.

## 7. Platform plan

All accounts are **company-owned** (or client-owned with their consent).

| Platform | Method | Status | Needs |
|---|---|---|---|
| Blog / RSS | Poll feed every 2 min, conditional requests | ✅ Code written + type-checked | Finish first slice (section 10) |
| Reddit | Account's public RSS feed (same adapter) | 🟢 Easy | Confirm Reddit commercial-use terms |
| Threads | Threads API (`threads_basic`), poll user threads; publish webhook later | 🟡 Medium | Separate Meta "Threads app", per-account OAuth via `webhook` function, token-refresh job (~60-day tokens). Webhook needs Meta business verification |
| LinkedIn | Community Management API (`r_organization_social`), poll org posts | 🔴 Slow | **Apply now**; review takes weeks. Each client's page admin authorizes |
| X | Manual logging (Slack shortcut / form) | 🟢 Easy | — |
| YouTube / Instagram / Facebook | **Zapier**: "New video" / "New media posted" / "New Page post" → "Send channel message" | Team-managed | One Zap per account |

Personal Facebook profiles and personal LinkedIn profiles cannot be monitored.

### Zapier rules
- **One Zapier account per client, owned by the client** (their own email,
  they accept Zapier's terms; XLU manages it). Zapier community moderators say
  this is fine; it is not official policy, so confirm with Zapier.
- **Never** create extra Zapier accounts to get around free-plan limits, and
  never use throwaway emails. Both are forbidden by Zapier's Acceptable Use
  Policy (checked 21 Nov 2026).
- Free plan (per 2026 guides, verify at zapier.com/pricing): ~100 tasks/month,
  2-step Zaps only, ~15-min polling. One Slack message = one task, so busy
  clients will likely need a paid plan.
- Test first with one Zapier account (own real email) → `#social-feed-test`,
  and check task usage after a week.

## 8. Meta notes (needed again for Threads)

Instagram and Facebook moved to Zapier, so the Meta app work for them is **on
hold**. These findings still matter for the Threads app:

- App "Pet Monitor Test" (development mode, Instagram use case) and business
  portfolio "Pet monitor" (ID 4327448037399157) exist.
- Business portfolios: Meta rejects some names (containing "test", all
  lowercase). The portfolio shows "You can't use this business portfolio to
  advertise". Irrelevant (we don't advertise); don't appeal unless it blocks
  API access. The asset-sharing step forces "Create a new ad account" (free, no
  card; never add a payment method).
- Newer apps no longer offer "API setup with Instagram login" (`IGAA…` tokens),
  only "Unified login", which issues a Facebook **system-user** token (`EAA…`)
  that graph.instagram.com rejects (code 190). Use graph.facebook.com.
- The system-user token never expires and had extra scopes (publish, messages,
  comments). If ever reused: regenerate with read-only scope only.
- Finding the IG user ID failed through the portfolio (error 100 / subcode 33)
  and through `me/accounts` (test Page "Testsystem", ID 1400218853183037, not
  linked to `testsystem2`).
- **New Facebook accounts get rate-restricted** ("Your account is restricted…
  temporarily") after many setup actions in one day (hit 20 Nov 2026). Wait
  24 h and retry once. Don't retry repeatedly or create extra accounts.
- Threads: use the Threads app's own ID and secret.

## 9. Testing strategy

1. **Recorded fixtures:** saved API responses run through adapters, dedup,
   outbox and Slack formatting (duplicates, edits, Slack 429, timeouts).
2. **Test accounts end to end:** real APIs → private Slack channel
   `#social-feed-test` → test Supabase project.
3. **Shadow mode:** connect real MeetMyPets accounts but send to the test channel
   for about a week, compare against what was published, then switch to the
   real channel.

Test accounts stay connected after launch (`environment = test`) as a permanent
health check.

**Test accounts / sources:**
- Blog: `test-feed/feed.xml` in this repo (served from GitHub raw). Add an
  `<item>` with a new unique `<guid>` and push to simulate a new post
- Reddit: secondary account + private test subreddit
- Threads: profile of the test Instagram account `testsystem2`
- LinkedIn: no test account (fake profiles break LinkedIn's rules). Use
  recorded fixtures, then the real company page in read-only mode
- Zapier side: `testsystem2` (Instagram), "Testsystem" Page (Facebook), a
  secondary YouTube channel (videos must be public)

## 10. Progress and build order

**Done:**
- [x] Requirements, architecture and hybrid decision (this file)
- [x] Supabase test project, Slack `#social-feed-test`, GitHub repo
- [x] Local folder linked to `social-pulse-test`
- [x] Migrations applied (tables, pipeline functions, cron jobs, `cron_secret`);
      verified RLS on and anon cannot execute pipeline functions
- [x] Edge Functions `collect` and `deliver` + RSS adapter written and
      type-checked; parser tested against `test-feed/feed.xml`

**Build order (our system):**
1. **Finish blog/RSS → Slack** (in progress):
   - [x] Slack app "Social Pulse" with Incoming Webhook for
         `#social-feed-test` created (21 Nov 2026)
   - [x] Step C: Vault secrets `slack_webhook_social_feed_test` and
         `project_url` added by the user in the SQL editor (webhook URL never
         shared with agents)
   - [x] Step E: commit + push to GitHub (file list scanned for secrets first)
   - [ ] Step D: deploy `collect` / `deliver`, insert test client/brand/RSS
         source, add a feed item, confirm the Slack message
   - Note: cron jobs already run every minute and fail harmlessly until Step D
2. **Reddit** (RSS adapter reuse)
3. **Daily digest** (`digest` function, per-client time zone)
4. **Threads** (Threads app, OAuth callback in `webhook`, token refresh job)
5. **LinkedIn** (build while the API application is reviewed)
6. **X manual logging**
7. **Client onboarding** (add client / brand / accounts / Slack channel without
   writing SQL)

**Zapier side (team):** set up Zaps for YouTube, Instagram, Facebook test
accounts → `#social-feed-test`; measure task usage.

## 11. Longer-lead tasks

- **LinkedIn Community Management API application.** Start now.
- Company-owned accounts for GitHub, Supabase and Meta (not personal ones), so
  access survives staff changes.
- Meta business verification (needed for Threads webhooks and multi-client
  Threads access).
- Check company policy on publishing code in a public repository.
- Confirm Reddit commercial-use terms.
- Multi-client: each client authorizes its own accounts (OAuth / admin role).
  Never ask clients for passwords. Development-mode Meta apps only work for
  accounts with a role on the app; client Threads accounts will need App Review.

## 12. Open questions

- How many clients, brands, regions and accounts are expected initially?
- Daily digest time (proposed: 6:30 PM IST).
- Should Zapier posts also reach our database (paid "Webhooks by Zapier"), so
  the digest and log cover every platform?
- Move YouTube from Zapier to our RSS adapter to save Zapier tasks?
- X: manual logging, or export from the social team's scheduling tool?
- Decided: one Slack channel per client (brand override possible);
  hierarchy client → brand → account; hybrid Zapier split (section 3).
