import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/cloud/client";
import { useAuth } from "@/context/AuthContext";
import { runJob } from "@/lib/builder/jobs-client";
import type { JobView } from "@/lib/builder/statuses";

export type BackgroundTask = {
  id: string;
  user_id: string;
  session_id: string | null;
  task_type: string;
  status: string;
  input: any;
  result: any;
  progress: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export function useBackgroundTasks(sessionId?: string | null) {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [activeTasks, setActiveTasks] = useState<BackgroundTask[]>([]);

  // Load existing tasks for this session
  useEffect(() => {
    if (!user || !sessionId) return;

    const loadTasks = async () => {
      const { data } = await supabase
        .from("background_tasks")
        .select("*")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true });

      if (data) setTasks(data as BackgroundTask[]);
    };

    loadTasks();
  }, [user, sessionId]);

  // Load all active (running/pending) tasks for user
  useEffect(() => {
    if (!user) return;

    const loadActive = async () => {
      const { data } = await supabase
        .from("background_tasks")
        .select("*")
        .eq("user_id", user.id)
        .in("status", ["pending", "running"])
        .order("created_at", { ascending: false });

      if (data) setActiveTasks(data as BackgroundTask[]);
    };

    loadActive();
  }, [user]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel("background-tasks-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "background_tasks",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const task = payload.new as BackgroundTask;

          // Update session tasks
          setTasks((prev) => {
            const idx = prev.findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = task;
              return updated;
            }
            if (sessionId && task.session_id === sessionId) {
              return [...prev, task];
            }
            return prev;
          });

          // Update active tasks
          setActiveTasks((prev) => {
            if (task.status === "done" || task.status === "error") {
              return prev.filter((t) => t.id !== task.id);
            }
            const idx = prev.findIndex((t) => t.id === task.id);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = task;
              return updated;
            }
            if (task.status === "pending" || task.status === "running") {
              return [task, ...prev];
            }
            return prev;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, sessionId]);

  // Dispatch a new background task
  const dispatch = useCallback(
    async (taskType: string, input: any, chatSessionId?: string) => {
      if (!user) throw new Error("Not authenticated");

      const sid = chatSessionId || sessionId;

      const toTask = (job: JobView): BackgroundTask => ({
        id: job.id, user_id: user.id, session_id: sid ?? null, task_type: taskType,
        input, status: job.status, result: job.result, progress: job.progress,
        error: job.error, created_at: job.created_at, updated_at: job.updated_at,
      });
      const job = await runJob("agent_task", { input: typeof input === "string" ? input : JSON.stringify(input), sessionId: sid }, (current) => {
        const task = toTask(current);
        setTasks((prev) => [...prev.filter((t) => t.id !== task.id), task]);
        setActiveTasks((prev) => current.status === "completed" || current.status === "failed" || current.status === "cancelled"
          ? prev.filter((t) => t.id !== task.id) : [...prev.filter((t) => t.id !== task.id), task]);
      });
      return toTask(job);
    },
    [user, sessionId]
  );

  return { tasks, activeTasks, dispatch };
}
