import { useState, useCallback, useEffect, useRef, useMemo, forwardRef } from "react";
import type { ChatMessage as ChatMessageType, DeepStage } from "@/lib/types";
import { Copy, Check, Volume2, VolumeX, ThumbsUp, ThumbsDown, Flag, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import MarkdownReply from "@/components/chat/markdown-reply";
import { useToast } from "@/hooks/use-toast";
import WebAppPreviewCard from "@/components/web-app-preview-card";
import ZipAnalysisCard from "@/components/zip-analysis-card";
import JobCard from "@/components/job-card";
import FileConverterCard from "@/components/file-converter-card";
import FileCreatorCard from "@/components/file-creator-card";
import UserMessage from "@/components/chat/user-message";
import DocumentCard from "@/components/chat/document-card";

type Props = { message: ChatMessageType; isNew?: boolean };

const getMessageSize = (content: string) => {
  if (content.length < 60) return "short";
  if (content.length < 200) return "medium";
  return "long";
};

const proseClasses = [
  "[&_p]:leading-[1.7] [&_p]:mb-2.5",
  "[&_li]:leading-[1.7]",
  "[&_h1]:font-display [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-5 [&_h1]:mb-2",
  "[&_h2]:font-display [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2",
  "[&_h3]:font-display [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5",
  "[&_strong]:text-foreground [&_strong]:font-semibold",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/40 hover:[&_a]:decoration-primary",
  "[&_code]:bg-accent [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded-md [&_code]:text-[13px] [&_code]:font-mono",
  /* pre/code blocks handled by custom CodeBlock component */
  "[&_pre]:my-0",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-[13px]",
  "[&_blockquote]:border-l-[3px] [&_blockquote]:border-foreground/15 [&_blockquote]:pl-4 [&_blockquote]:py-0.5 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-3 [&_blockquote]:bg-accent/50 [&_blockquote]:rounded-r-lg [&_blockquote]:pr-3",
  "[&_ul]:space-y-1.5 [&_ul]:my-2 [&_ul]:pl-1",
  "[&_ol]:space-y-1.5 [&_ol]:my-2 [&_ol]:pl-1",
  "[&_li]:pl-1",
  "[&_hr]:border-border [&_hr]:my-4",
].join(" ");

/* ── Copy button for task card ── */
const CardCopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent/80 bg-accent border border-border transition-colors"
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
};

const NORMAL_CPS = 50;
const TASK_CPS = 180;

/* ── Content splitter ──
   Splits AI content into segments: [text, task, text]
   "task" = the main structured body (story, code, blog, list, etc.)
   Intro/outro are the short plain text before/after.
*/
type Segment = { type: "text" | "task"; content: string };

