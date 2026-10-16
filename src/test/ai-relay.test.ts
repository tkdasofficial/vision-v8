import { describe, it, expect, afterEach } from "vitest";
import { endpoint } from "@/lib/ai/providers.server";
import { captureWorkerEnv } from "@/lib/ai/runtime-env.server";
import { handleAi } from "../../auth-gateway/src/ai";

const ORIGINS = "https://app.example.com,http://localhost:8080";

afterEach(() => { delete process.env.AI_RELAY_TOKEN; delete process.env.AUTH_ORIGIN; captureWorkerEnv({}); });

describe("AI relay routing", () => {
  it("off-Worker, AI calls target the vision Worker relay with the app origin", () => {
    process.env.AUTH_ORIGIN = "https://app.example.com";
    const e = endpoint({ provider: "groq", model: "m", label: "m" } as any);
    expect(e.url).toBe("https://vision.tusharkantidasofficial.workers.dev/ai/groq");
    expect(e.origin).toBe("https://app.example.com");
  });
  it("on the Worker, calls go straight to the provider", () => {
    process.env.AUTH_ORIGIN = "https://app.example.com";
    captureWorkerEnv({ DB: { prepare() {} } });
    expect(endpoint({ provider: "groq", model: "m", label: "m" } as any).url).toContain("api.groq.com");
  });
  it("off-Worker without AUTH_ORIGIN, never falls back to a direct provider call", () => {
    const e = endpoint({ provider: "nvidia", model: "m", label: "m" } as any);
    expect(e.url).toBe("https://vision.tusharkantidasofficial.workers.dev/ai/nvidia");
    expect(e.key).toBeUndefined();
    expect(e.origin).toBeUndefined();
  });
  it("relay refuses a request with no Origin", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", body: "{}" }), { ALLOWED_RETURN_ORIGINS: ORIGINS }, "groq");
    expect(r.status).toBe(401);
  });
  it("relay refuses an Origin that is not allowlisted", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { origin: "https://evil.example.com" }, body: "{}" }), { ALLOWED_RETURN_ORIGINS: ORIGINS }, "groq");
    expect(r.status).toBe(401);
  });
  it("relay accepts an allowlisted Origin and rejects an invalid body", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { origin: "https://app.example.com" }, body: "{}" }), { ALLOWED_RETURN_ORIGINS: ORIGINS, GROQ_API_KEY: "k" }, "groq");
    expect(r.status).toBe(400);
  });
  it("relay accepts the localhost origin during development", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { origin: "http://localhost:8080" }, body: "{}" }), { ALLOWED_RETURN_ORIGINS: ORIGINS, GROQ_API_KEY: "k" }, "groq");
    expect(r.status).toBe(400);
  });
});
