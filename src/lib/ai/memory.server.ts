// Server-only: one D1 round trip for prefs + the chat's project and memory setting (owner-checked).
import { d1 } from "@/lib/cloud/d1.server";
import { resolveScope, projectContextBlock, type MemoryScope } from "./memory";

export async function loadChatContext(userId: string, chatId: string | undefined): Promise<{ prefsRaw: unknown; projectId: string | null; scope: MemoryScope }> {
  const cid = chatId && /^[\w-]{1,64}$/.test(chatId) ? chatId : "";
  const row: any = (await d1(
    `SELECT (SELECT prefs FROM user_settings WHERE user_id = ?1 LIMIT 1) AS prefs,
            p.id AS project_id, p.memory AS memory
     FROM (SELECT 1) LEFT JOIN chat_sessions s ON s.id = ?2 AND s.user_id = ?1
     LEFT JOIN workspace_projects p ON p.id = s.project_id AND p.user_id = ?1`,
    [userId, cid],
  ).catch(() => []))[0];
  const projectId = row?.project_id ?? null;
  return { prefsRaw: row?.prefs ?? null, projectId, scope: resolveScope(projectId, row?.memory) };
}

/** Recent user requests from other chats of the same project, owned by the same user. Fails soft to "". */
export async function loadProjectMemory(userId: string, projectId: string, chatId: string): Promise<string> {
  const rows: any[] = await d1(
    `SELECT s.id AS chatId, s.title AS title, s.project_id AS projectId, m.content AS content
     FROM chat_sessions s JOIN chat_messages m ON m.session_id = s.id
     WHERE s.user_id = ? AND s.project_id = ? AND s.id <> ? AND m.role = 'user'
     ORDER BY m.created_at DESC LIMIT 30`,
    [userId, projectId, chatId],
  ).catch(() => []);
  return projectContextBlock(rows.map((r) => ({ ...r, content: String(r.content ?? ""), title: String(r.title ?? "") })), projectId, chatId);
}
