// Sequential text orchestration. Side effects (files, checkpoints) run only after this returns.
import { TEXT_CHAIN, type ModelRef } from "./models.server";
import { streamFromProvider, failureCategory, type ProviderResult } from "./providers.server";
import { collectStream } from "./deep/sse";
import { AI_LIMITS } from "./limits";

export const ALL_PROVIDERS_UNAVAILABLE = "All AI providers are currently unavailable. Please try again shortly.";
export type ProviderEvent = { stage: "retrying" | "switching_provider"; provider: string; model: string; category?: string };
export type ProviderPolicy = "fallback" | "input" | "cancelled";
export function providerPolicy(status: number, reason: string): ProviderPolicy {
  if (status === 499) return "cancelled";
  if (status === 400 || status === 413 || status === 422) return "input";
  // A provider credential failure is not an app-user authorization failure (checked before calling here).
  if (status === 403 && /content.?policy|safety|refusal/i.test(reason)) return "input";
  return "fallback";
}
export type Completion = { ok: true; text: string; finishReason: string | null; model: ModelRef } | { ok: false; status: number; reason: string };

export async function orchestrateText(messages: unknown[], opts: {
  maxTokens: number; deep: boolean; signal: AbortSignal; models?: ModelRef[]; taskId?: string;
  deadlineAt?: number; onEvent?: (event: ProviderEvent) => void | Promise<void>;
  call?: (model: ModelRef, messages: unknown[], opts: { maxTokens: number; deep: boolean; deadlineAt?: number; onEvent?: (event: ProviderEvent) => void | Promise<void> }, signal: AbortSignal) => Promise<ProviderResult>;
}): Promise<Completion> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + AI_LIMITS.providerChainMs;
  const models = opts.models ?? TEXT_CHAIN;
  const call = opts.call ?? streamFromProvider;
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    if (opts.signal.aborted) return { ok: false, status: 499, reason: "Request cancelled." };
    if (Date.now() >= deadlineAt) break;
    if (i > 0) await opts.onEvent?.({ stage: "switching_provider", provider: model.provider, model: model.label });
    const started = Date.now();
    let status = 502;
    let category = "empty_or_interrupted_stream";
    const result = await call(model, messages, { maxTokens: opts.maxTokens, deep: opts.deep, deadlineAt, onEvent: opts.onEvent }, opts.signal);
    if (result.ok) {
      try {
        const output = await collectStream(result.body);
        const text = output.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (text) {
          console.log(JSON.stringify({ tag: "[ai:orchestration]", taskId: opts.taskId, provider: model.provider, model: model.model, attempt: i + 1, outcome: "success", ms: Date.now() - started }));
          return { ok: true, text, finishReason: output.finishReason, model };
        }
      } catch { /* No partial answer escapes; switching cannot duplicate output. */ }
    } else {
      status = result.status;
      category = failureCategory(status, result.reason);
      const policy = providerPolicy(status, result.reason);
      if (policy !== "fallback") return { ok: false, status, reason: policy === "cancelled" ? "Request cancelled." : "The AI request is invalid or unsupported. Please check the input and required format." };
    }
    console.log(JSON.stringify({ tag: "[ai:orchestration]", taskId: opts.taskId, provider: model.provider, model: model.model, attempt: i + 1, outcome: "fallback", status, category, ms: Date.now() - started }));
  }
  console.log(JSON.stringify({ tag: "[ai:orchestration]", taskId: opts.taskId, outcome: "exhausted" }));
  return { ok: false, status: 503, reason: ALL_PROVIDERS_UNAVAILABLE };
}