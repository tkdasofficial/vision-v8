// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { backendFetch, backendUrl, normalizeBackendUrl } from "@/lib/backend";
import { allowedBackendOrigin, configuredOrigins, isBackendPath } from "@/lib/backend-policy";
import { createCloudflareBoundary } from "@/lib/cloud/worker-boundary";
import { captureWorkerEnv } from "@/lib/ai/runtime-env.server";
import { d1 } from "@/lib/cloud/d1.server";
import { stableRpcPath } from "@/lib/rpc-id";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); captureWorkerEnv({}); });

describe("frontend goes only to configured Cloudflare", () => {
  it("maps Vite's dev IDs to matching stable production handler IDs", () => {
    const metadata = btoa(JSON.stringify({ file: "/src/lib/cloud/auth.functions.ts?tss-serverfn-split", export: "getCurrentUser_createServerFn_handler" })).replace(/=/g, "");
    expect(stableRpcPath(`/_serverFn/${metadata}`)).toBe("/_serverFn/getCurrentUser_createServerFn_handler");
    expect(stableRpcPath("/_serverFn/getCurrentUser_createServerFn_handler")).toBe("/_serverFn/getCurrentUser_createServerFn_handler");
  });
  it.each(["/api/chat", "/api/files?project=abc", "/api/jobs/123", "/api/artifacts/123", "/_serverFn/opaque-id"]) ("routes %s with credentials and no local fallback", async (path) => {
    vi.stubEnv("VITE_CLOUDFLARE_API_URL", "https://backend.example/");
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const abort = new AbortController();
    await backendFetch(path, { method: "POST", body: "serialized", signal: abort.signal });
    expect(f).toHaveBeenCalledExactlyOnceWith(`https://backend.example${path}`, expect.objectContaining({ credentials: "include", method: "POST", body: "serialized", signal: abort.signal }));
  });
  it("keeps the native RPC Request bytes and headers", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    await backendFetch(new Request("https://frontend.test/_serverFn/id", { method: "POST", headers: { "x-tsr-serverFn": "true" }, body: "native serialization" }));
    const request = f.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    if (!(request instanceof Request)) throw new Error("Request missing");
    expect(request.url).toBe(backendUrl("/_serverFn/id"));
    expect(await request.text()).toBe("native serialization");
    expect(request.headers.get("x-tsr-serverFn")).toBe("true");
  });
  it("never retries at the preview on an unavailable RPC endpoint", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not found", { status: 404 }));
    await expect(backendFetch("/_serverFn/id")).rejects.toThrow("matching request handlers");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("rejects insecure endpoints and non-API arbitrary proxies", async () => {
    expect(() => normalizeBackendUrl("http://external.test")).toThrow();
    expect(() => normalizeBackendUrl("https://user:secret@external.test")).toThrow();
    await expect(backendFetch("https://external.test/private")).rejects.toThrow();
    expect(normalizeBackendUrl("http://localhost:8080/")).toBe("http://localhost:8080");
  });
});

describe("Worker security and gateway preservation", () => {
  const env = { ALLOWED_RETURN_ORIGINS: "https://frontend.test", DB: { sentinel: true } };
  const url = "https://backend.test/api/chat";
  it("allows an exact configured frontend, never lookalike origins", () => {
    expect(allowedBackendOrigin("https://frontend.test", url, configuredOrigins(env.ALLOWED_RETURN_ORIGINS))).toBe(true);
    expect(allowedBackendOrigin("https://frontend.test.evil.test", url, ["https://frontend.test"])).toBe(false);
    expect(isBackendPath("/api/oauth-callback/google")).toBe(true);
    expect(isBackendPath("/auth/google/callback")).toBe(false);
    expect(isBackendPath("/health")).toBe(false);
  });
  it("answers native RPC preflight without running the app", async () => {
    const app = { fetch: vi.fn() }; const gateway = { fetch: vi.fn() };
    const result = await createCloudflareBoundary(app, gateway).fetch(new Request(url, { method: "OPTIONS", headers: { Origin: "https://frontend.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-tsr-serverFn" } }), env, {});
    expect(result.status).toBe(204);
    expect(result.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(app.fetch).not.toHaveBeenCalled();
  });
  it("rejects unapproved origins before any backend execution", async () => {
    const app = { fetch: vi.fn() }; const gateway = { fetch: vi.fn() };
    const result = await createCloudflareBoundary(app, gateway).fetch(new Request(url, { headers: { Origin: "https://evil.test" } }), env, {});
    expect(result.status).toBe(403); expect(app.fetch).not.toHaveBeenCalled();
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
  it("preserves streams, cookies, error status, bindings and execution context", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: hello\n\n")); c.close(); } });
    const app = { fetch: vi.fn().mockResolvedValue(new Response(stream, { status: 429, headers: { "Set-Cookie": "vision_session=opaque; HttpOnly; Secure; SameSite=None; Partitioned", "Content-Type": "text/event-stream" } })) };
    const context = { waitUntil: vi.fn() };
    const result = await createCloudflareBoundary(app, { fetch: vi.fn() }).fetch(new Request(url, { headers: { Origin: "https://frontend.test" } }), env, context);
    expect(result.status).toBe(429); expect(result.body).toBe(stream);
    expect(result.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe("https://frontend.test");
    expect(app.fetch.mock.calls[0]?.[1]).toMatchObject({ DB: env.DB, VISION_BACKEND_RUNTIME: "cloudflare" });
    expect(app.fetch.mock.calls[0]?.[2]).toBe(context);
  });
  it.each(["/mail", "/runtime/claim", "/auth/google/start", "/auth/github/callback", "/.well-known/jwks.json"]) ("retains existing gateway %s", async (path) => {
    const app = { fetch: vi.fn() }; const response = new Response("gateway");
    const gateway = { fetch: vi.fn().mockResolvedValue(response) };
    expect(await createCloudflareBoundary(app, gateway).fetch(new Request(`https://backend.test${path}`), env, {})).toBe(response);
    expect(app.fetch).not.toHaveBeenCalled();
  });
  it("reuses DB binding without a Cloudflare REST token or network call", async () => {
    const all = vi.fn().mockResolvedValue({ success: true, results: [{ id: "existing" }] });
    const bind = vi.fn().mockReturnValue({ all }); const prepare = vi.fn().mockReturnValue({ bind });
    captureWorkerEnv({ DB: { prepare } });
    const f = vi.spyOn(globalThis, "fetch");
    expect(await d1("SELECT id FROM profiles WHERE id = ?", ["existing"])).toEqual([{ id: "existing" }]);
    expect(bind).toHaveBeenCalledWith("existing"); expect(f).not.toHaveBeenCalled();
  });
});