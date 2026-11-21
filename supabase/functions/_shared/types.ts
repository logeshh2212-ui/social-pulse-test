export type Platform =
  | "rss" | "youtube" | "instagram" | "threads"
  | "facebook" | "linkedin" | "reddit" | "x";

export type SourceStatus =
  | "active" | "auth_required" | "permission_required"
  | "unsupported" | "degraded" | "disabled";

/** Row of public.monitored_accounts (fields the collector uses). */
export interface MonitoredAccount {
  id: string;
  platform: Platform;
  username: string | null;
  external_account_id: string | null;
  source_url: string | null;
  token_secret: string | null;
  etag: string | null;
  last_modified: string | null;
  baseline_completed: boolean;
}

/** A post in the shape every adapter must return. */
export interface NormalizedPost {
  external_post_id: string;
  post_url: string | null;
  content_text: string | null;
  media_type: string | null;
  published_at: string | null; // ISO 8601
  raw_metadata: Record<string, unknown>;
}

export interface FetchResult {
  notModified: boolean;
  posts: NormalizedPost[];
  etag?: string | null;
  lastModified?: string | null;
}

export interface Adapter {
  fetchPosts(account: MonitoredAccount): Promise<FetchResult>;
}

/** Error an adapter throws to set an explicit source status. */
export class SourceError extends Error {
  constructor(message: string, public readonly status: SourceStatus | null = null) {
    super(message);
  }
}
