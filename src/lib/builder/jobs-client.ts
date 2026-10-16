// Browser helper: starts a job and polls its real status until it finishes.
import type { JobType, JobView } from "./statuses";
import { isTerminal } from "./statuses";

async function json(res: Response) {
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export async function fetchJob(id: string): Promise<JobView | null> {
  const res = await fetch(`/api/jobs/${id}`, { credentials: "include", cache: "no-store" });
  if (res.status === 404) return null;
  return (await json(res)).job;
}

export async function listJobs(sessionId?: string): Promise<JobView[]> {
  return (await json(await fetch(sessionId ? `/api/jobs?session=${encodeURIComponent(sessionId)}` : "/api/jobs", { credentials: "include", cache: "no-store" }))).jobs;
}

/** Starts a job; `onUpdate` receives each polled status while the server works. */
export async function runJob(type: JobType, payload: { input?: unknown; file?: File; files?: File[]; prompt?: string; sessionId?: string | null }, onUpdate: (j: JobView) => void, existingId?: string): Promise<JobView> {
  const id = existingId ?? crypto.randomUUID();
  let done = false;
  const poll = async () => {
    while (!done) {
      await new Promise((r) => setTimeout(r, 1200));
      if (done) break;
      const j = await fetchJob(id).catch(() => null);
      if (j && !done) { onUpdate(j); if (isTerminal(j.status)) break; }
    }
  };
  void poll();
  try {
    let res: Response;
    if (payload.files) {
      const fd = new FormData();
      fd.set("id", id); fd.set("type", "agent_task"); fd.set("prompt", payload.prompt ?? "");
      for (const f of payload.files) fd.append("file", f);
      if (payload.sessionId) fd.set("sessionId", payload.sessionId);
      res = await fetch("/api/jobs", { method: "POST", body: fd, credentials: "include" });
    } else if (payload.file) {
      const fd = new FormData();
      fd.set("id", id); fd.set("file", payload.file);
      if (payload.sessionId) fd.set("sessionId", payload.sessionId);
      res = await fetch("/api/jobs", { method: "POST", body: fd, credentials: "include" });
    } else {
      res = await fetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, type, input: payload.input, sessionId: payload.sessionId ?? undefined }), credentials: "include" });
    }
    const job: JobView = (await json(res)).job;
    done = true; onUpdate(job); return job;
  } catch (e) {
    // The request may have been cut off while the job kept running; trust the stored state.
    const j = await fetchJob(id).catch(() => null);
    done = true;
    if (j) { onUpdate(j); return j; }
    throw e;
  }
}

export async function cancelJob(id: string) {
  await json(await fetch(`/api/jobs/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }), credentials: "include" }));
}

export async function retryJob(id: string, onUpdate: (j: JobView) => void): Promise<JobView> {
  const newId = crypto.randomUUID();
  let done = false;
  void (async () => { while (!done) { await new Promise((r) => setTimeout(r, 1200)); const j = await fetchJob(newId).catch(() => null); if (j && !done) onUpdate(j); } })();
  try {
    const job = (await json(await fetch(`/api/jobs/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry", newId }), credentials: "include" }))).job;
    onUpdate(job); return job;
  } finally { done = true; }
}

export const downloadUrl = (artifactId: string) => `/api/artifacts/${artifactId}`;
