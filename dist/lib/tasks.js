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
    // Try the canonical function name first and fall back to the legacy name if needed.
    let { error } = await supabase.rpc("complete_task", params);
    if (error && (error.code === "42883" || error.code === "PGRST302")) {
        const res = await supabase.rpc("complete_roadmap_task", params);
        if (res.error)
            throw res.error;
    }
    else if (error) {
        throw error;
    }
}
