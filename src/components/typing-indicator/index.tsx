import { useState, useEffect, forwardRef } from "react";

export type ThinkingPhase = "thinking" | "creating" | "analyzing" | "working" | "researching" | "fetching" | "writing" | "optimizing";

const PHASE_LABELS: Record<ThinkingPhase, string> = {
  thinking: "Thinking",
  creating: "Creating",
  analyzing: "Analyzing",
  working: "Working",
  fetching: "Fetching webpage",
  researching: "Researching",
  writing: "Writing",
  optimizing: "Optimizing",
};

type Props = {
  phase?: ThinkingPhase;
  /** Real backend stage label (from task events); overrides the local phase. */
  label?: string;
  detail?: string;
  /** Stages already passed, shown as a compact trail. */
  done?: string[];
};

const TypingIndicator = forwardRef<HTMLDivElement, Props>(({ phase = "thinking", label: stageLabel, detail, done }, ref) => {
  const [dots, setDots] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4);
    }, 400);
    return () => clearInterval(interval);
  }, []);

  const label = stageLabel || PHASE_LABELS[phase] || "Thinking";
  const dotStr = ".".repeat(dots);

  return (
    <div ref={ref} role="status" aria-live="polite" className="mx-auto flex h-16 w-full max-w-2xl flex-col justify-center gap-0.5 rounded-lg px-4 animate-fade-in">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <span key={label} className="animate-fade-in">{label}<span className="text-muted-foreground">{dotStr}</span></span>
      </span>
      {(detail || (done && done.length > 0)) && (
        <span className="truncate pl-3.5 text-xs text-muted-foreground">
          {detail || done?.slice(-3).map((s) => s.replace(/_/g, " ")).join(" · ")}
        </span>
      )}
    </div>
  );
});

TypingIndicator.displayName = "TypingIndicator";

export default TypingIndicator;

export function detectPhase(content: string, toolId?: string): ThinkingPhase {
  const lower = content.toLowerCase();
  
  if (/\b(analy[sz]e|review|evaluate|assess|compare)\b/.test(lower)) {
    return "analyzing";
  }
  if (/\b(research|find|search|look up|discover)\b/.test(lower)) {
    return "researching";
  }
  if (/\b(write|script|draft|compose|blog|article|story)\b/.test(lower)) {
    return "writing";
  }
  if (/\b(optimi[sz]e|seo|improve|enhance|boost)\b/.test(lower)) {
    return "optimizing";
  }
  
  if (toolId === "script-writer") return "writing";
  if (toolId === "seo-optimizer") return "optimizing";
  if (toolId === "content-optimizer") return "optimizing";
  if (toolId === "content-analyzer") return "analyzing";
  
  return "thinking";
}
