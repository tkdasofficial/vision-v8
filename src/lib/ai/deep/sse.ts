// OpenAI-compatible SSE helpers: collect a provider stream into text, and re-emit text as a stream.

export async function collectStream(body: ReadableStream<Uint8Array>): Promise<{ text: string; finishReason: string | null }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", finishReason: string | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const data = l.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const c = j.choices?.[0];
        text += c?.delta?.content ?? j.response ?? "";
        if (c?.finish_reason) finishReason = c.finish_reason;
      } catch { /* partial line */ }
    }
  }
  return { text, finishReason };
}

const enc = new TextEncoder();
export const sseChunk = (content: string) => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
export const sseDone = () => enc.encode("data: [DONE]\n\n");
export const sseComment = (c: string) => enc.encode(`: ${c}\n\n`);
/** Progress event: real backend stage, ignored by text parsers (no choices/response field). */
export const sseStatus = (stage: string, detail?: string) => enc.encode(`data: ${JSON.stringify({ vision_status: { stage, detail } })}\n\n`);
