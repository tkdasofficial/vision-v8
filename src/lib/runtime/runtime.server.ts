// Connects VISION jobs to the GitHub Actions runtime: create + dispatch, then sync status/results on each poll.
// Lifecycle: QUEUED → DISPATCHED → RUNNING → COMPLETED, plus FAILED / CANCELLED / TIMED_OUT.
import { d1 } from "@/lib/cloud/d1.server";
import { JobRun, ARTIFACT_TTL_MS, safeError } from "@/lib/jobs/jobs.server";
import { RUNTIME_OPS, RUNTIME_LIMITS, cleanParams, outputMatches, outputName, TARGET_MIME, type RuntimeOpId } from "./operations";

const now = () => new Date().toISOString();

export type RuntimeInput = { operation: RuntimeOpId; params: Record<string, unknown>; fileName: string; mime: string; bytes: Uint8Array; sourceArtifactId?: string | null };

async function sha256Hex(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validates, stores the input privately, records the runtime job and dispatches it exactly once. */
export async function startRuntimeJob(job: JobRun, input: RuntimeInput): Promise<void> {
  const op = RUNTIME_OPS[input.operation];
  if (!op) throw new Error("Operation is not permitted.");
  await job.step("validating", "Validating the request and file");
  const params = cleanParams(op.id, input.params);
  if (!input.bytes?.length) throw new Error("The file is empty.");
  if (input.bytes.length > op.maxInput) throw new Error(`Files up to ${op.maxInput / 1024 / 1024} MB are supported for this task.`);

  const active = await d1<{ mine: number; all: number }>(
    "SELECT SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine, COUNT(*) AS \"all\" FROM runtime_jobs WHERE status IN ('queued','dispatched','running','uploaded','finalizing')", [job.userId]);
  if ((active[0]?.mine ?? 0) >= RUNTIME_LIMITS.perUserActive) throw new Error(`You already have ${RUNTIME_LIMITS.perUserActive} background tasks running. Wait for one to finish.`);
  if ((active[0]?.all ?? 0) >= RUNTIME_LIMITS.globalActive) throw new Error("The background runtime is busy right now. Please try again in a few minutes.");

  await job.step("uploading", "Storing the file privately for the runner");
  const { putD1Artifact } = await import("@/lib/jobs/artifact-store.server");
  const { key, chunks } = await putD1Artifact(input.bytes);
  const hash = await sha256Hex(input.bytes);
  // Keep a source record so the task can be retried without re-uploading.
  const srcId = crypto.randomUUID();
  await d1("INSERT INTO job_artifacts (id, job_id, user_id, name, mime, size, sha256, drive_file_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'source', ?, ?)",
    [srcId, job.id, job.userId, input.fileName, input.mime, input.bytes.length, hash, key, new Date(Date.now() + ARTIFACT_TTL_MS).toISOString(), now()]);
  await d1("UPDATE jobs SET input = ? WHERE id = ?", [JSON.stringify({ operation: op.id, params, fileName: input.fileName, mime: input.mime, sourceArtifactId: srcId }), job.id]);

  const deadline = new Date(Date.now() + op.timeoutMs + RUNTIME_LIMITS.queueGraceMs).toISOString();
  await d1("INSERT INTO runtime_jobs (job_id, user_id, operation, params, input_key, input_name, input_mime, input_size, input_sha256, input_chunks, status, deadline, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
    [job.id, job.userId, op.id, JSON.stringify(params), key, input.fileName, input.mime, input.bytes.length, hash, chunks, deadline, now(), now()]);

  // Duplicate protection: only the request that flips queued → dispatched may call GitHub.
  const won = await d1("UPDATE runtime_jobs SET status = 'dispatched', dispatched_at = ?, updated_at = ? WHERE job_id = ? AND status = 'queued' RETURNING job_id", [now(), now(), job.id]);
  if (!won.length) return;
  await job.step("queued", "Sending to the background runtime");
  const { dispatchRun } = await import("./github.server");
  try {
    const runId = await dispatchRun(job.id, op.id);
    if (runId) await d1("UPDATE runtime_jobs SET run_id = COALESCE(run_id, ?) WHERE job_id = ?", [runId, job.id]);
  } catch (e) {
    await d1("UPDATE runtime_jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?", [safeError(e), now(), job.id]);
    throw e;
  }
  await job.step("dispatched", "Waiting for a GitHub runner");
}

const STAGE_STEP: Record<string, ["running" | "validating" | "processing" | "verifying" | "uploading", string]> = {
  claimed: ["running", "Runner started"],
  validating_input: ["validating", "Checking the file on the runner"],
  processing: ["processing", "Processing the file"],
  validating_output: ["verifying", "Validating the output"],
  uploading_output: ["uploading", "Preparing the download"],
};

/** Brings a runtime job's VISION record up to date. Safe to call on every poll; terminal work happens once. */
export async function syncRuntimeJob(jobRow: any): Promise<boolean> {
  const rows = await d1<any>("SELECT * FROM runtime_jobs WHERE job_id = ?", [jobRow.id]);
  const rt = rows[0];
  if (!rt) return false;
  const job = JobRun.restore(jobRow);
  let changed = false;

  // Cancellation requested by the owner.
  if (jobRow.cancel_requested && ["queued", "dispatched", "running"].includes(rt.status)) {
    const flip = await d1("UPDATE runtime_jobs SET status = 'cancelled', session_hash = NULL, updated_at = ? WHERE job_id = ? AND status IN ('queued','dispatched','running') RETURNING run_id", [now(), rt.job_id]);
    if (flip.length) {
      if (flip[0].run_id) await (await import("./github.server")).cancelRun(flip[0].run_id);
      await job.cancelled();
      return true;
    }
  }

  // Deadline: never wait forever.
  if (["queued", "dispatched", "running"].includes(rt.status) && Date.parse(rt.deadline) < Date.now()) {
    const flip = await d1("UPDATE runtime_jobs SET status = 'timed_out', session_hash = NULL, updated_at = ? WHERE job_id = ? AND status IN ('queued','dispatched','running') RETURNING run_id", [now(), rt.job_id]);
    if (flip.length) {
      if (flip[0].run_id) await (await import("./github.server")).cancelRun(flip[0].run_id);
      await job.timedOut(rt.status === "running" ? "The runner did not finish in time and was stopped." : "No GitHub runner picked up the task in time.");
      return true;
    }
  }

  if (rt.status === "running" && rt.stage && STAGE_STEP[rt.stage]) {
    const [status, detail] = STAGE_STEP[rt.stage];
    const last = job.steps[job.steps.length - 1];
    if (last?.detail !== detail) { await job.step(status, detail); changed = true; }
  }

  // The runner crashed or was cancelled on GitHub without reporting back.
  if ((rt.status === "dispatched" || rt.status === "running") && rt.run_id && Date.now() - Date.parse(rt.gh_checked_at || rt.dispatched_at) > RUNTIME_LIMITS.githubCheckEveryMs) {
    await d1("UPDATE runtime_jobs SET gh_checked_at = ? WHERE job_id = ?", [now(), rt.job_id]);
    const run = await (await import("./github.server")).getRun(rt.run_id);
    if (run && run.status === "completed" && run.conclusion !== "success") {
      await new Promise((r) => setTimeout(r, 1500)); // let a late completion report land first
      const again = await d1<any>("SELECT status FROM runtime_jobs WHERE job_id = ?", [rt.job_id]);
      if (again[0]?.status === rt.status) {
        await d1("UPDATE runtime_jobs SET status = 'failed', error = ?, session_hash = NULL, updated_at = ? WHERE job_id = ? AND status = ?", [`Runner ${run.conclusion ?? "failed"}`, now(), rt.job_id, rt.status]);
        await job.fail(new Error(run.conclusion === "cancelled" ? "The runner was cancelled." : "The runner failed before reporting a result."));
        return true;
      }
    }
  }

  if (rt.status === "failed") { await job.fail(new Error(rt.error || "Processing failed")); return true; }

  if (rt.status === "uploaded") {
    const claim = await d1("UPDATE runtime_jobs SET status = 'finalizing', updated_at = ? WHERE job_id = ? AND status = 'uploaded' RETURNING job_id", [now(), rt.job_id]);
    if (!claim.length) return changed;
    try { await finalize(job, rt); }
    catch (e) {
      await d1("UPDATE runtime_jobs SET status = 'failed', error = ?, updated_at = ? WHERE job_id = ?", [safeError(e), now(), rt.job_id]);
      await job.fail(e);
    }
    return true;
  }
  // Prove liveness so stale recovery never marks a waiting job as interrupted.
  if (!changed && Date.now() - Date.parse(jobRow.updated_at) > 60_000) await d1("UPDATE jobs SET updated_at = ? WHERE id = ?", [now(), jobRow.id]);
  return changed;
}

async function finalize(job: JobRun, rt: any) {
  await job.step("verifying", "Verifying the result belongs to this task and is intact");
  const result = rt.result ? JSON.parse(rt.result) : null;
  const params = JSON.parse(rt.params || "{}");
  const op = RUNTIME_OPS[rt.operation as RuntimeOpId];
  if (rt.operation === "checksum") {
    if (!result?.sha256 && !result?.sha512) throw new Error("The runner returned no checksum.");
    await d1("UPDATE runtime_jobs SET status = 'completed', updated_at = ? WHERE job_id = ?", [now(), rt.job_id]);
    await job.finish({ operation: rt.operation, fileName: rt.input_name, checksum: result });
    return;
  }
  if (!rt.output_key || !rt.output_chunks) throw new Error("The runner returned no file.");
  if (rt.output_size > op.maxOutput) throw new Error("The converted file is larger than allowed.");
  const { getArtifactBytes, deleteArtifactBytes } = await import("@/lib/jobs/artifact-store.server");
  const cnt = await d1<{ n: number }>("SELECT COUNT(*) AS n FROM artifact_chunks WHERE artifact_key = ?", [rt.output_key]);
  if (cnt[0]?.n !== rt.output_chunks) throw new Error("The converted file arrived incomplete.");
  const bytes = await getArtifactBytes(rt.output_key);
  if (bytes.length !== rt.output_size || (await sha256Hex(bytes)) !== rt.output_sha256) { await deleteArtifactBytes(rt.output_key).catch(() => undefined); throw new Error("The converted file failed its integrity check."); }
  if (!outputMatches(params.target, bytes)) { await deleteArtifactBytes(rt.output_key).catch(() => undefined); throw new Error(`The output is not a valid ${String(params.target).toUpperCase()} file.`); }
  await job.step("saving", "Preparing the download");
  const name = outputName(rt.input_name, params.target);
  await d1("INSERT INTO job_artifacts (id, job_id, user_id, name, mime, size, sha256, drive_file_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'file', ?, ?)",
    [crypto.randomUUID(), job.id, job.userId, name, TARGET_MIME[params.target], bytes.length, rt.output_sha256, rt.output_key, new Date(Date.now() + ARTIFACT_TTL_MS).toISOString(), now()]);
  for (const w of result?.warnings ?? []) job.warn(String(w));
  await d1("UPDATE runtime_jobs SET status = 'completed', updated_at = ? WHERE job_id = ?", [now(), rt.job_id]);
  await job.finish({ operation: rt.operation, fileName: rt.input_name, output: name, details: { ...result, warnings: undefined }, inputSize: rt.input_size, outputSize: bytes.length });
}
