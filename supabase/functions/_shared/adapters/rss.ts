// RSS 2.0 / RSS 1.0 (RDF) / Atom adapter. Also used for YouTube channel feeds
// (https://www.youtube.com/feeds/videos.xml?channel_id=...), which are Atom.
import { XMLParser } from "npm:fast-xml-parser@4.5.0";
import type { Adapter, FetchResult, MonitoredAccount, NormalizedPost } from "../types.ts";
import { SourceError } from "../types.ts";

const USER_AGENT = "social-pulse-monitor/0.1";
const MAX_TEXT = 2000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  processEntities: true,
  htmlEntities: true,
  parseTagValue: false,
  trimValues: true,
});

export const rssAdapter: Adapter = {
  async fetchPosts(account: MonitoredAccount): Promise<FetchResult> {
    if (!account.source_url) {
      throw new SourceError("source_url (feed URL) is not set", "disabled");
    }
    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    };
    // Conditional request: the server answers 304 if nothing changed.
    if (account.etag) headers["If-None-Match"] = account.etag;
    if (account.last_modified) headers["If-Modified-Since"] = account.last_modified;

    const res = await fetch(account.source_url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 304) {
      await res.body?.cancel();
      return { notModified: true, posts: [] };
    }
    if (!res.ok) {
      await res.body?.cancel();
      const status = res.status === 401 ? "auth_required"
        : res.status === 403 ? "permission_required"
        : null;
      throw new SourceError(`Feed returned HTTP ${res.status}`, status);
    }

    const xml = await res.text();
    const platform = account.platform === "youtube" ? "youtube" : "rss";
    return {
      notModified: false,
      posts: parseFeed(xml, account.source_url, platform),
      etag: res.headers.get("ETag"),
      lastModified: res.headers.get("Last-Modified"),
    };
  },
};

// ---------- parsing (pure, unit-tested) ----------

type Node = Record<string, unknown>;

export function parseFeed(xml: string, feedUrl: string, platform: "rss" | "youtube"): NormalizedPost[] {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new SourceError(`Feed is not valid XML: ${(e as Error).message}`);
  }

  const rss = doc["rss"] as Node | undefined;
  const feed = doc["feed"] as Node | undefined;
  const rdf = doc["rdf:RDF"] as Node | undefined;

  if (rss?.["channel"]) {
    return asArray((rss["channel"] as Node)["item"]).map((i) => fromRssItem(i as Node, feedUrl, platform));
  }
  if (rdf) {
    return asArray(rdf["item"]).map((i) => fromRssItem(i as Node, feedUrl, platform));
  }
  if (feed) {
    return asArray(feed["entry"]).map((e) => fromAtomEntry(e as Node, feedUrl, platform));
  }
  throw new SourceError("Response is not an RSS or Atom feed");
}

function fromRssItem(item: Node, feedUrl: string, platform: "rss" | "youtube"): NormalizedPost {
  const title = text(item["title"]);
  const link = text(item["link"]);
  const guid = text(item["guid"]);
  const body = text(item["description"]) ?? text(item["content:encoded"]);
  const date = text(item["pubDate"]) ?? text(item["dc:date"]);
  return {
    external_post_id: externalId(guid ?? link ?? title, feedUrl),
    post_url: link,
    content_text: joinText(title, body),
    media_type: platform === "youtube" ? "video" : "article",
    published_at: isoDate(date),
    raw_metadata: { title, guid, link },
  };
}

function fromAtomEntry(entry: Node, feedUrl: string, platform: "rss" | "youtube"): NormalizedPost {
  const title = text(entry["title"]);
  const id = text(entry["id"]);
  const link = atomLink(entry["link"]);
  const media = entry["media:group"] as Node | undefined;
  const body = text(entry["summary"]) ?? text(entry["content"]) ?? text(media?.["media:description"]);
  const date = text(entry["published"]) ?? text(entry["updated"]);
  const videoId = text(entry["yt:videoId"]);
  return {
    external_post_id: externalId(videoId ? `yt:video:${videoId}` : (id ?? link ?? title), feedUrl),
    post_url: link,
    content_text: joinText(title, body),
    media_type: platform === "youtube" ? "video" : "article",
    published_at: isoDate(date),
    raw_metadata: { title, id, link, ...(videoId ? { video_id: videoId } : {}) },
  };
}

/** Globally unique IDs (URLs, URNs, tag: URIs) are kept as-is; bare IDs like
 *  "42" are namespaced by feed URL so two blogs can't collide. */
function externalId(raw: string | null, feedUrl: string): string {
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `${feedUrl}#${raw}`;
}

function atomLink(value: unknown): string | null {
  const links = asArray(value) as Node[];
  const alt = links.find((l) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
  return alt ? (text(alt["@_href"]) ?? text(alt)) : null;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    return s === "" ? null : s;
  }
  if (Array.isArray(value)) return text(value[0]);
  if (typeof value === "object") return text((value as Node)["#text"]);
  return null;
}

function joinText(title: string | null, body: string | null): string | null {
  const cleanBody = body ? stripHtml(body) : null;
  const parts = [title, cleanBody && cleanBody !== title ? cleanBody : null].filter(Boolean);
  if (parts.length === 0) return null;
  const s = parts.join("\n\n");
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT - 1) + "…" : s;
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