const splitContent = (raw: string): Segment[] => {
  // Keep every fence and surrounding explanation in one Markdown document.
  // Segment heuristics can otherwise mistake the last lines of a prompt for an outro.
  if (/^\s{0,3}(?:`{3,}|~{3,})/m.test(raw)) return [{ type: "text", content: raw }];
  // A table's separator and rows must remain with its header, even mid-stream.
  if (/^\s*\|?.*\|.*\n\s*\|?\s*:?-{3,}:?\s*\|/m.test(raw)) return [{ type: "text", content: raw }];
  const lines = raw.split("\n");
  const totalLen = raw.length;

  // Short messages → all text, no card
  if (totalLen < 250) return [{ type: "text", content: raw }];

  // Find where "task" body starts: first heading, code fence, numbered list, or bold line after intro
  let taskStart = -1;
  let taskEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (taskStart === -1) {
      // Detect task body start
      if (/^#{1,3}\s/.test(l) || /^```/.test(l) || /^\d+\.\s/.test(l) || /^\*\*[^*]+\*\*/.test(l) || /^[-*]\s/.test(l)) {
        // Only treat as task if there's enough content after
        const remaining = lines.slice(i).join("\n").length;
        if (remaining > 150) {
          taskStart = i;
        }
      }
    }
  }

  // No task body found → plain text
  if (taskStart === -1) return [{ type: "text", content: raw }];

  // Find task end: scan from bottom for a short plain closing paragraph
  for (let i = lines.length - 1; i > taskStart; i--) {
    const l = lines[i].trim();
    if (l === "") continue;
    // If the last non-empty lines are short plain text (no markdown markers), they're the outro
    if (!/^#{1,3}\s/.test(l) && !/^```/.test(l) && !/^\d+\.\s/.test(l) && !/^[-*]\s/.test(l) && !/^\*\*/.test(l) && l.length < 200) {
      // Check if this is truly a closing remark (short paragraph block)
      let outroStart = i;
      // Walk up to find the start of the outro block (consecutive short plain lines)
      for (let j = i - 1; j > taskStart; j--) {
        const lj = lines[j].trim();
        if (lj === "") { outroStart = j + 1; break; }
        if (/^#{1,3}\s/.test(lj) || /^```/.test(lj) || /^\d+\.\s/.test(lj) || /^[-*]\s/.test(lj) || /^\*\*/.test(lj)) {
          outroStart = j + 1;
          break;
        }
        outroStart = j;
      }
      const outroText = lines.slice(outroStart).join("\n").trim();
      if (outroText.length > 0 && outroText.length < 300) {
        taskEnd = outroStart;
      }
      break;
    } else {
      break; // last content is structured → no outro
    }
  }

  const segments: Segment[] = [];
  const preText = lines.slice(0, taskStart).join("\n").trim();
  const taskText = lines.slice(taskStart, taskEnd).join("\n").trim();
  const postText = lines.slice(taskEnd).join("\n").trim();

  if (preText) segments.push({ type: "text", content: preText });
  if (taskText) segments.push({ type: "task", content: taskText });
  if (postText) segments.push({ type: "text", content: postText });

  return segments.length > 0 ? segments : [{ type: "text", content: raw }];
};

