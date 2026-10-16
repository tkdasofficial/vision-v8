import { describe, it, expect } from "vitest";
import { WORK_STATES, workStateForJob, workStateForStage } from "@/lib/ai/work-status";
import { STAGE_LABELS, type TaskStage } from "@/lib/ai/task-events";
import { JOB_STATUSES, isTerminal, type JobStatus } from "@/lib/builder/statuses";

describe("chat work states", () => {
  it("shows only the seven agreed work states", () => {
    expect([...WORK_STATES]).toEqual(["Thinking", "Working", "Reasoning", "Validating", "Creating", "Analyzing", "Searching"]);
  });

  it("folds every streamed task stage into one of them, and hides provider switching", () => {
    const states = new Set<string>();
    for (const stage of Object.keys(STAGE_LABELS) as TaskStage[]) {
      const state = workStateForStage(stage);
      if (state) {
        expect(WORK_STATES).toContain(state);
        states.add(state);
      }
    }
    expect(workStateForStage("switching_provider")).toBeNull();
    expect(workStateForStage("thinking")).toBe("Thinking");
    expect(workStateForStage("searching_web")).toBe("Searching");
    expect(workStateForStage("validating_requirements")).toBe("Validating");
    expect(workStateForStage("generating_file")).toBe("Creating");
    expect([...states].every((s) => (WORK_STATES as readonly string[]).includes(s))).toBe(true);
  });

  it("maps document creation, validation and saving to the work states the user sees", () => {
    expect(workStateForJob("thinking")).toBe("Thinking");
    expect(workStateForJob("writing_content")).toBe("Creating");
    expect(workStateForJob("creating_document")).toBe("Creating");
    expect(workStateForJob("converting_file")).toBe("Creating");
    expect(workStateForJob("validating_output")).toBe("Validating");
    expect(workStateForJob("saving_file")).toBe("Creating");
  });

  it("never shows a work state for provider switching or a finished job", () => {
    expect(workStateForJob("switching_provider")).toBeNull();
    const terminal = (Object.keys(JOB_STATUSES) as JobStatus[]).filter(isTerminal);
    expect(terminal.length).toBeGreaterThan(0);
    for (const status of terminal) expect(workStateForJob(status)).toBeNull();
  });
});
