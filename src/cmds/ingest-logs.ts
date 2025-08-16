// src/cmds/ingest-logs.ts
import { acquireLock, releaseLock } from "../lib/lock.js";
import { getLatestDeployment, getRuntimeLogs } from "../lib/vercel.js";
import { loadState, saveState } from "../lib/state.js";
import { readFile, upsertFile } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { summarizeLogToBug, type LogEntryForBug } from "../lib/prompts.js";

type RawLog = {
  level?: string;
  message?: string;
  text?: string;
  requestPath?: string;
  timestamp?: string;
  [k: string]: any;
};

function isInfraLog(e: RawLog): boolean {
  const msg = (e.message ?? e.text ?? "").toString();
  const path = (e.requestPath ?? "").toString();
  const INFRA_PATTERNS = [
    /Query Duration Limit Exceeded/i,
    /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i,
    /failed to fetch runtime-logs/i,
    /Too Many Requests|rate limit/i,
    /https?:\/\/api\.vercel\.com/i
  ];
  if (INFRA_PATTERNS.some(rx => rx.test(msg))) return true;
  if (/^https?:\/\/api\.vercel\.com/.test(path)) return true;
  return false;
}

export async function ingestLogs(): Promise<void> {
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
    if (state.ingest?.lastDeploymentId === dep.uid) {
      console.log("No new deployment; exit.");
      return;
    }

    const raw = await getRuntimeLogs(dep.uid);

    const entries: RawLog[] = (raw as any[])
      .filter(r => r && (r.level === "error" || r.level === "warning"))
      .map(r => ({
        level: r.level,
        message: r.message ?? r.text ?? "",
        requestPath: r.requestPath ?? "",
        timestamp: r.timestamp ?? ""
      }))
      .slice(0, 200);

    if (entries.length === 0) {
      console.log("No relevant log entries.");
      await saveState({ ...state, ingest: { lastDeploymentId: dep.uid, lastRowIds: [] } });
      return;
    }

    const appEntries = entries.filter(e => !isInfraLog(e));
    const infraEntries = entries.filter(isInfraLog);

    if (appEntries.length === 0) {
      // Route infra/ingestion issues to new.md
      const newPath = "roadmap/new.md";
      const currentNew = (await readFile(newPath)) || "";
      const newYaml = readYamlBlock<{ queue: any[] }>(currentNew, { queue: [] });
      newYaml.queue.push({
        id: `IDEA-INGEST-${dep.uid.slice(0, 6)}-${Date.now()}`,
        title: "Ingestion/infra errors from Vercel logs API",
        details:
          `Examples:\n${infraEntries.slice(0, 3).map(e => `- ${e.message}`).join("\n")}\n\n` +
          "Action: classify as infra; add retries/backoff; consider log drain.",
        created: new Date().toISOString()
      });
      const nextNew = writeYamlBlock(currentNew, newYaml);
      await upsertFile(newPath, () => nextNew, "bot: route infra ingestion issues → new.md");
      await saveState({ ...state, ingest: { lastDeploymentId: dep.uid, lastRowIds: [] } });
      console.log("Infra-only logs detected; routed to new.md instead of bugs.md.");
      return;
    }

     // Map to the strict shape summarizeLogToBug expects
    const summarizeInput: LogEntryForBug[] = appEntries
      .filter(e => e.level === "error" || e.level === "warning")
      .map(e => ({
        level: (e.level as "error" | "warning") ?? "error",
        message: String(e.message ?? ""),
        path: e.requestPath || undefined,
        ts: e.timestamp || undefined
      }));

    const suggestion = await summarizeLogToBug(summarizeInput);

    const bugsPath = "roadmap/bugs.md";
    const current = (await readFile(bugsPath)) || "";
    const currentYaml = readYamlBlock<{ queue: any[] }>(current, { queue: [] });
    currentYaml.queue.push({
      id: `BUG-${dep.uid.slice(0, 6)}-${Date.now()}`,
      title: "App runtime errors & warnings from latest deployment",
      details: suggestion,
      created: new Date().toISOString()
    });
    const next = writeYamlBlock(current, currentYaml);
    await upsertFile(bugsPath, () => next, "bot: ingest logs → bugs.md");

    await saveState({ ...state, ingest: { lastDeploymentId: dep.uid, lastRowIds: [] } });
    console.log("Ingest complete.");
  } finally {
    await releaseLock();
  }
}
