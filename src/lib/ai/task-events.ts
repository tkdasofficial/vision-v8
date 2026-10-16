// Typed task-lifecycle events streamed from /api/chat (`vision_task` SSE lines). Pure and browser-safe.

export type TaskStage =
  | "thinking" | "understanding_request" | "analyzing_requirements" | "reasoning"
  | "searching_web" | "reading_sources" | "gathering_information" | "comparing_sources" | "fact_checking" | "extracting_information"
  | "processing" | "analyzing_files" | "processing_data" | "calculating" | "executing_code" | "running_tests" | "generating_file" | "converting_file"
  | "reviewing_answer" | "verifying_accuracy" | "checking_completeness" | "validating_requirements" | "detecting_issues" | "fixing_issues" | "retrying"
  | "building_output" | "preparing_output" | "finalizing" | "failed" | "cancelled";

/** The standard catalogue (30). Available labels, not a sequence: the server emits only those it actually performs. */
export const STAGE_LABELS: Record<TaskStage, string> = {
  thinking: "Thinking", understanding_request: "Understanding Request", analyzing_requirements: "Analyzing Requirements", reasoning: "Reasoning",
  searching_web: "Searching the Web", reading_sources: "Reading Sources", gathering_information: "Gathering Information", comparing_sources: "Comparing Sources", fact_checking: "Fact-Checking", extracting_information: "Extracting Information",
  processing: "Processing", analyzing_files: "Analyzing Files", processing_data: "Processing Data", calculating: "Calculating", executing_code: "Executing Code", running_tests: "Running Tests", generating_file: "Generating File", converting_file: "Converting File",
  reviewing_answer: "Reviewing Answer", verifying_accuracy: "Verifying Accuracy", checking_completeness: "Checking Completeness", validating_requirements: "Validating Requirements", detecting_issues: "Detecting Issues", fixing_issues: "Fixing Issues", retrying: "Retrying",
  building_output: "Building Output", preparing_output: "Preparing Output", finalizing: "Finalizing", failed: "Failed", cancelled: "Cancelled",
};

export type TaskEvent = { taskId: string; seq: number; stage: TaskStage; message?: string; ts: number; meta?: Record<string, number | string> };
export type TaskState = { taskId: string; seq: number; stage: TaskStage; message?: string; history: TaskStage[] };

const STAGES = new Set(Object.keys(STAGE_LABELS));
/** Successful tasks end at "finalizing" (the answer follows directly; no completion status exists). */
export const isTerminalStage = (s: TaskStage) => s === "failed" || s === "cancelled";

/** Validates an untrusted event; malformed events return null. */
export function parseTaskEvent(raw: unknown): TaskEvent | null {
  const e = raw as any;
  if (!e || typeof e.taskId !== "string" || !Number.isInteger(e.seq) || !STAGES.has(e.stage)) return null;
  return { taskId: e.taskId, seq: e.seq, stage: e.stage, message: typeof e.message === "string" ? e.message.slice(0, 160) : undefined, ts: Number(e.ts) || Date.now(), meta: e.meta && typeof e.meta === "object" ? e.meta : undefined };
}

/** Applies an event in order: other tasks, duplicates, out-of-order events and anything after a terminal stage are ignored. */
export function applyTaskEvent(state: TaskState | null, ev: TaskEvent, activeTaskId?: string): TaskState | null {
  if (activeTaskId && ev.taskId !== activeTaskId) return state;
  if (state && state.taskId === ev.taskId) {
    if (ev.seq <= state.seq || isTerminalStage(state.stage)) return state;
    const history = state.history[state.history.length - 1] === ev.stage ? state.history : [...state.history, ev.stage];
    return { taskId: ev.taskId, seq: ev.seq, stage: ev.stage, message: ev.message, history };
  }
  return { taskId: ev.taskId, seq: ev.seq, stage: ev.stage, message: ev.message, history: [ev.stage] };
}

/** Server-side emitter: numbers events per task so the client can order and de-duplicate them. */
export function taskEmitter(taskId: string, send: (line: string) => void) {
  let seq = 0;
  return (stage: TaskStage, message?: string, meta?: TaskEvent["meta"]) => {
    const ev: TaskEvent = { taskId, seq: ++seq, stage, message, ts: Date.now(), ...(meta ? { meta } : {}) };
    send(`data: ${JSON.stringify({ vision_task: ev })}\n\n`);
  };
}

/** Requests that depend on current or changing facts get a live search automatically (in "auto" search mode). */
export function needsLiveFacts(text: string): boolean {
  return /\b(latest|today'?s?|right now|currently|this (week|month|year)|recent(ly)?|news|breaking|price of|stock price|exchange rate|weather|score|election|20(2[5-9]|3\d))\b/i.test(text);
}
