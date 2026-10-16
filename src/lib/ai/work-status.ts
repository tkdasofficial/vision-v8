// The work states shown in chat. Each maps to a real backend operation — never simulated.
import type { JobStatus } from "@/lib/builder/statuses";
import type { TaskStage } from "@/lib/ai/task-events";

/** The only work-state labels a chat reply may show. */
export const WORK_STATES = ["Thinking", "Working", "Reasoning", "Validating", "Creating", "Analyzing", "Searching"] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** Every streamed task stage, folded into one of the seven work states (null = never shown). */
const STAGE_STATE: Record<TaskStage, WorkState | null> = {
  thinking: "Thinking",
  understanding_request: "Thinking",
  analyzing_requirements: "Analyzing",
  reasoning: "Reasoning",
  searching_web: "Searching",
  reading_sources: "Searching",
  gathering_information: "Searching",
  comparing_sources: "Analyzing",
  fact_checking: "Validating",
  extracting_information: "Analyzing",
  processing: "Working",
  analyzing_files: "Analyzing",
  processing_data: "Analyzing",
  calculating: "Working",
  executing_code: "Working",
  running_tests: "Validating",
  generating_file: "Creating",
  converting_file: "Creating",
  reviewing_answer: "Validating",
  verifying_accuracy: "Validating",
  checking_completeness: "Validating",
  validating_requirements: "Validating",
  detecting_issues: "Validating",
  fixing_issues: "Working",
  retrying: "Working",
  building_output: "Creating",
  preparing_output: "Creating",
  finalizing: "Creating",
  switching_provider: null, // backend-only routing
  failed: null,
  cancelled: null,
};

/** Every job status, folded into one of the seven work states (absent = terminal, no work state). */
const JOB_STATE: Partial<Record<JobStatus, WorkState>> = {
  queued: "Thinking",
  dispatched: "Working",
  running: "Working",
  thinking: "Thinking",
  planning: "Analyzing",
  analyzing: "Analyzing",
  inspecting: "Analyzing",
  extracting: "Analyzing",
  scanning: "Analyzing",
  indexing: "Working",
  generating: "Creating",
  writing_files: "Creating",
  setting_up: "Working",
  validating: "Validating",
  running_checks: "Validating",
  debugging: "Working",
  fixing: "Working",
  compressing: "Creating",
  packaging: "Creating",
  verifying: "Validating",
  uploading: "Creating",
  downloading: "Working",
  processing: "Working",
  saving: "Creating",
  retrying: "Working",
  writing_content: "Creating",
  creating_document: "Creating",
  converting_file: "Creating",
  validating_output: "Validating",
  saving_file: "Creating",
};

/** Work state for a streamed task stage; null when it must not appear in the UI. */
export function workStateForStage(stage: TaskStage): WorkState | null {
  return STAGE_STATE[stage] ?? null;
}

/** Work state for a backend job status; null for terminal states (the result is shown instead). */
export function workStateForJob(status: JobStatus): WorkState | null {
  return JOB_STATE[status] ?? null;
}
