import type { Platform } from "./types.ts";

export interface OutboxItem {
  outbox_id: string;
  destination: string;
  attempts: number;
  client_name: string;
  brand_name: string;
  region: string | null;
  platform: Platform;
  username: string | null;
  profile_url: string | null;
  post_url: string | null;
  content_text: string | null;
  media_type: string | null;
  published_at: string | null;
}

const PLATFORM_LABEL: Record<Platform, string> = {
  rss: "Blog",
  youtube: "YouTube",
  instagram: "Instagram",
  threads: "Threads",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  x: "X",
};

const SNIPPET_MAX = 500;

/** Slack Incoming Webhook payload for one new post. */
export function formatPostMessage(item: OutboxItem): Record<string, unknown> {
  const label = PLATFORM_LABEL[item.platform] ?? item.platform;
  const brand = escape(item.brand_name);
  const who = item.username ? ` · ${escape(item.username)}` : "";
  const region = item.region ? ` · ${escape(item.region)}` : "";

  const snippet = item.content_text
    ? escape(truncate(item.content_text, SNIPPET_MAX))
    : "_(no text)_";
  const link = item.post_url ? `\n<${safeUrl(item.post_url)}|Open post →>` : "";

  const fallback = `New ${label} post from ${item.brand_name}` +
    (item.post_url ? `: ${item.post_url}` : "");

  const context: string[] = [];
  if (item.published_at) {
    const unix = Math.floor(new Date(item.published_at).getTime() / 1000);
    context.push(`Published <!date^${unix}^{date_short_pretty} at {time}|${item.published_at}>`);
  }
  if (item.media_type) context.push(escape(item.media_type));

  return {
    text: fallback,
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*New ${label} post* — *${brand}*${who}${region}\n${snippet}${link}` },
      },
      ...(context.length
        ? [{ type: "context", elements: [{ type: "mrkdwn", text: context.join(" · ") }] }]
        : []),
    ],
  };
}

/** Slack mrkdwn requires &, <, > to be escaped in user content. */
function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeUrl(url: string): string {
  return url.replace(/[<>|]/g, encodeURIComponent);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
