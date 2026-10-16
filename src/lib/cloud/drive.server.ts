// Server-only Google Drive storage. Files uploaded by users go into the
// configured Drive folder, sorted into per-type sub-folders (Images, Videos,
// PDFs, Text, Code, Other). D1 keeps the file record + link; chats never
// touch Drive.
import { d1 } from "./d1.server";

const SUBFOLDERS = ["Images", "Videos", "PDFs", "Text", "Code", "Other", "Artifacts"] as const;
type Kind = (typeof SUBFOLDERS)[number];

export function kindForMime(mime: string, name: string): Kind {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "Images";
  if (m.startsWith("video/")) return "Videos";
  if (m === "application/pdf" || /\.pdf$/i.test(name)) return "PDFs";
  if (m.startsWith("text/") || /\.(txt|md|csv|log)$/i.test(name)) return "Text";
  if (/\.(js|ts|tsx|jsx|json|py|rb|go|rs|java|c|cpp|h|css|html|sh|sql|yml|yaml)$/i.test(name)) return "Code";
  return "Other";
}

async function accessToken(): Promise<string> {
  const id = process.env["GOOGLE_CLIENT_ID"];
  const secret = process.env["GOOGLE_CLIENT_SECRET"];
  const refresh = process.env["GOOGLE_REFRESH_TOKEN"];
  if (!id || !secret || !refresh) throw new Error("File storage is not configured");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const body: any = await res.json();
  if (!res.ok || !body.access_token) throw new Error("Could not reach file storage");
  return body.access_token;
}

async function driveFetch(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    console.error("[drive]", res.status, text);
    throw new Error("File storage request failed");
  }
  return res;
}

async function findFolder(token: string, name: string, parent: string): Promise<string | null> {
  const q = encodeURIComponent(`name='${name}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveFetch(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  const body: any = await res.json();
  return body.files?.[0]?.id ?? null;
}

async function ensureFolder(token: string, name: string, parent: string): Promise<string> {
  const existing = await findFolder(token, name, parent);
  if (existing) return existing;
  const res = await driveFetch(token, "https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parent] }),
  });
  return ((await res.json()) as any).id;
}

/** Returns the sub-folder id for a kind, creating and caching folders once. */
async function folderFor(token: string, kind: Kind): Promise<string> {
  const root = process.env["GOOGLE_DRIVE_FOLDER_ID"];
  if (!root) throw new Error("File storage folder is not configured");
  const cacheKey = `drive_folder_${kind}`;
  const cached = await d1<{ value: string }>("SELECT value FROM app_config WHERE key = ?", [cacheKey]);
  if (cached[0]?.value) return cached[0].value;
  const id = await ensureFolder(token, kind, root);
  await d1("INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [cacheKey, id]);
  return id;
}

/** Uploads a file to Drive, makes it link-readable, and records it in D1. */
export async function storeFile(userId: string, name: string, mime: string, bytes: Uint8Array, projectId: string | null = null) {
  const token = await accessToken();
  const kind = kindForMime(mime, name);
  const folder = await folderFor(token, kind);
  const safeName = name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

  const boundary = "vision" + crypto.randomUUID().replace(/-/g, "");
  const meta = JSON.stringify({ name: safeName, parents: [folder] });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || "application/octet-stream"}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const enc = new TextEncoder();
  const body = new Uint8Array(enc.encode(head).length + bytes.length + enc.encode(tail).length);
  body.set(enc.encode(head), 0);
  body.set(bytes, enc.encode(head).length);
  body.set(enc.encode(tail), enc.encode(head).length + bytes.length);

  const res = await driveFetch(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const fileId = ((await res.json()) as any).id as string;

  // Anyone with the link can view — the app only ever shows users their own links.
  await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });

  const url = `https://drive.google.com/file/d/${fileId}/view`;
  const id = crypto.randomUUID();
  await d1(
    "INSERT INTO user_files (id, user_id, name, mime, kind, size, drive_file_id, url, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, userId, safeName, mime || "application/octet-stream", kind, bytes.length, fileId, url, projectId, new Date().toISOString()],
  );
  return { id, name: safeName, mime, kind, size: bytes.length, url, project_id: projectId, created_at: new Date().toISOString() };
}

export async function listFiles(userId: string, projectId?: string | null) {
  if (projectId) return d1("SELECT id, name, mime, kind, size, url, project_id, created_at FROM user_files WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC", [userId, projectId]);
  return d1("SELECT id, name, mime, kind, size, url, project_id, created_at FROM user_files WHERE user_id = ? ORDER BY created_at DESC", [userId]);
}

export async function deleteFile(userId: string, fileId: string) {
  const rows = await d1<{ drive_file_id: string }>("SELECT drive_file_id FROM user_files WHERE id = ? AND user_id = ?", [fileId, userId]);
  if (!rows[0]) throw new Error("File not found");
  const token = await accessToken();
  await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${rows[0].drive_file_id}`, { method: "DELETE" });
  await d1("DELETE FROM user_files WHERE id = ?", [fileId]);
  return { ok: true };
}

/** Stores a private job artifact (no public link). Returns the Drive file id. */
export async function storePrivate(name: string, mime: string, bytes: Uint8Array): Promise<string> {
  const token = await accessToken();
  const folder = await folderFor(token, "Artifacts");
  const boundary = "vision" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder] })}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const res = await driveFetch(token, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  return ((await res.json()) as any).id as string;
}

export async function readPrivate(driveFileId: string): Promise<Response> {
  const token = await accessToken();
  return driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`);
}

export async function deletePrivate(driveFileId: string): Promise<void> {
  const token = await accessToken();
  await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}`, { method: "DELETE" }).catch(() => undefined);
}
