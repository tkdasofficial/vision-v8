// Provider-specific request details (endpoint, key, options). Server-only; keys never leave here.
// Priority is NVIDIA → Groq → Cloudflare Workers AI (see TEXT_CHAIN). Keys come from process.env or the
// Cloudflare Worker env bindings (NVIDIA_API_KEY, GROQ_API_KEY), read by getSecret.
import type { ModelRef } from "./models.server";
import { getSecret } from "./runtime-env.server";

export function endpoint(t: ModelRef): { url: string; key?: string } {
  if (t.provider === "groq") return { url: "https://api.groq.com/openai/v1/chat/completions", key: getSecret("GROQ_API_KEY") };
  if (t.provider === "nvidia") return { url: "https://integrate.api.nvidia.com/v1/chat/completions", key: getSecret("NVIDIA_API_KEY") };
  const account = getSecret("CLOUDFLARE_ACCOUNT_ID");
  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/v1/chat/completions`, key: account ? getSecret("CLOUDFLARE_API_TOKEN") : undefined };
}

/** Safe category for diagnostics; never includes the provider body. */
export function failureCategory(status: number, reason: string): string {
  if (/not configured/.test(reason)) return "missing_binding";
  if (status === 401 || status === 403) return "auth";
  if (status === 429 && /quota|credit|exhaust|daily|neurons|insufficient/i.test(reason)) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 499) return "cancelled";
  if (status === 504 || status === 408) return "timeout";
  if (status === 404 && /model/i.test(reason)) return "invalid_model";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500) return "outage";
  return "unknown";
}

export type ProviderResult = { ok: true; body: ReadableStream<Uint8Array> } | { ok: false; status: number; reason: string };

import { AI_LIMITS } from "./limits";
const CONNECT_TIMEOUT_MS = AI_LIMITS.connectMs;

/**
 * Every model call (chat, Deep Thinking stages, Research, jobs/tools) goes through here, so the shared
 * retry policy applies everywhere. Only transient 5xx/timeouts and a real provider 429 are retried; local
 * cool-downs, missing config, permission and invalid-request errors fall through to the next model at once.
 * Retries happen before any byte is streamed, so they never duplicate output.
 */
export async function streamFromProvider(t: ModelRef, messages: unknown[], opts: { maxTokens: number; deep: boolean }, signal: AbortSignal): Promise<ProviderResult> {
  const { withRetry, classifyFailure } = await import("./failures");
  const { result } = await withRetry((attempt) => attemptProvider(t, messages, opts, signal, attempt), {
    classify: (r) => (r.ok ? null : /not configured|cooling down|queue full/.test(r.reason) ? "permanent" : classifyFailure(r.status, r.reason)),
    signal,
    onRetry: (i) => console.log(JSON.stringify({ tag: "[ai:retry]", provider: t.provider, model: t.model, ...i })),
  });
  return result;
}

async function attemptProvider(t: ModelRef, messages: unknown[], opts: { maxTokens: number; deep: boolean }, signal: AbortSignal, _attempt: number): Promise<ProviderResult> {
  const { url, key } = endpoint(t);
  if (!key) return { ok: false, status: 503, reason: "not configured" };
  const { limiter } = await import("./rate-limiter");
  if (!limiter.available(t.provider)) return { ok: false, status: 429, reason: "provider cooling down" };
  let release: () => void;
  try { release = await limiter.acquire(t.provider); } catch { return { ok: false, status: 429, reason: "rate limit queue full" }; }
  const t0 = Date.now();
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => ctrl.abort(), CONNECT_TIMEOUT_MS);
  const log = (status: number) => console.log(JSON.stringify({ tag: "[ai:call]", provider: t.provider, model: t.model, status, kind: status >= 200 && status < 300 ? "ok" : status === 499 ? "cancelled" : status === 504 ? "timeout" : "error", ms: Date.now() - t0, ...limiter.snapshot(t.provider) }));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: t.model,
        messages,
        stream: true,
        max_tokens: opts.maxTokens,
        ...(opts.deep && t.provider === "groq" ? { reasoning_effort: "high" } : {}),
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    limiter.report(t.provider, res.status, res.headers.get("retry-after"));
    log(res.status);
    if (res.ok && res.body) {
      // Hold the concurrency slot until the stream finishes.
      const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush() { release(); } }));
      signal.addEventListener("abort", () => release(), { once: true });
      return { ok: true, body };
    }
    release();
    const reason = (await res.text().catch(() => "")).slice(0, 300);
    console.log(JSON.stringify({ tag: "[ai:fail]", provider: t.provider, model: t.model, status: res.status, category: failureCategory(res.status, reason), ms: Date.now() - t0 }));
    return { ok: false, status: res.status, reason };
  } catch (e: any) {
    clearTimeout(timer);
    release();
    const status = signal.aborted ? 499 : 504;
    if (status === 504) limiter.report(t.provider, 504);
    log(status);
    return { ok: false, status, reason: e?.message ?? "network error" };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
