import { describe, it, expect, afterEach } from "vitest";
import { endpoint } from "@/lib/ai/providers.server";
import { captureWorkerEnv } from "@/lib/ai/runtime-env.server";
import { handleAi } from "../../auth-gateway/src/ai";

afterEach(() => { delete process.env.AI_RELAY_TOKEN; captureWorkerEnv({}); });

describe("AI relay routing", () => {
  it("off-Worker, AI calls target the vision Worker relay", () => {
    process.env.AI_RELAY_TOKEN = "t";
    expect(endpoint({ provider: "groq", model: "m", label: "m" } as any).url).toBe("https://vision.tusharkantidasofficial.workers.dev/ai/groq");
  });
  it("on the Worker, calls go straight to the provider", () => {
    process.env.AI_RELAY_TOKEN = "t";
    captureWorkerEnv({ DB: { prepare() {} } });
    expect(endpoint({ provider: "groq", model: "m", label: "m" } as any).url).toContain("api.groq.com");
  });
  it("off-Worker without the token, never falls back to a direct provider call", () => {
    const e = endpoint({ provider: "nvidia", model: "m", label: "m" } as any);
    expect(e.url).toBe("https://vision.tusharkantidasofficial.workers.dev/ai/nvidia");
    expect(e.key).toBeUndefined();
  });
  it("relay refuses when the Worker has no token configured", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" }), {}, "groq");
    expect(r.status).toBe(401);
  });
  it("relay rejects a wrong token", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { authorization: "Bearer no" }, body: "{}" }), { AI_RELAY_TOKEN: "yes" }, "groq");
    expect(r.status).toBe(401);
  });
});
