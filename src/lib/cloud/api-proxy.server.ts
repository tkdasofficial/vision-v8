// Off-Worker API proxy: when the frontend is hosted anywhere other than the Cloudflare
// Worker (e.g. Lovable hosting), API calls must still execute on the Worker — that is
// where the D1 binding, Workers AI binding and provider secrets live. With API_ORIGIN set
// (the Worker's public URL, e.g. https://vision-app.<account>.workers.dev), every /api/*
// handler forwards the request there and streams the response back. On the Worker itself
// (DB/AI binding present) or without API_ORIGIN, requests are handled locally.

import { getD1Binding, getAiBinding, getSecret } from "@/lib/ai/runtime-env.server";

/** The Cloudflare Worker's public origin, when configured. */
export function getApiOrigin(): string | undefined {
  const raw = getSecret("API_ORIGIN");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.origin;
  } catch {
    return undefined;
  }
}

/** True when this process is the Cloudflare Worker (bindings present). */
export function isWorkerRuntime(): boolean {
  return !!(getD1Binding() || getAiBinding());
}

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"]);

/**
 * Returns a proxied Response when the request must run on the Cloudflare Worker,
 * or null when it should be handled locally. The local same-origin check runs
 * before forwarding; the forwarded request carries the session cookie and an
 * Origin matching the Worker so its own same-origin check passes.
 */
export async function maybeProxyToWorker(request: Request): Promise<Response | null> {
  if (isWorkerRuntime()) return null;
  const apiOrigin = getApiOrigin();
  if (!apiOrigin) return null;

  const { factsFrom, assertSameOrigin } = await import("@/lib/cloud/security.server");
  try {
    assertSameOrigin(factsFrom(request.headers, null));
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 403 });
  }

  const incoming = new URL(request.url);
  const target = `${apiOrigin}${incoming.pathname}${incoming.search}`;
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === "origin" || key === "referer") continue;
    headers.set(name, value);
  }
  headers.set("origin", apiOrigin);
  headers.set("referer", `${apiOrigin}/`);
  headers.set("x-forwarded-host", incoming.host);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Required by undici/Node when streaming a request body.
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
    } as RequestInit);
    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      const key = name.toLowerCase();
      if (HOP_BY_HOP.has(key) || key === "set-cookie") continue;
      responseHeaders.set(name, value);
    }
    // Session cookies from the Worker must be re-scoped to this origin.
    const setCookies = upstream.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookies) responseHeaders.append("set-cookie", cookie);
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
  } catch (e: any) {
    console.error("[api-proxy] worker unreachable", e?.message);
    return Response.json({ error: "The backend service is unreachable. Please try again shortly." }, { status: 502 });
  }
}
