// src/lib/supabase.ts
import { ENV, requireEnv } from "./env.js";
export async function insertRoadmap(items) {
    if (items.length === 0)
        return;
    requireEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    const res = await fetch(`${ENV.SUPABASE_URL}/rest/v1/roadmap`, {
        method: "POST",
        headers: {
            apikey: ENV.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
        },
        body: JSON.stringify(items)
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase insert failed: ${res.status} ${text}`);
    }
}
