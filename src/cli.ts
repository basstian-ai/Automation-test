import { ingestLogs } from "./cmds/ingest-logs.js";
import { reviewRepo } from "./cmds/review-repo.js";
import { synthesizeTasks } from "./cmds/synthesize-tasks.js";
import { implementTopTask } from "./cmds/implement.js";

const cmd = process.argv[2];

(async () => {
  try {
    if (cmd === "ingest-logs") await ingestLogs();
    else if (cmd === "review-repo") await reviewRepo();
    else if (cmd === "synthesize-tasks") await synthesizeTasks();
    else if (cmd === "implement") await implementTopTask();
    else {
      console.error("Usage: cli <ingest-logs|review-repo|synthesize-tasks|implement>");
      process.exit(2);
    }
  } catch (err: any) {
    console.error(`[ERROR] ${cmd}:`, err?.stack || err?.message || err);
    process.exit(1);
  }
})();
