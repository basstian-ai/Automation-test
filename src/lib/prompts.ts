// src/lib/prompts.ts
import OpenAI from "openai";
import { ENV, requireEnv } from "./env.js";

/** Lazily get an OpenAI client only when needed */
function getOpenAI() {
  requireEnv(["OPENAI_API_KEY"]);
  return new OpenAI({ apiKey: ENV.OPENAI_API_KEY });
}

/** Types */
export type LogEntryForBug = {
  level: "error" | "warning";
  message: string;
  path?: string;
  ts?: string;
};

/**
 * Turn runtime/build log entries into a short bug description list.
 * Return is free-form markdown/text that the caller writes into bugs.md.
 */
export async function summarizeLogToBug(entries: LogEntryForBug[]): Promise<string> {
  const openai = getOpenAI();
  const messages = [
    {
      role: "system" as const,
      content:
        "You are an experienced software architect. Convert each unique error/warning into a succinct bug with a short title and 2–4 line description. No priorities, no duplicates. Output concise markdown."
    },
    { role: "user" as const, content: JSON.stringify(entries, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

/**
 * Quick repo review → ideas/improvements in YAML (under queue:).
 * Caller will parse/merge the YAML; duplicates should be minimized.
 */
export async function reviewToIdeas(input: {
  commits: string[];
  vision: string;
  tasks: string;
  bugs: string;
  done: string;
  fresh: string; // current new.md content
}): Promise<string> {
  const openai = getOpenAI();
  const messages = [
    {
      role: "system" as const,
      content:
        "You are an experienced software architect. Propose, actionable items for code bot based on the context. Include tasks that make visible progress for the end user." +
        "Return ONLY YAML in a code block with the shape:\n```yaml\nqueue:\n  - id: <leave blank or omit>\n    title: <short>\n    details: <1-3 lines>\n    created: <ISO>\n```" +
        "\nAvoid duplicates vs the provided lists."
    },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

/**
 * Promote items from roadmap/new.md (ideas queue) → tasks with unique priorities (1..N).
 * Return YAML (items: [...]) in a code block; caller merges & enforces limits.
 */
export async function synthesizeTasksPrompt(input: {
  tasks: string;
  bugs: string;
  ideas: string;
  vision: string;
  done: string;
}): Promise<string> {
  const openai = getOpenAI();
  const messages = [
    {
      role: "system" as const,
      content:
        "Promote items from roadmap/new.md (ideas queue) into tasks.\n" +
        "Return ONLY YAML in a code block with the shape:\n```yaml\nitems:\n  - id: <leave blank or omit>\n    type: bug|improvement|feature\n    title: <short>\n    desc: <2–4 lines>\n    source: logs|review|user|vision\n    created: <ISO>\n    priority: <int>\n```\n" +
        "Rules: no duplicates vs existing tasks; unique priorities 1..N; prefer critical bugs and user-impactful work; cap at ~100."
    },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

/**
 * Plan minimal code changes for the top task.
 * Returns a JSON string the caller will JSON.parse().
 * Shape:
 * {
 *   operations: [{ path: string, action: "create"|"update", content?: string }],
 *   testHint: string,
 *   commitTitle: string,
 *   commitBody: string
 * }
 */
export async function implementPlan(input: {
  vision: string;
  done: string;
  topTask: any;
  repoTree: string[]; // optional list of known files; may be empty
}): Promise<string> {
  const openai = getOpenAI();
  const messages = [
    {
      role: "system" as const,
      content:
        "You are a senior developer. Develope task and deliver in a safe diff. " +
        "Output ONLY JSON with keys: operations (array of {path, action:create|update, content?}), testHint, commitTitle, commitBody. " +
        "Keep diffs tangible; only files relevant to the task; include at least one test file if a test harness exists; avoid broad refactors."
    },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    messages
  });
  return r.choices[0]?.message?.content ?? "{}";
}
