import { acquireLock, releaseLock } from "../lib/lock.js";
import { readFile, upsertFile } from "../lib/github.js";
import { readYamlBlock, writeYamlBlock } from "../lib/md.js";
import { synthesizeTasksPrompt } from "../lib/prompts.js";

export async function synthesizeTasks() {
  if (!(await acquireLock())) { console.log("Lock taken; exiting."); return; }
  try {
    const vision = (await readFile("roadmap/vision.md")) || "";
    const tasks  = (await readFile("roadmap/tasks.md"))  || "";
    const bugs   = (await readFile("roadmap/bugs.md"))   || "";
    const ideas  = (await readFile("roadmap/new.md"))    || "";
    const done   = (await readFile("roadmap/done.md"))   || "";

    const proposal = await synthesizeTasksPrompt({ tasks, bugs, ideas, vision, done });
    // naive: append proposal into tasks and clear queues (agent-friendly; you can refine)
    const tYaml = readYamlBlock<any>(tasks, { items: [] });
    const nYaml = readYamlBlock<any>(ideas, { queue: [] });
    const bYaml = readYamlBlock<any>(bugs, { queue: [] });

    tYaml.items = Array.isArray(tYaml.items) ? tYaml.items : [];
    tYaml.items = tYaml.items.slice(0, 100); // guardrail

    // Record the LLM proposal for traceability
    tYaml.items.push({
      id: `TSK-${Date.now()}`,
      type: "improvement",
      title: "Batch task synthesis",
      desc: proposal,
      source: "review",
      created: new Date().toISOString(),
      priority: (tYaml.items.length || 0) + 1
    });

    await upsertFile("roadmap/tasks.md", (old) => writeYamlBlock(old, tYaml), "bot: synthesize → tasks.md");
    await upsertFile("roadmap/new.md",   (old) => writeYamlBlock("", { queue: [] }), "bot: clear → new.md");
    await upsertFile("roadmap/bugs.md",  (old) => writeYamlBlock("", { queue: [] }), "bot: clear → bugs.md");

    console.log("Synthesis complete.");
  } finally {
    await releaseLock();
  }
}
