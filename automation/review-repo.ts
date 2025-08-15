import { promises as fs } from "fs";
import path from "path";
import { execSync } from "child_process";
import { planRepo } from "./prompt.js";

const TARGET_PATH = process.env.TARGET_PATH || "target";
const MAX_FILES = parseInt(process.env.MAX_FILES || "800", 10);
const MAX_BYTES_PER_FILE = parseInt(process.env.MAX_BYTES_PER_FILE || "50000", 10);
const MAX_TASKS = parseInt(process.env.MAX_TASKS_PER_RUN || "5", 10);
const PROTECTED_PATHS: string[] = JSON.parse(process.env.PROTECTED_PATHS || "[]");

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out"]);
const TEXT_EXT = /\.(md|txt|js|ts|json|yaml|yml|html|css|py|java|go|rb|sh|c|cpp|cs)$/i;

async function scanRepo(root: string) {
  const topLevel = await fs.readdir(root);
  const files: { path: string; sample: string }[] = [];
  let fileCount = 0;
  let dirCount = 0;
  const dupMap = new Map<string, number>();

  async function walk(cur: string) {
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(cur, e.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (IGNORE_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        dirCount++;
        dupMap.set(e.name, (dupMap.get(e.name) || 0) + 1);
        await walk(full);
      } else if (e.isFile()) {
        fileCount++;
        if (files.length < Math.min(MAX_FILES, 600) && TEXT_EXT.test(e.name)) {
          try {
            const buf = await fs.readFile(full);
            const sample = buf.toString("utf8").slice(0, MAX_BYTES_PER_FILE);
            files.push({ path: rel, sample });
          } catch {}
        }
      }
    }
  }

  await walk(root);
  const duplicates = Array.from(dupMap.entries()).filter(([, c]) => c > 1).map(([n]) => n);
  return { topLevel, fileCount, dirCount, duplicates, files };
}

async function writeFileSafe(p: string, content: string) {
  const rel = path.relative(TARGET_PATH, p).replace(/\\/g, "/");
  if (PROTECTED_PATHS.includes(rel)) {
    throw new Error(`Refusing to write protected path: ${rel}`);
  }
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  console.log(`Wrote ${p}`);
}

async function main() {
  const manifest = await scanRepo(TARGET_PATH);
  console.log(`Scanned ${manifest.fileCount} files in ${manifest.dirCount} dirs`);
  if (manifest.duplicates.length) {
    console.log(`Duplicate dirs: ${manifest.duplicates.join(", ")}`);
  }

  const auditPath = path.join(TARGET_PATH, "audits", "repo-structure.md");
  const auditContent = [
    `# Repo Structure`,
    `Scanned ${manifest.fileCount} files across ${manifest.dirCount} directories.`,
    "", "## Top-level", ...manifest.topLevel.map(d => `- ${d}`),
    "", "## Duplicate dir candidates", ...manifest.duplicates.map(d => `- ${d}`)
  ].join("\n");
  await writeFileSafe(auditPath, auditContent);

  const roadmapNew = await readOptional(path.join(TARGET_PATH, "roadmap", "new.md"));
  const roadmapTasks = await readOptional(path.join(TARGET_PATH, "roadmap", "tasks.md"));

  const plan = await planRepo({
    manifest,
    roadmap: { tasks: roadmapTasks, fresh: roadmapNew },
    maxTasks: MAX_TASKS,
    protected: PROTECTED_PATHS,
  });

  await writeFileSafe(path.join(TARGET_PATH, "roadmap", "new.md"), plan);
  await writeFileSafe(path.join(TARGET_PATH, "roadmap", "tasks.md"), plan);

  try {
    execSync('git config user.name "ai-dev-agent"', { cwd: TARGET_PATH });
    execSync('git config user.email "bot@local"', { cwd: TARGET_PATH });
    execSync('git add audits/*.md roadmap/*.md', { cwd: TARGET_PATH });
    execSync('git commit -m "chore(agent): review + tasks"', { cwd: TARGET_PATH });
    execSync('git push', { cwd: TARGET_PATH });
    console.log("Committed roadmap and audits.");
  } catch (err) {
    console.log("No changes to commit");
  }
}

async function readOptional(p: string): Promise<string> {
  try { return await fs.readFile(p, "utf8"); } catch { return ""; }
}

main().catch(err => { console.error(err); process.exit(1); });
