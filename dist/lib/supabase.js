import { createClient } from "@supabase/supabase-js";
import { ENV } from "./env.js";
function requireSupabase() {
    if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Missing Supabase credentials: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is undefined");
    }
}
let client;
function getClient() {
    requireSupabase();
    if (!client) {
        client = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY);
    }
    return client;
}
export const supabase = new Proxy({}, {
    get(_target, prop, receiver) {
        return Reflect.get(getClient(), prop, receiver);
    },
});
export async function sbRequest(path, init = {}) {
    requireSupabase();
    const url = `${ENV.SUPABASE_URL}/rest/v1/${path}`;
    const headers = {
        apikey: ENV.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...init.headers,
    };
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
        let bodyText = "";
        try {
            bodyText = await res.text();
        }
        catch {
            // ignore
        }
        let detail = "";
        try {
            const data = JSON.parse(bodyText);
            detail = [data.message, data.hint].filter(Boolean).join(" - ");
            if (!detail) {
                detail = bodyText.slice(0, 100);
            }
        }
        catch {
            detail = bodyText.slice(0, 100);
        }
        throw new Error(`Supabase error: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ""}`);
    }
    if (res.status === 204 || res.headers.get("Content-Length") === "0") {
        return undefined;
    }
    return res.json();
}
