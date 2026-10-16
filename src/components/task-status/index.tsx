import { useEffect, useState } from "react";
import { Check, AlertCircle, Loader2 } from "lucide-react";

export default function TaskStatus({ label, detail, startedAt, endedAt, failed = false }: { label: string; detail?: string; startedAt: string | Date; endedAt?: string; failed?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (endedAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [endedAt]);
  const seconds = Math.max(0, Math.round(((endedAt ? Date.parse(endedAt) : now) - new Date(startedAt).getTime()) / 1000));
  return <div role="status" aria-live="polite" className="flex h-16 w-full items-center gap-3 rounded-lg border border-border bg-muted/60 px-3 text-xs">
    {failed ? <AlertCircle className="size-4 shrink-0 text-destructive" /> : endedAt ? <Check className="size-4 shrink-0 text-primary" /> : <Loader2 className="size-4 shrink-0 animate-spin text-primary" />}
    <div className="min-w-0 flex-1"><div className="font-medium text-foreground break-words">{label}</div>{detail && <div className="truncate text-muted-foreground">{detail}</div>}</div>
    <span className="shrink-0 tabular-nums text-muted-foreground">{seconds}s</span>
  </div>;
}