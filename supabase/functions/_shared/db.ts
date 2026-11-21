import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Service-role client: bypasses RLS. Only ever used server-side.
export const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** Read a Vault secret via the get_secret() RPC. Never log the return value. */
export async function getSecret(name: string): Promise<string | null> {
  const { data, error } = await db.rpc("get_secret", { p_name: name });
  if (error) throw new Error(`get_secret(${name}) failed: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Only pg_cron (which knows the Vault cron_secret) may trigger our jobs. */
export async function isAuthorizedCron(req: Request): Promise<boolean> {
  const given = req.headers.get("x-cron-secret");
  if (!given) return false;
  const expected = await getSecret("cron_secret");
  return expected !== null && timingSafeEqual(given, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Remove anything that looks like a secret URL or token from error text. */
export function redact(message: string): string {
  return message
    .replace(/https:\/\/hooks\.slack\.com\/\S*/g, "[slack-webhook]")
    .replace(/access_token=[^&\s]+/g, "access_token=[redacted]")
    .replace(/\b(EAA|IGAA)[A-Za-z0-9]{20,}/g, "[token]");
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
