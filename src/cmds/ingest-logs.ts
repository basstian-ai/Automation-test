// src/cmds/ingest-logs.ts

import { acquireLock, releaseLock } from "../lib/lock.js";
import { getLatestDeployment, getRuntimeLogs } from "../lib/vercel.js";
import { loadState, saveState, appendChangelog, appendDecision } from "../lib/state.js";
import { summarizeLogToBug, type LogEntryForBug } from "../lib/prompts.js";
import { insertRoadmap, type RoadmapItem } from "../lib/roadmap.js";

type RawLog = {
  id?: string;
  level?: string;
  message?: string;
  text?: string;
  requestPath?: string;
  timestamp?: string;
  [k: string]: any;
};

function getLogSignature(message: string): string {
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

function isInfraLog(e: RawLog): boolean {
  const msg = (e.message ?? e.text ?? "").toString();
  const path = (e.requestPath ?? "").toString();
  const INFRA_PATTERNS = [
    /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i,
    /failed to fetch runtime-logs/i,
    /Too Many Requests|rate limit/i,
    /https?:\/\/api\.vercel\.com/i,
    /Query exceeds 5-minute execution limit/i // exceeds Vercel's query time limit
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

    if (state.ingest?.lastDeploymentTimestamp && dep.createdAt < state.ingest.lastDeploymentTimestamp) {
      console.log("No new deployment; exit.");
      return;
    }

    const sameDep = state.ingest?.lastDeploymentTimestamp === dep.createdAt;
    const prevRowIds = sameDep ? state.ingest?.lastRowIds ?? [] : [];
    let raw: any[] = [];
    if (prevRowIds.length > 0) {
      const fromId = prevRowIds[prevRowIds.length - 1];
      raw = (await getRuntimeLogs(dep.uid, { fromId, limit: 100, direction: "forward" })) as any[];
    } else {
      const now = Date.now();
      const from = new Date(now - 5 * 60 * 1000).toISOString();
      const until = new Date(now).toISOString();
      raw = (await getRuntimeLogs(dep.uid, { from, until, limit: 100, direction: "forward" })) as any[];
    }
    const rawIds = raw.map(r => r?.id).filter(Boolean) as string[];
    const prevIds = new Set(prevRowIds);
    const entries: RawLog[] = raw
      .filter(r => r && (r.level === "error" || r.level === "warning"))
      .filter(r => !prevIds.has(r.id))
      .map(r => ({
        id: r.id,
        level: r.level,
        message: r.message ?? r.text ?? "",
        requestPath: r.requestPath ?? "",
        timestamp: r.timestamp ?? ""
      }));

    if (entries.length === 0) {
      console.log("No relevant log entries.");
      await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: rawIds } });
      return;
    }

    const appEntries = entries.filter(e => !isInfraLog(e));
    const infraEntries = entries.filter(isInfraLog);

    if (appEntries.length === 0 && infraEntries.length > 0) {
      const item: RoadmapItem = {
        id: `IDEA-INGEST-${dep.uid.slice(0, 6)}-${Date.now()}`,
        type: "idea",
        title: "Ingestion/infra errors from Vercel logs API",
        content: `Examples:\n${infraEntries
          .slice(0, 3)
          .map(e => `- ${e.message}`)
          .join("\n")}\n\nAction: classify as infra; add retries/backoff; consider log drain.`,
        created: new Date().toISOString()
      };
      await insertRoadmap([item]);
      await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: rawIds } });
      await appendChangelog("Handled infra-only logs during ingestion.");
      await appendDecision("Routed infra-related logs to Supabase as ideas instead of bugs.");
      console.log("Infra-only logs detected; routed to Supabase as type=idea.");
      return;
    }

    if (appEntries.length === 0) {
      console.log("No application log entries to process.");
      await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: rawIds } });
      await appendChangelog("Ingestion run found no application logs.");
      await appendDecision("No app logs to process from latest deployment.");
      return;
    }

    const grouped = new Map<string, LogEntryForBug[]>();
    for (const entry of appEntries) {
      const signature = getLogSignature(entry.message || "");
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

    const items: RoadmapItem[] = [];

    for (const [_, entriesForSummary] of grouped) {
      const summary = await summarizeLogToBug(entriesForSummary);
      if (!summary) continue;

      const lines = summary.trim().split("\n");
      const title = lines[0]?.replace(/^#+\s*/, "").trim() || "Runtime error from logs";
      const content = lines.slice(1).join("\n").trim();

      items.push({
        id: `BUG-${dep.uid.slice(0, 6)}-${Date.now()}`,
        type: "bug",
        title,
        content,
        created: new Date().toISOString()
      });
    }

    await insertRoadmap(items);

    await saveState({ ...state, ingest: { lastDeploymentTimestamp: dep.createdAt, lastRowIds: rawIds } });
    await appendChangelog("Ingested runtime logs and inserted bugs into Supabase.");
    await appendDecision("Processed runtime logs and updated state after ingestion.");
    console.log("Ingest complete.");
  } finally {
    await releaseLock();
  }
}
