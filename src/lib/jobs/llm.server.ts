// Collects a full text answer from the coding model chain (same providers as chat).
import { MODELS, type ModelRef } from "@/lib/ai/models.server";
import { streamFromProvider } from "@/lib/ai/providers.server";

const CODING: ModelRef[] = [MODELS.cfCoder, MODELS.groq120b, MODELS.cf120b];
/** Planning/JSON work: general reasoning models first. */
export const PLANNING: ModelRef[] = [MODELS.groq120b, MODELS.cf120b, MODELS.cfCoder];

export async function complete(system: string, user: string, opts: { maxTokens?: number; signal?: AbortSignal; models?: ModelRef[] } = {}): Promise<{ text: string; model: string }> {
  const signal = opts.signal ?? new AbortController().signal;
  const messages = [{ role: "system", content: system }, { role: "user", content: user }];
  let last = "AI couldn't answer right now.";
  for (const m of opts.models ?? CODING) {
    const r = await streamFromProvider(m, messages, { maxTokens: opts.maxTokens ?? 8192, deep: false }, signal);
    if (!r.ok) { last = r.status === 429 ? "AI is busy right now. Please try again in a moment." : last; continue; }
    const text = await readSse(r.body);
    const clean = text.replace(/<think>[\s\S]*?<\/think>/g, "");
    if (clean.trim()) return { text: clean, model: m.label };
    if (false) return { text, model: m.label };
  }
  throw new Error(last);
}

async function readSse(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try { const j = JSON.parse(data); out += j.choices?.[0]?.delta?.content ?? j.response ?? ""; } catch { /* partial */ }
    }
  }
  return out;
}
