// Background completion for chat replies: the work keeps running after the browser leaves or reloads,
// and the finished answer is written to the user's chat so it is there when they come back.

/** Keeps the Worker alive until `p` settles, even if the client disconnected. No-op outside workerd. */
export function keepAlive(p: Promise<unknown>) {
  import(/* @vite-ignore */ "cloudflare:workers" as string)
    .then((m: any) => { try { m.waitUntil?.(p); } catch { /* not in a request */ } })
    .catch(() => { /* dev server: the process stays alive anyway */ });
}

/**
 * Saves the finished reply under the id the browser uses for it. INSERT OR IGNORE: if the browser
 * already saved it, nothing changes; the session must belong to the caller.
 */
export async function saveReply(userId: string, chatId: string | undefined, replyId: string, content: string, meta: Record<string, unknown> = {}) {
  if (!chatId || !content.trim() || !/^[\w-]{8,64}$/.test(replyId)) return;
  try {
    const { d1 } = await import("@/lib/cloud/d1.server");
    await d1(
      "INSERT OR IGNORE INTO chat_messages (id, session_id, role, content, metadata, created_at) SELECT ?, id, 'assistant', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM chat_sessions WHERE id = ? AND user_id = ?",
      [replyId, content, JSON.stringify({ ...meta, background: true }), chatId, userId],
    );
    await d1("UPDATE chat_sessions SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND user_id = ?", [chatId, userId]);
  } catch (e) {
    console.error("[chat:background] save failed", (e as Error)?.message);
  }
}
