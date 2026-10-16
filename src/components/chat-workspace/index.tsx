import { useState, useRef, useEffect, useCallback } from "react";
import { Crown, Menu } from "lucide-react";
import { IncognitoIcon } from "@/components/icons/incognito-icon";
import { useNavigate } from "@/lib/router-compat";
import ChatActionsMenu from "@/components/chat-actions-menu";
import ProjectChatHeader from "@/components/project-chat-header";
import { takePendingProjectPrompt } from "@/lib/pending-project";
import AnnouncementBanner from "@/components/announcement-banner";

import type { AITool, ChatMessage as ChatMessageType, DeepStage, MessageAttachment, PastedBlock } from "@/lib/types";
import { routeRequest } from "@/lib/ai/request-route";
import { resolveReference, sourceBlock } from "@/lib/ai/references";
import { planPluginSend, PLUGIN_BY_ID } from "@/lib/plugins/manifest";
const tagged = (ids: string[] | undefined, text: string) => [...(ids ?? []).map((i) => `@${PLUGIN_BY_ID.get(i)?.name ?? i}`), text].filter(Boolean).join(" ");
import { Button } from "@/components/ui/button";
import { useChatHistory } from "@/context/ChatHistoryContext";
import ChatInput from "@/components/chat-input";
import ChatMessage from "@/components/chat-message";
import EmptyState from "@/components/empty-state";
import TypingIndicator, { detectPhase, type ThinkingPhase } from "@/components/typing-indicator";
import { applyTaskEvent, STAGE_LABELS, type TaskState } from "@/lib/ai/task-events";
import { revealPlan } from "@/lib/ai/render-scheduler";
import { getCategory } from "@/lib/file-converter";
import { runJob, listJobs, fetchJob, cancelJob } from "@/lib/builder/jobs-client";
import { isTerminal } from "@/lib/builder/statuses";
import type { ChatMode } from "@/lib/ai/modes";
import { saveDocumentFn } from "@/lib/cloud/documents.functions";
import { useBackgroundTasks, type BackgroundTask } from "@/hooks/useBackgroundTasks";
import { supabase } from "@/lib/cloud/client";
import { streamChat } from "@/lib/cloud/chat-stream";
import { useAuth } from "@/context/AuthContext";
import { readCachedPrefs } from "@/lib/settings";
import { adoptDraftMode, browserStore, loadChatMode, saveChatMode } from "@/lib/chat-mode-store";

type Props = {
  tool?: AITool;
  onMenuClick: () => void;
  initialMessages?: ChatMessageType[];
  chatId?: string;
  projectId?: string;
  onChatCreated?: (id: string) => void;
  isIncognito?: boolean;
  onIncognitoChat: () => void;
};

// Deep Thinking Mode status card cycles through these while the answer is prepared.
const DEEP_STAGES = ["thinking", "analyzing", "researching", "working", "crafting"] as const;

