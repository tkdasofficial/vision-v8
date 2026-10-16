// Decides which workflow a chat message needs. Browser-safe and pure (tested in src/test/request-route.test.ts).
// Vision is a text model: anything that isn't an explicit tool/file/project request becomes a normal written answer.
import type { ChatMode } from "./modes";

export type RequestRoute =
  | { kind: "chat" }
  | { kind: "tool" }
  | { kind: "project" }
  | { kind: "code_export"; language: string }
  | { kind: "file"; format: string };

/** Long pasted briefs are instructions for a written answer, not one-word tool triggers. */
const SHORT = 600;
const CODE_FORMATS = ["js", "ts", "py", "sql", "sh", "bat", "html", "css", "json", "yaml", "toml", "xml"];

export function routeRequest(content: string, mode: ChatMode = "default"): RequestRoute {
  // Deep Thinking, Research and Coding always answer in chat.
  if (mode !== "default") return { kind: "chat" };
  const short = content.length <= SHORT;

  const isTool = short && (
    /\b(qr\s*code|barcode|code ?128|code ?39|ean-?13|ean-?8|upc-?[ae]|sha-?(1|256|384|512)|checksum|hash of|base64|jwt|uuid|generate (a )?password|strong password|unit conver|convert \d|chart|bar graph|line graph|pie chart|diagram|flowchart|mermaid|gantt|word document|\.docx|docx|epub|e-?book|fetch (the )?(page|url|website)|scrape|extract (text|links)|redact|privacy scan|json to csv|csv to json)\b/i.test(content)
    || (/\b(create|make|generate|export|save|convert)\b/i.test(content) && /\b(pdf|docx|epub|excel|xlsx|spreadsheet|csv)\b/i.test(content))
    || (/https?:\/\/\S+/.test(content) && /\b(summari[sz]e|extract|fetch|save|convert)\b/i.test(content)));
  if (isTool) return { kind: "tool" };

  const isProject = short && /\b(build|create|make|generate)\b.{0,40}\b(web\s*app|website|landing\s*page|portfolio|single.page.app|(2d|3d|browser|html5|arcade|puzzle|platformer)?\s*game)\b/i.test(content);
  if (isProject) return { kind: "project" };

  // Files only when the user explicitly asks for a file in a format.
  const fmt = content.match(/\b(?:as|in|to|into)\s+(?:an?\s+)?\.?(txt|pdf|md|html|css|csv|json|xml|js|ts|py|sql|yaml|toml|sh|bat|rtf|xlsx|xls)\s+(?:file|document|format)\b/i)
    || content.match(/\b(?:save|export|download)\b.{0,40}\b(?:as|to|into)\s+(?:an?\s+)?\.?(txt|pdf|md|html|csv|json|xml|xlsx|xls)\b/i)
    || content.match(/\.?(txt|pdf|md|html|css|csv|json|xml|js|ts|py|sql|yaml|toml|sh|bat|rtf|xlsx|xls)\s+file\b/i);
  const excel = short && /\b(create|make|generate|build)\b.{0,30}\b(excel|spreadsheet|workbook)\b/i.test(content);
  if (fmt && short) {
    const f = fmt[1].toLowerCase();
    return CODE_FORMATS.includes(f) ? { kind: "code_export", language: f } : { kind: "file", format: f };
  }
  if (excel) return { kind: "file", format: "xlsx" };
  return { kind: "chat" };
}

/** True when the user explicitly asks for sources/citations/references (not "source code"). */
export function asksForSources(text: string): boolean {
  return /\b(cite|citations?|with sources|(?:give|list|include|provide|add|show)\s+(?:me\s+)?(?:the\s+|your\s+)?(?:sources?|references?)(?!\s*code)|sources?\s+please|web\s*search|search\s+(?:the\s+)?(?:web|internet|online)|latest|recent\s+news|news\s+(?:about|on)|updates?\s+(?:about|on))\b/i.test(text);
}
