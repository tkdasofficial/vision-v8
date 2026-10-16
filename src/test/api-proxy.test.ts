// Verifies the off-Worker API proxy: on the Worker requests stay local; off-Worker with
// API_ORIGIN they are forwarded to the Cloudflare Worker (cookie preserved, origin
// rewritten, response streamed back); without API_ORIGIN nothing is proxied.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { maybeProxyToWorker, isWorkerRuntime, getApiOrigin } from "@/lib/cloud/api-proxy.server";
import { captureWorkerEnv } from "@/lib/ai/runtime-env.server";

const ENV_KEY = "__visionWorkerEnv";
const WORKER = "https://vision-app.example.workers.dev";

function req(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { origin: "http://localhost", "sec-fetch-site": "same-origin", cookie: "vision_session=abc123", ...(init.headers ?? {}) },
  });
}

describe("api-proxy", () => {
  const savedEnv = process.env.API_ORIGIN;
  beforeEach(() => {
    (globalThis as any)[ENV_KEY] = undefined;
    process.env.API_ORIGIN = WORKER;
  });
  afterEach(() => {
    (globalThis as any)[ENV_KEY] = undefined;
    if (savedEnv === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = savedEnv;
  });

  it("reports the configured API origin", () => {
    expect(getApiOrigin()).toBe(WORKER);
    expect(isWorkerRuntime()).toBe(false);
  });

  it("handles requests locally on the Worker (bindings present)", async () => {
    captureWorkerEnv({ DB: { prepare: () => ({}) }, AI: { run: async () => null } });
    expect(isWorkerRuntime()).toBe(true);
    expect(await maybeProxyToWorker(req("/api/chat", { method: "POST", body: "{}" }))).toBeNull();
  });

  it("fails with a clear 503 when API_ORIGIN is not set (never runs API calls locally off-Worker)", async () => {
    delete process.env.API_ORIGIN;
    expect(getApiOrigin()).toBeUndefined();
    const res = await maybeProxyToWorker(req("/api/chat", { method: "POST", body: "{}" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(503);
    const body = await res!.json();
    expect(body.error).toMatch(/not configured/i);
  });

  it("forwards off-Worker requests to the Worker with cookie and rewritten origin", async () => {
    const seen: { url?: string; cookie?: string | null; origin?: string | null; method?: string; body?: string } = {};
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.cookie = init.headers.get("cookie");
      seen.origin = init.headers.get("origin");
      seen.method = init.method;
      seen.body = await new Response(init.body).text();
      return new Response("data: ok\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as any;
    try {
      const res = await maybeProxyToWorker(req("/api/chat?x=1", { method: "POST", body: JSON.stringify({ messages: [] }), headers: { "content-type": "application/json" } }));
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(await res!.text()).toBe("data: ok\n\n");
      expect(seen.url).toBe(`${WORKER}/api/chat?x=1`);
      expect(seen.method).toBe("POST");
      expect(seen.cookie).toBe("vision_session=abc123");
      expect(seen.origin).toBe(WORKER);
      expect(seen.body).toBe(JSON.stringify({ messages: [] }));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("blocks cross-site requests before proxying", async () => {
    const crossSite = new Request("http://localhost/api/chat", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    const res = await maybeProxyToWorker(crossSite);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("returns 502 when the Worker is unreachable", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("connect refused"); }) as any;
    try {
      const res = await maybeProxyToWorker(req("/api/chat", { method: "POST", body: "{}" }));
      expect(res!.status).toBe(502);
      const body = await res!.json();
      expect(body.error).toMatch(/unreachable/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("workers ai binding path", () => {
  afterEach(() => {
    (globalThis as any)[ENV_KEY] = undefined;
  });

  it("uses the AI binding for the Cloudflare provider when present (no REST call)", async () => {
    const encoder = new TextEncoder();
    captureWorkerEnv({
      AI: {
        run: async (model: string, input: any) => {
          expect(model).toBe("@cf/openai/gpt-oss-120b");
          expect(input.stream).toBe(true);
          return new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
              c.enqueue(encoder.encode("data: [DONE]\n\n"));
              c.close();
            },
          });
        },
      },
    });
    let restCalled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { restCalled = true; throw new Error("REST must not be called"); }) as any;
    try {
      const { streamFromProvider } = await import("@/lib/ai/providers.server");
      const { MODELS } = await import("@/lib/ai/models.server");
      const result = await streamFromProvider(MODELS.cf120b, [{ role: "user", content: "hello" }], { maxTokens: 16, deep: false }, new AbortController().signal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const text = await new Response(result.body).text();
        expect(text).toContain('"hi"');
      }
      expect(restCalled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("on-Worker without the AI binding and without REST credentials fails as not configured (never relays)", async () => {
    captureWorkerEnv({ DB: { prepare: () => ({}) } });
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    const { streamFromProvider } = await import("@/lib/ai/providers.server");
    const { MODELS } = await import("@/lib/ai/models.server");
    const result = await streamFromProvider(MODELS.cf120b, [{ role: "user", content: "hello" }], { maxTokens: 16, deep: false }, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not configured/);
  });
});
