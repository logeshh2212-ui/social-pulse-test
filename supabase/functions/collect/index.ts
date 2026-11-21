// collect: called by pg_cron every minute.
// Claims a small batch of due sources, fetches each through its platform
// adapter, saves new posts (+ outbox rows) and records source health.
import { db, isAuthorizedCron, json, redact } from "../_shared/db.ts";
import { rssAdapter } from "../_shared/adapters/rss.ts";
import type { Adapter, MonitoredAccount, Platform } from "../_shared/types.ts";
import { SourceError } from "../_shared/types.ts";

const BATCH_SIZE = 10;

// Platforms without an adapter yet are reported as 'unsupported' rather than
// silently shown as monitored.
const ADAPTERS: Partial<Record<Platform, Adapter>> = {
  rss: rssAdapter,
  youtube: rssAdapter,
};

Deno.serve(async (req) => {
  if (!(await isAuthorizedCron(req))) return json({ error: "unauthorized" }, 401);

  const { data, error } = await db.rpc("claim_due_accounts", { p_limit: BATCH_SIZE });
  if (error) return json({ error: `claim failed: ${error.message}` }, 500);

  const accounts = (data ?? []) as MonitoredAccount[];
  const results = await Promise.all(accounts.map(processAccount));
  return json({ claimed: accounts.length, results });
});

async function processAccount(account: MonitoredAccount) {
  const started = Date.now();
  const adapter = ADAPTERS[account.platform];

  if (!adapter) {
    await record(account.id, {
      ok: false,
      eventStatus: "skipped",
      error: `No adapter for platform '${account.platform}' yet`,
      newStatus: "unsupported",
      ms: Date.now() - started,
    });
    return { id: account.id, status: "unsupported" };
  }

  try {
    const result = await adapter.fetchPosts(account);

    if (result.notModified) {
      await record(account.id, { ok: true, eventStatus: "not_modified", ms: Date.now() - started });
      return { id: account.id, status: "not_modified" };
    }

    const { data, error } = await db.rpc("ingest_posts", {
      p_account_id: account.id,
      p_posts: result.posts,
    });
    if (error) throw new Error(`ingest failed: ${error.message}`);
    const ingest = data as { new_posts: number; notified: number; baseline: boolean };

    await record(account.id, {
      ok: true,
      eventStatus: "ok",
      newPosts: ingest.new_posts,
      etag: result.etag ?? null,
      lastModified: result.lastModified ?? null,
      ms: Date.now() - started,
    });
    return { id: account.id, status: "ok", ...ingest };
  } catch (e) {
    const message = redact((e as Error).message ?? String(e));
    await record(account.id, {
      ok: false,
      eventStatus: "error",
      error: message,
      newStatus: e instanceof SourceError ? e.status : null,
      ms: Date.now() - started,
    });
    return { id: account.id, status: "error", error: message };
  }
}

async function record(
  accountId: string,
  r: {
    ok: boolean;
    eventStatus: "ok" | "not_modified" | "error" | "skipped";
    newPosts?: number;
    error?: string;
    etag?: string | null;
    lastModified?: string | null;
    newStatus?: string | null;
    ms: number;
  },
) {
  const { error } = await db.rpc("record_check_result", {
    p_account_id: accountId,
    p_ok: r.ok,
    p_event_status: r.eventStatus,
    p_new_posts: r.newPosts ?? 0,
    p_ms: r.ms,
    p_error: r.error ?? null,
    p_etag: r.etag ?? null,
    p_last_modified: r.lastModified ?? null,
    p_new_status: r.newStatus ?? null,
  });
  if (error) console.error(`record_check_result failed for ${accountId}: ${error.message}`);
}
