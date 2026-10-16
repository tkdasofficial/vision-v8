// Server-only access to the Vision database on Cloudflare D1 (via the Cloudflare API).
import { getSecret, getD1Binding } from "@/lib/ai/runtime-env.server";

const DATABASE_ID = "ded73090-4d47-45ac-952f-24ae2beaba5f";

export async function d1<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = getD1Binding();
  if (db) {
    const result = await db.prepare(sql).bind(...params).all<T>();
    if (result.success === false) throw new Error("Database request failed");
    return result.results ?? [];
  }
  const account = getSecret("CLOUDFLARE_ACCOUNT_ID");
  const token = getSecret("CLOUDFLARE_API_TOKEN");
  if (!account || !token) throw new Error("Database is not configured");
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${DATABASE_ID}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    },
  );
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    console.error("[d1] query failed", res.status, JSON.stringify(body?.errors ?? body));
    throw new Error("Database request failed");
  }
  return (body.result?.[0]?.results ?? []) as T[];
}
