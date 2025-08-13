import OpenAI from "openai";
import { ENV } from "./env.js";
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

export async function summarizeLogToBug(entries: Array<{ level: string; message: string; path?: string; ts?: string }>) {
  const messages = [
    { role: "system" as const, content: "You are an experienced software architect. Convert each unique error/warning into a succinct bug with a short title and 2–4 line description. No priorities, no duplicates." },
    { role: "user" as const, content: JSON.stringify(entries, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.2,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

export async function reviewToIdeas(input: { commits: string[]; vision: string; tasks: string; bugs: string; done: string; fresh: string; }) {
  const messages = [
    { role: "system" as const, content: "You are an experienced software architect. Propose small, actionable items (≤1 day) as YAML under queue:. Avoid duplicates vs existing lists." },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.2,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

export async function synthesizeTasksPrompt(input: { tasks: string; bugs: string; ideas: string; vision: string; done: string; }) {
  const messages = [
    { role: "system" as const, content: "Promote items from bugs/new into tasks.\nReturn YAML under items: with type (bug|improvement|feature), title, desc, source, created.\nAssign unique priority 1..N (≤100). Deduplicate. Optimize for critical bugs & meaningful user progress. Then also return YAML for queues with remaining.\n" },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.1,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}

export async function implementPlan(input: { vision: string; done: string; topTask: any; repoTree: string[]; }) {
  const messages = [
    { role: "system" as const, content: "You are a senior developer. Plan minimal changes to implement the task. Output JSON: {operations:[{path,action,content?}], testHint:string, commitTitle:string, commitBody:string}. Only include files that belong to the task; keep diffs small; include at least one test if there is a test harness." },
    { role: "user" as const, content: JSON.stringify(input, null, 2) }
  ];
  const r = await openai.chat.completions.create({
    model: ENV.OPENAI_MODEL,
    temperature: 0.2,
    messages
  });
  return r.choices[0]?.message?.content ?? "";
}
