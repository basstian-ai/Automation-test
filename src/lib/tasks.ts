import { supabase } from "./supabase.js";
import type { Task } from "./types.js";

/**
 * Marks a task as completed and logs the completion in a single operation.
 * Uses a stored procedure or upsert to ensure both actions occur atomically.
 */
export async function completeTask(task: Task) {
  const params = {
    item_id: task.id,
    title: task.title,
    details: task.desc,
    priority: task.priority,
    ...(task.type != null ? { type: task.type } : {}),
  };

  // Try the canonical function name first and fall back to the legacy name if needed.
  let { error } = await supabase.rpc("complete_task", params);
  if (error && /not found|No function/i.test(String(error.message))) {
    const res = await supabase.rpc("complete_roadmap_task", params);
    if (res.error) throw res.error;
  } else if (error) {
    throw error;
  }
}

