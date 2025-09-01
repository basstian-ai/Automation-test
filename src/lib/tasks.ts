import { supabase } from "./supabase.js";
import type { Task } from "./types.js";

/**
 * Marks a task as completed and logs the completion in a single operation.
 * Uses a stored procedure or upsert to ensure both actions occur atomically.
 */
export async function completeTask(task: Task) {
  const { error } = await supabase.rpc("complete_task", {
    task_id: task.id,
    title: task.title,
    desc: task.desc,
    priority: task.priority,
  });
  if (error) throw error;
}

