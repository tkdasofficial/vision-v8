// Cloudflare Workers AI calls used by chat tools: image reading (vision) and speech-to-text.
const base = () => {
  const account = process.env["CLOUDFLARE_ACCOUNT_ID"], token = process.env["CLOUDFLARE_API_TOKEN"];
  if (!account || !token) throw new Error("The AI service isn't configured on the server.");
  return { url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/`, token };
};

function b64(bytes: Uint8Array) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }

/** Asks the vision model about an image (OCR, description, charts…). */
export async function vision(bytes: Uint8Array, mime: string, prompt: string): Promise<string> {
  if (bytes.length > 8 * 1024 * 1024) throw new Error("Images up to 8 MB can be read.");
  const { url, token } = base();
  const res = await fetch(url + "@cf/meta/llama-4-scout-17b-16e-instruct", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ max_tokens: 4096, messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${mime};base64,${b64(bytes)}` } }] }] }),
    signal: AbortSignal.timeout(90_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 429 ? "The image reader is busy. Please try again shortly." : "The image reader couldn't process this image.");
  const text = j.result?.choices?.[0]?.message?.content ?? j.result?.response ?? "";
  if (!String(text).trim()) throw new Error("The image reader returned nothing.");
  return String(text).trim();
}

/** Speech-to-text. Returns plain text and WebVTT subtitles. */
export async function transcribe(bytes: Uint8Array): Promise<{ text: string; vtt: string; words: number }> {
  if (bytes.length > 25 * 1024 * 1024) throw new Error("Audio files up to 25 MB can be transcribed.");
  const { url, token } = base();
  const res = await fetch(url + "@cf/openai/whisper", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(120_000) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 429 ? "Transcription is busy. Please try again shortly." : "This audio couldn't be transcribed. Try MP3, WAV or OGG.");
  return { text: String(j.result?.text ?? "").trim(), vtt: String(j.result?.vtt ?? ""), words: j.result?.word_count ?? 0 };
}
