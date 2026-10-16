import { describe, it, expect, afterEach } from "vitest";
import { endpoint } from "@/lib/ai/providers.server";
import { captureWorkerEnv } from "@/lib/ai/runtime-env.server";
import { handleAi } from "../../auth-gateway/src/ai";

afterEach(() => { delete process.env.MAIL_TOKEN; captureWorkerEnv({}); });

describe("AI relay routing", () => {
  it("off-Worker, AI calls target the vision Worker relay", () => {
    process.env.MAIL_TOKEN = "t";
    expect(endpoint({ provider: "groq", model: "m", label: "m" } as any).url).toBe("https://vision.tusharkantidasofficial.workers.dev/ai/groq");
  });
  it("on the Worker, calls go straight to the provider", () => {
    process.env.MAIL_TOKEN = "t";
    captureWorkerEnv({ DB: { prepare() {} } });
    expect(endpoint({ provider: "groq", model: "m", label: "m" } as any).url).toContain("api.groq.com");
  });
  it("relay rejects a wrong token", async () => {
    const r = await handleAi(new Request("https://x/ai/groq", { method: "POST", headers: { authorization: "Bearer no" }, body: "{}" }), { MAIL_TOKEN: "yes" }, "groq");
    expect(r.status).toBe(401);
  });
});
