// POST /ai/:provider — AI relay. The app (wherever it is hosted) sends an OpenAI-compatible
// chat body here; this Worker adds the provider key from its own Cloudflare secrets and
// streams the provider response back. Authorized with the dedicated AI_RELAY_TOKEN (separate from the mail token).
//   POST /ai/run  {model, input} — raw Workers AI run (image reading, speech-to-text).
export interface AiEnv {
  AI_RELAY_TOKEN?: string;
  NVIDIA_API_KEY?: string;
  GROQ_API_KEY?: string;
  AI?: { run: (model: string, input: unknown) => Promise<any> };
}

const UPSTREAM: Record<string, { url: string; key: keyof AiEnv }> = {
  nvidia: { url: "https://integrate.api.nvidia.com/v1/chat/completions", key: "NVIDIA_API_KEY" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY" },
};

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const json = (status: number, error: string) => Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function handleAi(req: Request, env: AiEnv, provider: string): Promise<Response> {
  if (req.method !== "POST") return json(405, "Method not allowed");
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.AI_RELAY_TOKEN || !token || !safeEqual(token, env.AI_RELAY_TOKEN)) return json(401, "unauthorized");
  const body: any = await req.json().catch(() => null);
  if (provider === "run") {
    if (!env.AI) return json(503, "not configured");
    if (!body || typeof body.model !== "string" || !/^@cf\//.test(body.model) || typeof body.input !== "object") return json(400, "invalid body");
    try { return Response.json({ result: await env.AI.run(body.model, body.input) }, { headers: { "Cache-Control": "no-store" } }); }
    catch (e: any) { const msg = String(e?.message ?? "workers ai error").slice(0, 300); return json(/429|capacity|rate|neurons/i.test(msg) ? 429 : 502, msg); }
  }
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) return json(400, "invalid body");

  if (provider === "cf") {
    if (!env.AI) return json(503, "not configured");
    try {
      const stream = await env.AI.run(body.model, { messages: body.messages, max_tokens: body.max_tokens, stream: true });
      if (!stream || typeof stream.getReader !== "function") return json(502, "workers ai returned no stream");
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
    } catch (e: any) {
      const msg = String(e?.message ?? "workers ai error").slice(0, 300);
      return json(/429|capacity|rate|neurons/i.test(msg) ? 429 : 502, msg);
    }
  }

  const up = UPSTREAM[provider];
  if (!up) return json(404, "unknown provider");
  const key = env[up.key];
  if (typeof key !== "string" || !key) return json(503, "not configured");
  const res = await fetch(up.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: req.signal,
  });
  const headers = new Headers({ "Content-Type": res.headers.get("content-type") ?? "text/event-stream", "Cache-Control": "no-store" });
  const ra = res.headers.get("retry-after");
  if (ra) headers.set("retry-after", ra);
  return new Response(res.body, { status: res.status, headers });
}
