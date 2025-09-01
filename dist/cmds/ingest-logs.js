// src/cmds/ingest-logs.ts
import { acquireLock, releaseLock } from "../lib/lock.js";
import { getLatestDeployment, getRuntimeLogs } from "../lib/vercel.js";
import { loadState, saveState, appendChangelog, appendDecision } from "../lib/state.js";
import { summarizeLogToBug } from "../lib/prompts.js";
import { insertRoadmap } from "../lib/roadmap.js";
function getLogSignature(message) {
    return message
        .replace(/\[\w+\]/g, "")
        .replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, "[UUID]")
        .replace(/\b[0-9a-f]{24}\b/g, "[ID]")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "[TIMESTAMP]")
        .replace(/ip=\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "ip=[IP]")
        .replace(/duration=\d+ms/g, "duration=[DURATION]")
        .replace(/:\d{2,5}/g, ":[PORT]")
        .trim();
}
function isInfraLog(e) {
    const msg = (e.message ?? e.text ?? "").toString();
    const path = (e.requestPath ?? "").toString();
    const INFRA_PATTERNS = [
        /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i,
        /failed to fetch runtime-logs/i,
        /Too Many Requests|rate limit/i,
        /https?:\/\/api\.vercel\.com/i
    ];
    if (INFRA_PATTERNS.some(rx => rx.test(msg)))
        return true;
    if (/^https?:\/\/api\.vercel\.com/.test(path))
        return true;
    return false;
}
export async function ingestLogs() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        const state = await loadState();
        const dep = await getLatestDeployment();
        if (!dep) {
            console.log("No deployment found; exit.");
            return;
        }
        if (state.ingest?.lastDeploymentTimestamp && dep.createdAt <= state.ingest.lastDeploymentTimestamp) {
            console.log("No new deployment; exit.");
            return;
        }
        const raw = await getRuntimeLogs(dep.uid);
        const entries = raw
            .filter(r => r && (r.level === "error" || r.level === "warning"))
            .map(r => ({
            level: r.level,
            message: r.message ?? r.text ?? "",
            requestPath: r.requestPath ?? "",
            timestamp: r.timestamp ?? ""
        }));
        if (entries.length === 0) {
            console.log("No relevant log entries.");
            await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
            return;
        }
        const appEntries = entries.filter(e => !isInfraLog(e));
        const infraEntries = entries.filter(isInfraLog);
        if (appEntries.length === 0 && infraEntries.length > 0) {
            const item = {
                id: `IDEA-INGEST-${dep.uid.slice(0, 6)}-${Date.now()}`,
                type: "idea",
                title: "Ingestion/infra errors from Vercel logs API",
                details: `Examples:\n${infraEntries
                    .slice(0, 3)
                    .map(e => `- ${e.message}`)
                    .join("\n")}\n\nAction: classify as infra; add retries/backoff; consider log drain.`,
                created: new Date().toISOString()
            };
            await insertRoadmap([item]);
            await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
            await appendChangelog("Handled infra-only logs during ingestion.");
            await appendDecision("Routed infra-related logs to Supabase as ideas instead of bugs.");
            console.log("Infra-only logs detected; routed to Supabase as type=idea.");
            return;
        }
        if (appEntries.length === 0) {
            console.log("No application log entries to process.");
            await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
            await appendChangelog("Ingestion run found no application logs.");
            await appendDecision("No app logs to process from latest deployment.");
            return;
        }
        const grouped = new Map();
        for (const entry of appEntries) {
            const signature = getLogSignature(entry.message || "");
            if (!grouped.has(signature)) {
                grouped.set(signature, []);
            }
            grouped.get(signature).push({
                level: entry.level ?? "error",
                message: String(entry.message ?? ""),
                path: entry.requestPath || undefined,
                ts: entry.timestamp || undefined
            });
        }
        const items = [];
        for (const [_, entriesForSummary] of grouped) {
            const summary = await summarizeLogToBug(entriesForSummary);
            if (!summary)
                continue;
            const lines = summary.trim().split("\n");
            const title = lines[0]?.replace(/^#+\s*/, "").trim() || "Runtime error from logs";
            const details = lines.slice(1).join("\n").trim();
            items.push({
                id: `BUG-${dep.uid.slice(0, 6)}-${Date.now()}`,
                type: "bug",
                title,
                details,
                created: new Date().toISOString()
            });
        }
        await insertRoadmap(items);
        await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
        await appendChangelog("Ingested runtime logs and inserted bugs into Supabase.");
        await appendDecision("Processed runtime logs and updated state after ingestion.");
        console.log("Ingest complete.");
    }
    finally {
        await releaseLock();
    }
}
