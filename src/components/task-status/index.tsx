import { useEffect, useState } from "react";

/**
 * Work-state line: plain text only — no card, no border, no background, no leading icon.
 * The label always comes from a real backend status; the seconds are real elapsed time.
 */
export default function TaskStatus({ label, startedAt, endedAt, failed = false, cancelled = false }: {
  label: string;
  startedAt: string | Date;
  endedAt?: string;
  failed?: boolean;
  cancelled?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [endedAt]);
  const seconds = Math.max(0, Math.round(((endedAt ? Date.parse(endedAt) : now) - new Date(startedAt).getTime()) / 1000));
  const text = failed ? "Couldn't finish" : cancelled ? "Cancelled" : `${label}…`;
  return (
    <div role="status" aria-live="polite" className="flex w-full items-baseline gap-2 py-1 text-sm text-muted-foreground">
      <span key={label} className="min-w-0 break-words animate-fade-in">{text}</span>
      <span className="shrink-0 tabular-nums opacity-70">{seconds}s</span>
    </div>
  );
}
