// deliver: called by pg_cron every minute.
// Sends pending outbox rows to Slack Incoming Webhooks, one message per
// second (Slack's limit), and schedules retries for failures.
import { db, getSecret, isAuthorizedCron, json, redact } from "../_shared/db.ts";
import { formatPostMessage, type OutboxItem } from "../_shared/slack.ts";

const BATCH_SIZE = 20;
const SEND_GAP_MS = 1100;

Deno.serve(async (req) => {
  if (!(await isAuthorizedCron(req))) return json({ error: "unauthorized" }, 401);

  const { data, error } = await db.rpc("claim_outbox", { p_limit: BATCH_SIZE });
  if (error) return json({ error: `claim failed: ${error.message}` }, 500);

  const items = (data ?? []) as OutboxItem[];
  const webhooks = new Map<string, string | null>();
  // Destinations that answered 429: hold their remaining items until this time.
  const rateLimitedUntil = new Map<string, number>();
  let sent = 0, failed = 0;

  for (const [i, item] of items.entries()) {
    const holdSeconds = secondsUntil(rateLimitedUntil.get(item.destination));
    if (holdSeconds > 0) {
      await complete(item, false, "deferred: Slack rate limit", holdSeconds);
      failed++;
      continue;
    }

    if (!webhooks.has(item.destination)) {
      webhooks.set(item.destination, await getSecret(item.destination));
    }
    const url = webhooks.get(item.destination);
    if (!url) {
      await complete(item, false, `Vault secret '${item.destination}' not found`);
      failed++;
      continue;
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formatPostMessage(item)),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();

      if (res.ok) {
        await complete(item, true);
        sent++;
      } else if (res.status === 429) {
        const retryAfter = Math.max(1, parseInt(res.headers.get("Retry-After") ?? "30", 10) || 30);
        rateLimitedUntil.set(item.destination, Date.now() + retryAfter * 1000);
        await complete(item, false, "Slack 429 rate limited", retryAfter);
        failed++;
      } else {
        await complete(item, false, `Slack HTTP ${res.status}: ${body.slice(0, 200)}`);
        failed++;
      }
    } catch (e) {
      await complete(item, false, (e as Error).message ?? String(e));
      failed++;
    }

    if (i < items.length - 1) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }

  return json({ claimed: items.length, sent, failed });
});

async function complete(item: OutboxItem, ok: boolean, error?: string, retryAfterSeconds?: number) {
  const { error: rpcError } = await db.rpc("complete_outbox", {
    p_outbox_id: item.outbox_id,
    p_ok: ok,
    p_error: error ? redact(error) : null,
    p_retry_after_seconds: retryAfterSeconds ?? null,
  });
  if (rpcError) console.error(`complete_outbox failed for ${item.outbox_id}: ${rpcError.message}`);
}

function secondsUntil(t: number | undefined): number {
  return t ? Math.ceil((t - Date.now()) / 1000) : 0;
}
