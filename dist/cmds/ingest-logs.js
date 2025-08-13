import { acquireLock, releaseLock } from "../lib/lock.js";
import { getLatestProdDeployment, getRuntimeLogs } from "../lib/vercel.js";
import { loadState, saveState } from "../lib/state.js";
import { readFile, upsertFile } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { summarizeLogToBug } from "../lib/prompts.js";
export async function ingestLogs() {
    if (!(await acquireLock())) {
        console.log("Lock taken; exiting.");
        return;
    }
    try {
        const state = await loadState();
        const dep = await getLatestProdDeployment();
        if (!dep) {
            console.log("No deployment found; exit.");
            return;
        }
        if (state.ingest?.lastDeploymentId === dep.uid) {
            console.log("No new deployment; exit.");
            return;
        }
        const raw = await getRuntimeLogs(dep.uid);
        const entries = raw
            .filter((r) => r.level && (r.level === "error" || r.level === "warning"))
            .map((r) => ({ level: r.level, message: r.message || r?.text || "", path: r?.requestPath, ts: r?.timestamp }))
            .slice(0, 50);
        if (entries.length === 0) {
            console.log("No relevant log entries.");
            await saveState({ ...state, ingest: { lastDeploymentId: dep.uid, lastRowIds: [] } });
            return;
        }
        const suggestion = await summarizeLogToBug(entries);
        const bugsPath = "roadmap/bugs.md";
        const current = await readFile(bugsPath) || "";
        const currentYaml = readYamlBlock(current, { queue: [] });
        // Very conservative: append one synthetic item that includes LLM output
        currentYaml.queue.push({
            id: `BUG-${dep.uid.slice(0, 6)}-${Date.now()}`,
            title: "Errors & warnings from latest deployment",
            details: suggestion,
            created: new Date().toISOString()
        });
        const next = writeYamlBlock(current, currentYaml);
        await upsertFile(bugsPath, () => next, "bot: ingest logs → bugs.md");
        await saveState({ ...state, ingest: { lastDeploymentId: dep.uid, lastRowIds: [] } });
        console.log("Ingest complete.");
    }
    finally {
        await releaseLock();
    }
}
