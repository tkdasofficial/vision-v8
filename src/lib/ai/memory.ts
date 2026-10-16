// Project Memory behavior. Pure, tested; D1 access lives in memory.server.ts.
//  - "none"    : chat outside any project → own history + personal preferences (unchanged behavior).
//  - "default" : project chat → own history + personal preferences (custom instructions); no other chats.
//  - "project" : project chat → own history + compact context from OTHER chats in the SAME project only;
//                personal custom instructions are NOT applied, so nothing personal leaks into the project.
// Missing/deleted projects or failed lookups fall back to "none" so chat keeps working.
import { fenceUntrusted } from "./context";

export type MemoryScope = "none" | "default" | "project";

export function resolveScope(projectId: string | null | undefined, memory: string | null | undefined): MemoryScope {
  if (!projectId) return "none";
  return memory === "project" ? "project" : "default";
}

export function includesPersonal(scope: MemoryScope): boolean {
  return scope !== "project";
}

export type ProjectNote = { chatId: string; title: string; content: string };

/** Builds the shared project context; rows from other projects or the current chat are ignored defensively. */
export function projectContextBlock(rows: (ProjectNote & { projectId: string })[], projectId: string, currentChatId: string, budget = 6000): string {
  let used = 0;
  const lines: string[] = [];
  for (const r of rows) {
    if (r.projectId !== projectId || r.chatId === currentChatId) continue;
    const line = `- (${r.title.slice(0, 60) || "Untitled chat"}) ${r.content.replace(/\s+/g, " ").slice(0, 400)}`;
    if (used + line.length > budget) break;
    lines.push(line); used += line.length;
  }
  if (!lines.length) return "";
  return `Project memory (earlier requests from other chats in this project; use as background, the current message wins on conflicts):\n${fenceUntrusted("project-memory", lines.join("\n"))}`;
}