/* ── Multi-segment typewriter ──
   Animates segments sequentially: text@50cps → task@200cps → text@50cps
*/
const useSegmentedTypewriter = (segments: Segment[], enabled: boolean) => {
  const [charCounts, setCharCounts] = useState<number[]>(() =>
    enabled ? segments.map(() => 0) : segments.map((s) => s.content.length)
  );
  const [allDone, setAllDone] = useState(!enabled);
  const rafRef = useRef(0);
  const startRef = useRef(0);

  // Precompute timing: each segment starts after the previous finishes
  const timing = useMemo(() => {
    let offset = 0;
    return segments.map((s) => {
      const cps = s.type === "task" ? TASK_CPS : NORMAL_CPS;
      const duration = s.content.length / cps;
      const start = offset;
      offset += duration;
      return { cps, duration, start, len: s.content.length };
    });
  }, [segments]);

  useEffect(() => {
    if (!enabled) {
      setCharCounts(segments.map((s) => s.content.length));
      setAllDone(true);
      return;
    }
    setCharCounts(segments.map(() => 0));
    setAllDone(false);
    startRef.current = performance.now();

    const totalDuration = timing.reduce((a, t) => a + t.duration, 0);

    const animate = (now: number) => {
      const elapsed = (now - startRef.current) / 1000;
      const counts = timing.map((t) => {
        if (elapsed < t.start) return 0;
        const segElapsed = elapsed - t.start;
        return Math.min(Math.floor(segElapsed * t.cps), t.len);
      });
      setCharCounts(counts);
      if (elapsed < totalDuration) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setCharCounts(segments.map((s) => s.content.length));
        setAllDone(true);
      }
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [segments, enabled, timing]);

  return { charCounts, allDone };
};


const ChatMessage = forwardRef<HTMLDivElement, Props>(({ message, isNew = false }, ref) => {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [reported, setReported] = useState(false);
  const { toast } = useToast();
  const mountedRef = useRef(false);

  // Animate on first mount for new AI messages only
  const shouldAnimate = isNew && !isUser && !mountedRef.current;
  useEffect(() => { mountedRef.current = true; }, []);

  const segments = useMemo(() => splitContent(message.content), [message.content]);
  const { charCounts, allDone: typingDone } = useSegmentedTypewriter(segments, shouldAnimate);

  const size = getMessageSize(message.content);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSpeak = useCallback(() => {
    if (speaking) {
      window.speechSynthesis.cancel();
      setSpeaking(false);
      return;
    }
    if (!("speechSynthesis" in window)) {
      toast({ title: "Not supported", description: "Text-to-speech is not supported in this browser.", variant: "destructive" });
      return;
    }
    const plainText = message.content
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/[#*_~>\-|]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\n+/g, ". ")
      .trim();
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [speaking, message.content, toast]);

  const handleFeedback = (type: "up" | "down") => {
    setFeedback(prev => prev === type ? null : type);
    toast({
      title: type === "up" ? "Thanks for the feedback!" : "We'll improve",
      description: type === "up" ? "Glad this was helpful." : "Sorry about that. We'll work on it.",
    });
  };

  const handleReport = () => {
    setReported(true);
    toast({ title: "Reported", description: "This response has been flagged for review." });
  };

  // Find which segment is currently animating (for cursor placement)
  const activeSegIdx = shouldAnimate && !typingDone
    ? charCounts.findIndex((c, i) => c < segments[i].content.length)
    : -1;

  return (
    <div
      ref={ref}
      className={cn(
        "px-3 sm:px-4 md:px-6 w-full max-w-2xl mx-auto transition-all duration-300",
        isUser ? "py-1.5" : "py-3",
        isNew && "animate-fade-in"
      )}
    >
      {isUser ? (
        <div className="flex justify-end">
          <UserMessage message={message} />
        </div>
      ) : (
        <div className="group relative w-full">
          <div className="space-y-3">
            {message.imageUrl && (
              <img
                src={message.imageUrl}
                alt="Generated"
                className="max-w-xs sm:max-w-sm w-full rounded-xl border border-border shadow-sm"
              />
            )}

            {/* Render segments: text → task card → text */}
            {message.document && <DocumentCard id={message.document.id} title={message.document.title} />}
            {message.deep && <DeepReply message={message} />}
            {message.content && !message.deep && !message.document && !(message.job?.type === "code_export" && message.job.status !== "failed") && segments.map((seg, i) => {
              const displayed = seg.content.slice(0, charCounts[i] ?? seg.content.length);
              const isActive = activeSegIdx === i;
              const segVisible = charCounts[i] > 0 || !shouldAnimate;

              if (!segVisible) return null;

              return (
                <div key={i} className="relative w-full will-change-contents">
                  {seg.type === "task" && charCounts[i] >= seg.content.length && (
                    <div className="flex justify-end mb-1"><CardCopyButton content={seg.content} /></div>
                  )}
                  <div className={cn(
                    "prose prose-sm prose-neutral dark:prose-invert max-w-none text-foreground text-[13px] sm:text-sm break-words",
                    proseClasses
                  )}>
                    <MarkdownReply>{displayed}</MarkdownReply>
                    {isActive && <span className="inline-block w-[2px] h-[1em] bg-foreground/70 align-middle animate-pulse ml-0.5" />}
                  </div>
                </div>
              );
            })}

            {message.webApp && (
              <WebAppPreviewCard project={message.webApp} />
            )}
            {message.job && <JobCard job={message.job} />}
            {message.zipAnalysis && (
              <ZipAnalysisCard analysis={message.zipAnalysis} />
            )}
            {message.convertFile && (
              <FileConverterCard file={message.convertFile} />
            )}
            {message.generatedFile && (
              <FileCreatorCard file={message.generatedFile} />
            )}
            {/* Action bar */}
            {message.content && typingDone && (!message.deep || message.deep.stage === "done") && (
              <div className="flex items-center gap-0.5 pt-1">
                <ActionButton onClick={handleSpeak} active={speaking} title={speaking ? "Stop listening" : "Listen"}>
                  {speaking ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
                </ActionButton>
                <ActionButton onClick={handleCopy} active={copied} title="Copy">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </ActionButton>
                <ActionButton onClick={() => handleFeedback("up")} active={feedback === "up"} title="Good response">
                  <ThumbsUp className="w-3.5 h-3.5" />
                </ActionButton>
                <ActionButton onClick={() => handleFeedback("down")} active={feedback === "down"} title="Bad response">
                  <ThumbsDown className="w-3.5 h-3.5" />
                </ActionButton>
                <ActionButton onClick={handleReport} active={reported} disabled={reported} title="Report">
                  <Flag className="w-3.5 h-3.5" />
                </ActionButton>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
ChatMessage.displayName = "ChatMessage";
/** Reusable small icon button for action bar */
const ActionButton = ({
  children,
  onClick,
  active = false,
  disabled = false,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={cn(
      "p-1.5 rounded-lg transition-colors",
      active
        ? "text-foreground bg-accent"
        : "text-muted-foreground hover:text-foreground hover:bg-accent",
      disabled && "opacity-50 cursor-not-allowed"
    )}
  >
    {children}
  </button>
);

/* ── Deep Thinking Mode reply ──
   "Working on it" note → slim full-width status card (live stage + timer) → big title + structured answer. */
const DEEP_LABELS: Record<DeepStage, string> = {
  thinking: "Thinking", analyzing: "Analyzing your request", researching: "Researching", working: "Working on it",
  crafting: "Preparing final response", done: "Done", failed: "Couldn't finish",
  planning: "Preparing execution plan", generating: "Generating individual tasks", verifying: "Verifying results",
  correcting: "Correcting identified issues", validating: "Running final validation",
  retrying: "Retrying", switching_provider: "Working on it",
};

const DeepStatusCard = ({ stage, seconds, since, detail }: { stage: DeepStage; seconds?: number; since: Date; detail?: string }) => {
  const live = stage !== "done" && stage !== "failed";
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!live) return;
    const start = new Date(since).getTime();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [live, since]);
  const secs = live ? elapsed : seconds;
  return (
    <div role="status" aria-live="polite" className="flex h-16 w-full items-center gap-2 rounded-lg border border-border bg-muted/60 px-3 text-xs">
      {live ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        : stage === "done" ? <Check className="size-3.5 shrink-0 text-primary" />
        : <AlertCircle className="size-3.5 shrink-0 text-destructive" />}
      <span key={stage} className="min-w-0 break-words font-medium text-foreground animate-fade-in">
        {DEEP_LABELS[stage]}{live && detail && stage !== "switching_provider" ? ` · ${detail}` : ""}{live ? "…" : stage === "done" && secs ? ` · thought for ${secs}s` : ""}
      </span>
      {live && secs !== undefined && <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{secs}s</span>}
    </div>
  );
};

/** Pulls the leading "# Title" out of the answer so it can be shown large. */
export function splitDeepTitle(content: string): { title: string | null; body: string } {
  const m = content.match(/^\s*#{1,2}\s+(.+?)\s*(?:\n|$)/);
  if (!m) return { title: null, body: content };
  return { title: m[1].replace(/[*_`]/g, "").trim(), body: content.slice(m[0].length).trim() };
}

const deepProse = [
  proseClasses,
  "[&_h2]:text-xl [&_h2]:mt-7 [&_h2]:mb-3 [&_h2]:pb-1.5 [&_h2]:border-b [&_h2]:border-border",
  "[&_h3]:text-base [&_h3]:mt-5 [&_h3]:mb-2",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:marker:text-primary",
  "[&_p]:text-[15px] [&_li]:text-[15px]",
].join(" ");

const DeepReply = ({ message }: { message: ChatMessageType }) => {
  const deep = message.deep;
  if (!deep) return null;
  return <DeepReplyContent message={message} deep={deep} />;
};

const DeepReplyContent = ({ message, deep }: { message: ChatMessageType; deep: NonNullable<ChatMessageType["deep"]> }) => {
  const stage = deep.stage;
  const done = stage === "done" && !!message.content;
  const { title, body } = useMemo(() => splitDeepTitle(message.content || ""), [message.content]);
  return (
    <div className="w-full space-y-3">
      <p className="text-sm text-muted-foreground">
        {done ? "Here's what I worked out." : stage === "failed" ? "I couldn't finish this one." : "I'm working on it — thinking it through and checking the result before I answer."}
      </p>
      <DeepStatusCard stage={stage} seconds={deep.seconds} since={message.timestamp} detail={deep.detail} />
      {(done || stage === "failed") && message.content && (
        <article className="animate-fade-in pt-2">
          {title && <h2 className="font-display text-2xl sm:text-[28px] font-bold leading-tight tracking-tight text-foreground py-4">{title}</h2>}
          <div className={cn("prose prose-neutral dark:prose-invert max-w-none text-foreground break-words", deepProse)}>
            <MarkdownReply>{body}</MarkdownReply>
          </div>
        </article>
      )}
    </div>
  );
};
export default ChatMessage;
