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

function getLogSignature(message: string): string {
  return message
    .replace(/\[\w+\]/g, "") // remove [GET], [POST] etc
    .replace(/\b\w{8}-\w{4}-\w{4}-\w{4}-\w{12}\b/g, "[UUID]") // remove UUIDs
    .replace(/\b[0-9a-f]{24}\b/g, "[ID]") // remove 24-char hex IDs
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "[TIMESTAMP]") // remove timestamps
    .replace(/ip=\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "ip=[IP]") // remove IP
    .replace(/duration=\d+ms/g, "duration=[DURATION]") // remove duration
    .replace(/:\d{2,5}/g, ":[PORT]") // remove port numbers
    .trim();
}

function isInfraLog(e: RawLog): boolean {
  const msg = (e.message ?? e.text ?? "").toString();
  const path = (e.requestPath ?? "").toString();
  const INFRA_PATTERNS = [
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

    if (state.ingest?.lastDeploymentTimestamp && dep.createdAt <= state.ingest.lastDeploymentTimestamp) {
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
      }));

    if (entries.length === 0) {
      console.log("No relevant log entries.");
      await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
      return;
    }

    const appEntries = entries.filter(e => !isInfraLog(e));
    const infraEntries = entries.filter(isInfraLog);

    if (appEntries.length === 0 && infraEntries.length > 0) {
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
      await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
      console.log("Infra-only logs detected; routed to new.md instead of bugs.md.");
      return;
    }

    if (appEntries.length === 0) {
        console.log("No application log entries to process.");
        await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
        return;
    }

    const grouped = new Map<string, LogEntryForBug[]>();
    for (const entry of appEntries) {
      const signature = getLogSignature(entry.message);
      if (!grouped.has(signature)) {
        grouped.set(signature, []);
      }
      grouped.get(signature)!.push({
        level: (entry.level as "error" | "warning") ?? "error",
        message: String(entry.message ?? ""),
        path: entry.requestPath || undefined,
        ts: entry.timestamp || undefined
      });
    }

    const bugsPath = "roadmap/bugs.md";
    const current = (await readFile(bugsPath)) || "";
    const currentYaml = readYamlBlock<{ queue: any[] }>(current, { queue: [] });

    for (const [_, entriesForSummary] of grouped) {
      const summary = await summarizeLogToBug(entriesForSummary);
      if (!summary) continue;

      const lines = summary.trim().split('\n');
      const title = lines[0]?.replace(/^#+\s*/, '').trim() || "Runtime error from logs";
      const details = lines.slice(1).join('\n').trim();

      currentYaml.queue.push({
        id: `BUG-${dep.uid.slice(0, 6)}-${Date.now()}`,
        title: title,
        details: details,
        created: new Date().toISOString()
      });
    }

    const next = writeYamlBlock(current, currentYaml);
    await upsertFile(bugsPath, () => next, "bot: ingest logs → bugs.md");

    await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: [] } });
    console.log("Ingest complete.");
  } finally {
    await releaseLock();
  }
}
