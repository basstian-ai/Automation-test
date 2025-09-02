import { supabase } from "./supabase.js";
/**
 * Marks a task as completed and logs the completion in a single operation.
 * Uses a stored procedure or upsert to ensure both actions occur atomically.
 */
export async function completeTask(task) {
    const params = {
        item_id: task.id,
        title: task.title,
        details: task.desc,
        priority: task.priority,
        ...(task.type != null ? { type: task.type } : {}),
    };
    const { error } = await supabase.rpc("complete_roadmap_task", params);
    if (error)
        throw error;
}