const ChatWorkspace = ({ tool, onMenuClick, initialMessages, chatId: externalChatId, projectId: draftProjectId, onChatCreated, isIncognito = false, onIncognitoChat }: Props) => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessageType[]>(initialMessages || []);
  const [isTyping, setIsTyping] = useState(false);
  // Anything in flight that the send button can stop: a streaming reply and/or backend tasks of this chat.
  const [streaming, setStreaming] = useState(false);
  const [activeJobs, setActiveJobs] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const trackJob = useCallback((id: string, running: boolean) => setActiveJobs((cur) => {
    if (cur.has(id) === running) return cur;
    const next = new Set(cur); running ? next.add(id) : next.delete(id); return next;
  }), []);
  const initialMsgCount = useRef((initialMessages || []).length);
  const [thinkingPhase, setThinkingPhase] = useState<ThinkingPhase>("thinking");
  const [taskState, setTaskState] = useState<TaskState | null>(null);
  const [chatId, setChatId] = useState<string | null>(externalChatId || null);
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  // Mode belongs to the conversation: restored on open/reload, never reset after a reply.
  // Incognito keeps it in memory only.
  const [mode, setModeState] = useState<ChatMode>("default");
  const modeLoadedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (modeLoadedFor.current === chatId) return;
    modeLoadedFor.current = chatId;
    if (isIncognito) { if (chatId === null) setModeState(readCachedPrefs().defaultMode); return; }
    setModeState(loadChatMode(browserStore(), chatId) ?? readCachedPrefs().defaultMode);
  }, [chatId, isIncognito]);
  const setMode = useCallback((m: ChatMode) => {
    setModeState(m);
    if (!isIncognito) saveChatMode(browserStore(), chatId, m);
  }, [chatId, isIncognito]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { addChat, updateChatMessages, getChatById } = useChatHistory();
  const projectId = chatId ? getChatById(chatId)?.projectId : draftProjectId;
  const { tasks: bgTasks, activeTasks, dispatch: dispatchBgTask } = useBackgroundTasks(chatId);
  const { user } = useAuth();
  const [newMessageIds, setNewMessageIds] = useState<Set<string>>(new Set());

  // Track message IDs we've already seen to detect new ones
  const knownIdsRef = useRef<Set<string>>(new Set((initialMessages || []).map(m => m.id)));

  // Whenever messages change, mark any new assistant messages for typewriter animation
  useEffect(() => {
    const newAssistantIds: string[] = [];
    for (const msg of messages) {
      if (!knownIdsRef.current.has(msg.id)) {
        knownIdsRef.current.add(msg.id);
        if (msg.role === "assistant") {
          newAssistantIds.push(msg.id);
        }
      }
    }
    if (newAssistantIds.length > 0) {
      setNewMessageIds((prev) => {
        const next = new Set(prev);
        newAssistantIds.forEach(id => next.add(id));
        return next;
      });
    }
  }, [messages]);

  // Handle background task completion — inject result as assistant message
  const handleBgTaskResult = useCallback((task: BackgroundTask) => {
    if (!task.result) return;
    const r = task.result;
    const msgBase = { id: `bg-${task.id}`, role: "assistant" as const, timestamp: new Date() };

    if (r.type === "chat") {
      setMessages((prev) => [...prev, { ...msgBase, content: r.content }]);
    } else if (r.type === "code") {
      setMessages((prev) => [...prev, {
        ...msgBase,
        content: r.explanation || "Here's your generated web application!",
        webApp: { files: r.files, framework: r.framework, dependencies: r.dependencies || {}, entryPoint: r.entryPoint || "index.html", explanation: r.explanation || "", quality: "production" },
      }]);
    } else if (r.type === "file") {
      setMessages((prev) => [...prev, {
        ...msgBase,
        content: r.explanation || `Here's your generated file:`,
        generatedFile: { fileName: r.fileName, content: r.content, mimeType: r.mimeType, format: r.format },
      }]);
    }
  }, []);

  // On mount: recover any completed background tasks that have no corresponding message
  useEffect(() => {
    if (isIncognito) return;
    for (const task of bgTasks) {
      if (task.status === "done" && task.result) {
        const hasBgMsg = messages.some((m) => m.id === `bg-${task.id}`);
        if (!hasBgMsg) handleBgTaskResult(task);
      }
    }
  }, [bgTasks, isIncognito]);

  // Reply still being finished on the server (page was left or reloaded mid-answer): show typing and
  // poll the saved chat until the background worker stores the answer (up to 15 minutes after the question).
  useEffect(() => {
    if (isIncognito || !chatId || !initialMessages?.length) return;
    const last = initialMessages[initialMessages.length - 1];
    const sentAt = new Date(last.timestamp as any).getTime();
    if (last.role !== "user" || !sentAt || Date.now() - sentAt > 15 * 60_000) return;
    let stop = false;
    setIsTyping(true);
    const tick = async () => {
      if (stop) return;
      const { data } = await supabase.from("chat_messages").select("*").eq("session_id", chatId).eq("role", "assistant").gt("created_at", new Date(sentAt - 1000).toISOString()).order("created_at", { ascending: true }).limit(1);
      const row: any = data?.[0];
      if (row && !stop) {
        stop = true; setIsTyping(false);
        setMessages((prev) => prev.some((m) => m.id === row.id) ? prev : [...prev, { id: row.id, role: "assistant", content: row.content || "", timestamp: new Date(row.created_at), toolId: row.metadata?.toolId }]);
        setNewMessageIds((prev) => new Set(prev).add(row.id));
        return;
      }
      if (Date.now() - sentAt > 15 * 60_000) { stop = true; setIsTyping(false); return; }
      timer = window.setTimeout(tick, 4000);
    };
    let timer = window.setTimeout(tick, 500);
    return () => { stop = true; clearTimeout(timer); };
  }, [chatId, initialMessages, isIncognito]);

  // Set title from initial messages when loading an existing chat
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0 && !chatTitle) {
      const firstUser = initialMessages.find((m) => m.role === "user");
      if (firstUser) {
        const raw = firstUser.content.length > 100 ? firstUser.content.slice(0, 100) : firstUser.content;
        setChatTitle(raw.length > 40 ? raw.slice(0, 40) + "..." : raw);
      }
    }
  }, [initialMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, isTyping]);

  // Persist messages to history whenever they change
  useEffect(() => {
    if (!isIncognito && chatId && messages.length > 0) {
      updateChatMessages(chatId, messages);
    }
  }, [messages, chatId, updateChatMessages, isIncognito]);

  // Subscribe to new messages from Supabase Realtime
  useEffect(() => {
    if (isIncognito || !chatId || !user) return;

    const channel = supabase
      .channel(`chat:${chatId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `session_id=eq.${chatId}`,
        },
        (payload) => {
          const newMsg = payload.new as any;
          // Only add AI messages (user messages are added immediately in handleSend)
          if (newMsg.role === "assistant") {
            const chatMsg: ChatMessageType = {
              id: newMsg.id,
              role: "assistant",
              content: newMsg.content || "",
              timestamp: new Date(newMsg.created_at),
              imageUrl: newMsg.image_url || undefined,
              toolId: newMsg.metadata?.toolId,
            };
            setMessages((prev) => {
              // Avoid duplicates
              if (prev.some((m) => m.id === chatMsg.id)) return prev;
              return [...prev, chatMsg];
            });
            setNewMessageIds((prev) => new Set(prev).add(newMsg.id));
            setIsTyping(false);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [chatId, user, isIncognito]);

  /** Runs a backend job and keeps one assistant message in this chat updated with its live status. */
  const runInlineJob = useCallback(async (type: "project_generate" | "code_export" | "agent_task", input: Record<string, unknown>, sessionId: string | null, files?: File[]) => {
    const jobId = crypto.randomUUID();
    const msgId = `job-${jobId}`;
    const intro = type === "project_generate" ? "Building your project. Progress, files and the ZIP download will appear here." : type === "agent_task" ? "Working on it. Each step, its results and any downloads will appear here." : "Writing your file. The download will appear here.";
    trackJob(jobId, true);
    const show = (job: import("@/lib/builder/statuses").JobView) => setMessages((prev) => {
      const content = job.status === "failed" || job.status === "timed_out" ? `That didn't work: ${job.error ?? "unknown error"}` : job.status === "cancelled" ? "Task cancelled." : intro;
      const msg: ChatMessageType = { id: msgId, role: "assistant", content, timestamp: new Date(), job };
      return prev.some((m) => m.id === msgId) ? prev.map((m) => (m.id === msgId ? msg : m)) : [...prev, msg];
    });
    try { await runJob(type, files ? { files, prompt: String(input.prompt ?? ""), sessionId } : { input, sessionId }, show, jobId); }
    catch (e: any) { trackJob(jobId, false); setMessages((prev) => [...prev.filter((m) => m.id !== msgId), { id: msgId, role: "assistant", content: `Sorry, that task couldn't start: ${e.message}`, timestamp: new Date() }]); }
  }, [trackJob]);

  // Restore this conversation's backend tasks (after a refresh or when the chat gets its own address).
  useEffect(() => {
    if (isIncognito || !chatId) return;
    let cancelled = false;
    listJobs(chatId).then((jobs) => {
      if (cancelled || !jobs.length) return;
      for (const j of jobs) if (!isTerminal(j.status)) trackJob(j.id, true);
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.job?.id).filter(Boolean));
        const missing = jobs.filter((j) => !have.has(j.id)).map((j): ChatMessageType => ({
          id: `job-${j.id}`, role: "assistant", timestamp: new Date(j.createdAt), job: j,
          content: j.status === "failed" || j.status === "timed_out" ? `That didn't work: ${j.error ?? "unknown error"}` : j.type === "zip_analyze" ? `Analysis of **${j.result?.fileName ?? "your ZIP"}**` : j.type === "project_generate" ? "Here's your project." : j.type === "agent_task" || j.type === "runtime_task" ? "Here's the result." : "Here's your file.",
        }));
        if (!missing.length) return prev;
        // A task starts the instant its question is sent, but older chats saved the question a moment later
        // (after a short save delay), so a task may look slightly older than its own question.
        // Place each task after the question that triggered it: allow a few seconds of slack.
        const SLACK = 8000;
        const key = (m: ChatMessageType) => new Date(m.timestamp).getTime() + (m.job ? SLACK : 0);
        return [...prev, ...missing].map((m, i) => ({ m, i })).sort((a, b) => key(a.m) - key(b.m) || a.i - b.i).map((x) => x.m);
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [chatId, isIncognito, trackJob]);

  // Follow running tasks so the send button knows when everything has finished.
  useEffect(() => {
    if (!activeJobs.size) return;
    const t = window.setInterval(() => {
      for (const id of activeJobs) fetchJob(id).then((j) => { if (!j || isTerminal(j.status)) trackJob(id, false); }).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(t);
  }, [activeJobs, trackJob]);

  /** Stops whatever is running: the streaming reply and every running task in this chat. */
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setIsTyping(false);
    for (const id of activeJobs) cancelJob(id).catch(() => undefined).finally(() => trackJob(id, false));
  }, [activeJobs, trackJob]);

  const handleSend = useCallback(async (content: string, imageData?: { base64: string; mimeType: string }, taskMode?: ChatMode, extras?: { typed: string; pasted: PastedBlock[] }, plugins?: string[]) => {
    const plan = plugins?.length ? planPluginSend(plugins, content, []) : null;
    const forceSearch = plan?.kind === "chat" && plan.webSearch;
    const userMsg: ChatMessageType = {
      id: Date.now().toString(),
      role: "user",
      content: plan ? tagged(plugins, content) : content,
      timestamp: new Date(),
      toolId: tool?.id,
      imageUrl: imageData ? `data:${imageData.mimeType};base64,${imageData.base64}` : undefined,
      ...(extras?.pasted.length ? { pasted: extras.pasted, typed: extras.typed } : {}),
    };
    setMessages((prev) => [...prev, userMsg]);
    if (plan?.kind === "reply" || (plan?.kind === "agent" && isIncognito)) {
      const text = plan.kind === "reply" ? plan.text : "Plugins that run tasks aren't available in private chats.";
      setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: text, timestamp: new Date() }]);
      return;
    }

    // Private chats get real AI replies but never create saved rows or background jobs.
    if (isIncognito) {
      setIsTyping(true);
      const history = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }));
      try {
        const reply = await streamChat(history, () => {}, tool?.id, { mode: taskMode, webSearch: forceSearch });
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: reply || "I couldn't come up with an answer.", timestamp: new Date() }]);
      } catch (e: any) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: `Sorry, an error occurred: ${e.message}`, timestamp: new Date() }]);
      }
      setIsTyping(false);
      return;
    }

    // Detect phase from content
    const phase = detectPhase(content, tool?.id);
    setThinkingPhase("thinking"); // Always start with thinking
    setTaskState(null);
    setIsTyping(true);

    // Save first message as chat history entry
    let sessionId = chatId;
    if (!chatId) {
      const rawTitle = content.length > 100 ? content.slice(0, 100) : content;
      const title = rawTitle.length > 40 ? rawTitle.slice(0, 40) + "..." : rawTitle;
      const newId = addChat(title, content, tool?.id, draftProjectId);
      if (!isIncognito) adoptDraftMode(browserStore(), newId, taskMode ?? mode);
      sessionId = newId;
      setChatId(newId);
      setChatTitle(title);
      onChatCreated?.(newId);
    }

    // Transition from "thinking" to the detected work phase after a delay
    // Statuses come only from real backend events; no timer-driven phases.
    void phase;
    const phaseTimer: number | undefined = undefined;
    let fetchPhaseTimer: number | undefined;
    let researchPhaseTimer: number | undefined;

    const clearPhaseTimers = () => {
      clearTimeout(phaseTimer);
      if (fetchPhaseTimer) clearTimeout(fetchPhaseTimer);
      if (researchPhaseTimer) clearTimeout(researchPhaseTimer);
    };

    // Explicit tools, files and projects run as backend jobs; everything else is a written answer.
    if (plan?.kind === "agent") {
      clearPhaseTimers(); setIsTyping(false);
      await runInlineJob("agent_task", { prompt: plan.prompt }, sessionId);
      return;
    }
    const route = plan ? ({ kind: "chat" } as const) : routeRequest(content, taskMode ?? "default");
    if (route.kind !== "chat") {
      clearPhaseTimers();
      setIsTyping(false);
      // Content-dependent actions run on the real referenced message, never on the reference phrase.
      const ref = resolveReference(content, messages.map((m) => ({ id: m.id, role: m.role, content: m.content })));
      if (ref.kind === "missing" || ref.kind === "ambiguous") {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: ref.kind === "missing" ? `I couldn't find ${ref.label}. ${ref.reason}` : ref.question, timestamp: new Date() }]);
        return;
      }
      const src = ref.kind === "found" ? `\n\n${sourceBlock(ref)}` : "";
      if (route.kind === "tool") await runInlineJob("agent_task", { prompt: content + src }, sessionId);
      else if (route.kind === "project") await runInlineJob("project_generate", { prompt: content + src }, sessionId);
      else if (route.kind === "code_export") await runInlineJob("code_export", { prompt: content + src, language: route.language }, sessionId);
      else await runInlineJob("agent_task", { prompt: `${content}${src}\n\n(Save the result as a .${route.format} file.)` }, sessionId);
      return;
    }

    // Website analysis detection — user pasted a URL to analyze
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/i;
    const hasUrl = urlPattern.test(content);
    const isWebAnalysis = hasUrl && (
      /\b(analy[sz]e|check|review|inspect|scan|audit|examine|tell\s*me\s*about|what\s*is|details?\s*(about|of|on)|info(rmation)?\s*(about|of|on)|describe|explain|overview|look\s*at|visit|open|show\s*me|about\s*this|what.*website|website.*what)\b/i.test(content)
      || content.replace(urlPattern, "").trim().length < 30
    );

    if (isWebAnalysis) {
      clearTimeout(phaseTimer);

    }

    // Regular chat - send to backend, response will come via Realtime
    try {
      const chatMessages = messages
        .filter((m) => !m.imageUrl || m.role === "user")
        .map((m) => {
          if (m.imageUrl && m.role === "user") {
            return {
              role: "user",
              content: [
                { type: "text", text: m.content },
                { type: "image_url", image_url: { url: m.imageUrl } },
              ],
            };
          }
          return { role: m.role, content: m.content };
        });

      if (imageData) {
        chatMessages.push({
          role: "user",
          content: [
            { type: "text", text: content },
            { type: "image_url", image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } },
          ],
        });
      } else {
        chatMessages.push({ role: "user", content });
      }

      const replyId = crypto.randomUUID();
      let started = false;
      // Deep Thinking: think first, then a "working on it" note with a live status card; the answer appears when ready.
      const deep = taskMode === "deep";
      const deepStart = Date.now();
      let deepTokens = false;
      const setDeepStage = (stage: DeepStage, detail?: string) => setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, deep: { stage, detail } } : m)));
      let deepReal = false; let lastDeep: { stage: DeepStage; detail?: string } = { stage: "analyzing" }; // once the server reports real stages, the placeholder ticker stops
      const STATUS_MAP: Record<string, DeepStage> = { analyzing: "analyzing", planning: "planning", generating: "generating", verifying: "verifying", correcting: "correcting", validating: "validating", assembling: "crafting", retrying: "retrying", switching_provider: "switching_provider", failed: "failed" };
      let deepTicker: number | undefined;
      const deepShow = deep ? window.setTimeout(() => {
        clearTimeout(phaseTimer); setIsTyping(false);
        setMessages((prev) => prev.some((m) => m.id === replyId) ? prev : [...prev, { id: replyId, role: "assistant", content: "", timestamp: new Date(), toolId: tool?.id, executionMode: "deep", deep: lastDeep }]);
      }, 1400) : undefined;
      const stopDeepTimers = () => { if (deepShow) clearTimeout(deepShow); if (deepTicker) clearInterval(deepTicker); };
      let taskRef: TaskState | null = null;
      let meta: { executionMode: string; output: string } = { executionMode: "default", output: "chat" };
      const ctrl = new AbortController();
      abortRef.current = ctrl; setStreaming(true);
      const finalText = await streamChat(chatMessages, (full) => {
        const visible = full.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trimStart();
        if (!visible) return;
        if (deep) {
          if (!deepTokens) { deepTokens = true; if (!deepReal) setDeepStage("crafting"); }
          return; // the finished answer is shown in one piece
        }
        if (!started) { started = true; clearTimeout(phaseTimer); }
        return; // gated: the validated answer is revealed progressively once the task completes
        setMessages((prev) => prev.some((m) => m.id === replyId)
          ? prev.map((m) => (m.id === replyId ? { ...m, content: visible } : m))
          : [...prev, { id: replyId, role: "assistant", content: visible, timestamp: new Date(), toolId: tool?.id }]);
      }, tool?.id, { mode: taskMode, webSearch: forceSearch, onMeta: (m) => { meta = m; }, signal: ctrl.signal, requestId: replyId, conversationId: chatId ?? undefined,
        onTask: (ev) => { taskRef = applyTaskEvent(taskRef, ev, replyId); setTaskState(taskRef); },
        onStatus: (st, detail) => { const ds = STATUS_MAP[st]; if (!deep || !ds) return; deepReal = true; lastDeep = { stage: ds, detail }; setMessages((prev) => prev.some((m) => m.id === replyId) ? prev.map((m) => (m.id === replyId ? { ...m, deep: { stage: ds, detail } } : m)) : prev); } }).finally(() => { stopDeepTimers(); if (abortRef.current === ctrl) abortRef.current = null; setStreaming(false); });
      const stopped = ctrl.signal.aborted;
      const replyText = finalText || (stopped ? "Stopped." : "I couldn't come up with an answer. Please try again.");
      let reply: ChatMessageType = { id: replyId, role: "assistant", content: replyText, timestamp: new Date(), toolId: tool?.id, executionMode: deep ? "deep" : meta.executionMode,
        ...(deep ? { deep: { stage: finalText && lastDeep.stage !== "failed" ? "done" : "failed", seconds: Math.max(1, Math.round((Date.now() - deepStart) / 1000)) } as const } : {}) };
      // Research reports become a saved document shown as a compact card (saved once per reply).
      if (meta.output === "document" && finalText) {
        try {
          const title = finalText.match(/^#\s+(.+)$/m)?.[1]?.trim() || content.slice(0, 80);
          reply = { ...reply, document: await saveDocumentFn({ data: { title, content: finalText } }) };
        } catch { /* keep the report as a normal chat reply */ }
      }
      // Save the full reply first, even if this screen is replaced while it renders.
      if (sessionId) updateChatMessages(sessionId, [...messages, userMsg, reply]);
      clearTimeout(phaseTimer);
      const put = (r: ChatMessageType) => setMessages((prev) => prev.some((m) => m.id === replyId) ? prev.map((m) => (m.id === replyId ? r : m)) : [...prev, r]);
      const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (!deep && !stopped && !reply.document && finalText && !reduce) {
        // Presentation only: reveal the finished answer in logical units at a bounded pace.
        setTaskState(null); // status line disappears as the answer starts rendering
        const steps = revealPlan(replyText);
        setIsTyping(false);
        for (const st of steps.slice(0, -1)) {
          put({ ...reply, content: replyText.slice(0, st.upto) });
          await new Promise((res) => setTimeout(res, st.delayMs));
          if (abortRef.current && abortRef.current !== ctrl) break; // a newer request took over
        }
      }
      put(reply);
      setIsTyping(false);
      setTaskState(null);
    } catch (e: any) {
      setTaskState(null);
      if (e?.name === "AbortError") { clearTimeout(phaseTimer); setIsTyping(false); return; }
      const errMsg: ChatMessageType = { id: (Date.now() + 1).toString(), role: "assistant", content: `Sorry, an error occurred: ${e.message}`, timestamp: new Date() };
      // Replace a Deep Thinking status card with the error instead of leaving it spinning.
      setMessages((prev) => [...prev.filter((m) => !(m.deep && m.deep.stage !== "done" && !m.content)), errMsg]);
      clearTimeout(phaseTimer);
      setIsTyping(false);
    }
  }, [tool, chatId, addChat, messages, updateChatMessages, isIncognito, mode, draftProjectId, runInlineJob]);

  /** Attached documents/data/audio plus an instruction → one backend agent task in this chat. */
  const handleSendFiles = useCallback(async (typedContent: string, files: File[], extras?: { typed: string; pasted: PastedBlock[] }, plugins?: string[]) => {
    const plan = plugins?.length ? planPluginSend(plugins, typedContent, files) : null;
    const content = plan ? tagged(plugins, typedContent) : typedContent;
    const kindOf = (f: File): MessageAttachment["kind"] => f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : "file";
    setMessages((prev) => [...prev, {
      id: Date.now().toString(), role: "user", content, timestamp: new Date(),
      attachments: files.map((f) => ({ name: f.name, kind: kindOf(f), mime: f.type || undefined, size: f.size })),
      ...(extras?.pasted.length ? { pasted: extras.pasted, typed: extras.typed } : {}),
    }]);
    if (plan?.kind === "reply") { setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", content: plan.text, timestamp: new Date() }]); return; }
    let sid: string | null = isIncognito ? null : chatId;
    if (!isIncognito && !chatId) {
      const title = content.slice(0, 60) || files[0].name;
      sid = addChat(title, content.slice(0, 120), tool?.id, draftProjectId);
      adoptDraftMode(browserStore(), sid, mode);
      setChatId(sid); setChatTitle(title); onChatCreated?.(sid);
    }
    await runInlineJob("agent_task", { prompt: plan && plan.kind !== "chat" ? plan.prompt : content || "Inspect these files and tell me what they contain." }, sid, files);
  }, [chatId, addChat, tool, isIncognito, runInlineJob, mode, draftProjectId]);

  const handleZipUpload = useCallback(async (file: File) => {
    const userMsg: ChatMessageType = {
      id: Date.now().toString(),
      role: "user",
      content: `Uploaded ZIP file: ${file.name}`,
      typed: "",
      attachments: [{ name: file.name, kind: "file", mime: "application/zip", size: file.size }],
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsTyping(true);
    setThinkingPhase("thinking");

    let zipSession: string | null = isIncognito ? null : chatId;
    if (!isIncognito && !chatId) {
      const title = `ZIP: ${file.name}`;
      const newId = addChat(title, `Uploaded ${file.name}`, tool?.id, draftProjectId);
      adoptDraftMode(browserStore(), newId, mode);
      zipSession = newId;
      setChatId(newId);
      setChatTitle(title);
      onChatCreated?.(newId);
    }

    // Analysis runs on the server as a tracked job; the card shows its real status.
    const zipJobId = crypto.randomUUID();
    const msgId = `job-${zipJobId}`;
    trackJob(zipJobId, true);
    const show = (job: import("@/lib/builder/statuses").JobView) => setMessages((prev) => {
      const content = job.status === "failed" ? `Couldn't analyze **${file.name}**: ${job.error ?? "unknown error"}` : `Analysis of **${file.name}**`;
      const msg = { id: msgId, role: "assistant" as const, content, timestamp: new Date(), job };
      return prev.some((m) => m.id === msgId) ? prev.map((m) => (m.id === msgId ? msg : m)) : [...prev, msg];
    });
    setIsTyping(false);
    try {
      await runJob("zip_analyze", { file, sessionId: zipSession }, show, zipJobId);
    } catch (e: any) {
      setMessages((prev) => [...prev.filter((m) => m.id !== msgId), { id: msgId, role: "assistant", content: `Couldn't analyze the ZIP: ${e.message}`, timestamp: new Date() }]);
    }
    setIsTyping(false);
  }, [chatId, addChat, tool, isIncognito, mode, draftProjectId]);

  const handleFileConvert = useCallback((file: File) => {
    const cat = getCategory(file);
    if (!cat) return;

    const userMsg: ChatMessageType = {
      id: Date.now().toString(),
      role: "user",
      content: `Convert file: ${file.name}`,
      typed: "Convert this file",
      attachments: [{ name: file.name, kind: file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "file", mime: file.type || undefined, size: file.size }],
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);

    if (!isIncognito && !chatId) {
      const title = `Convert: ${file.name}`;
      const newId = addChat(title, `Convert ${file.name}`, tool?.id, draftProjectId);
      adoptDraftMode(browserStore(), newId, mode);
      setChatId(newId);
      setChatTitle(title);
      onChatCreated?.(newId);
    }

    setMessages((prev) => [...prev, {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: `Here's the file converter for **${file.name}**. Select your target format and click convert:`,
      timestamp: new Date(),
      convertFile: file,
    }]);
  }, [chatId, addChat, tool, isIncognito, mode, draftProjectId]);

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  const hasMessages = messages.length > 0;
  const defaultTitle = tool ? tool.shortName : "Vision";
  
  // Truncate display title to ~2-3 words with ellipsis
  const displayTitle = chatTitle
    ? chatTitle.length > 30 ? chatTitle.slice(0, 30) + "…" : chatTitle
    : defaultTitle;

  const projectPromptSent = useRef(false);
  useEffect(() => {
    if (projectPromptSent.current || chatId || !draftProjectId) return;
    const text = takePendingProjectPrompt(draftProjectId);
    if (!text) return;
    projectPromptSent.current = true;
    void handleSend(text);
  }, [draftProjectId, chatId, handleSend]);

  return (
    <div className="flex flex-col h-full flex-1 min-w-0">
      {projectId ? <ProjectChatHeader projectId={projectId} /> : <header className="relative flex shrink-0 items-center gap-3 bg-transparent px-3 py-1.5 sm:px-4 sm:py-2">
        <Button variant="floating" size="icon" aria-label="Open app drawer" title="Open app drawer"
          onClick={onMenuClick}
          className="rounded-full text-foreground [&_svg]:size-[22px]"
        >
          <Menu className="w-[22px] h-[22px]" />
        </Button>
        <Button variant="secondary" size="icon" className="rounded-full [&_svg]:size-5" aria-label="Upgrade Plan" title="Upgrade Plan" onClick={() => navigate("/billing/plans")}>
          <Crown />
        </Button>
        {!isIncognito && chatId && messages.length > 0 ? (
          <ChatActionsMenu chatId={chatId} onNewChat={() => navigate("/chat")} />
        ) : (
        <Button variant={isIncognito ? "default" : "secondary"} size="icon" className="ml-auto shrink-0 rounded-full transition-colors [&_svg]:size-5" aria-label={isIncognito ? "Turn off incognito" : "Turn on incognito"} title={isIncognito ? "Incognito on — tap to turn off" : "Incognito off — tap to turn on"} aria-pressed={isIncognito} onClick={onIncognitoChat}>
          <IncognitoIcon />
        </Button>
        )}
      </header>}

      <AnnouncementBanner />
      {isIncognito && (
        <p className="flex items-center justify-center gap-1.5 px-4 py-2 text-center text-xs font-medium text-muted-foreground">
          <IncognitoIcon className="h-3.5 w-3.5" /> Incognito on — this chat won't be saved
        </p>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">

        {hasMessages ? (
          <div className="py-3">
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                isNew={newMessageIds.has(msg.id)}
              />
            ))}
            {isTyping && <TypingIndicator phase={thinkingPhase} label={taskState ? STAGE_LABELS[taskState.stage] : undefined} detail={taskState?.message} />}
          </div>
        ) : (
          <EmptyState tool={tool} />
        )}
      </div>

      <ChatInput toolName={tool?.shortName} onSend={handleSend} onZipUpload={handleZipUpload} onFileConvert={handleFileConvert} onSendFiles={handleSendFiles} disabled={isTyping} busy={isTyping || streaming || activeJobs.size > 0} onStop={handleStop} mode={mode} onModeChange={setMode} />
    </div>
  );
};

export default ChatWorkspace;
