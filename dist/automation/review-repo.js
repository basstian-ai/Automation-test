import { promises as fs } from "fs";
import path from "node:path";
import crypto from "node:crypto";
import { planRepo } from "./prompt.js";
const TARGET_PATH = process.env.TARGET_PATH || "target";
const MAX_FILES = parseInt(process.env.MAX_FILES || "800", 10);
const MAX_BYTES_PER_FILE = parseInt(process.env.MAX_BYTES_PER_FILE || "50000", 10);
const MAX_TASKS = parseInt(process.env.MAX_TASKS_PER_RUN || "5", 10);
const PROTECTED_PATHS = JSON.parse(process.env.PROTECTED_PATHS || "[]");
const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    ".next",
    ".vercel",
    ".turbo",
    ".cache",
    "dist",
    "build",
    "out",
    "coverage",
    ".pnpm-store"
]);
const TEXT_EXT = /\.(md|txt|js|jsx|ts|tsx|json|yaml|yml|html|css|mjs|cjs|py|java|go|rb|sh|c|cpp|cs)$/i;
function dirSignature(entries) {
    const sig = entries.filter(Boolean).sort().join("|");
    return crypto.createHash("md5").update(sig).digest("hex");
}
async function scanRepo(root) {
    const entriesTop = await fs.readdir(root, { withFileTypes: true });
    const topLevel = entriesTop.filter(e => e.isDirectory()).map(e => e.name);
    const files = [];
    let fileCount = 0;
    let dirCount = 0;
    const byBasename = new Map();
    async function walk(cur) {
        const entries = await fs.readdir(cur, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(cur, e.name);
            const rel = path.relative(root, full).replace(/\\/g, "/");
            if (IGNORE_DIRS.has(e.name))
                continue;
            if (e.isDirectory()) {
                dirCount++;
                let childNames = [];
                try {
                    childNames = await fs.readdir(full);
                }
                catch { }
                const sig = dirSignature(childNames);
                const arr = byBasename.get(e.name) || [];
                arr.push({ path: rel, sig });
                byBasename.set(e.name, arr);
                await walk(full);
            }
            else if (e.isFile()) {
                fileCount++;
                if (files.length < Math.min(MAX_FILES, 600) && TEXT_EXT.test(e.name)) {
                    try {
                        const buf = await fs.readFile(full, "utf8");
                        files.push({ path: rel, sample: buf.slice(0, MAX_BYTES_PER_FILE) });
                    }
                    catch { }
                }
            }
        }
    }
    await walk(root);
    const duplicates = Array.from(byBasename.entries())
        .flatMap(([base, arr]) => {
        const bySig = new Map();
        for (const { path: p, sig } of arr) {
            bySig.set(sig, [...(bySig.get(sig) || []), p]);
        }
        return Array.from(bySig.values())
            .filter(v => v.length > 1)
            .map(members => ({ base, members }));
    });
    return { topLevel, fileCount, dirCount, duplicates, files };
}
async function writeFileSafe(p, content) {
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
        console.log(`Duplicate dirs: ${manifest.duplicates.map(d => d.base).join(", ")}`);
    }
    const auditPath = path.join(TARGET_PATH, "audits", "repo-structure.md");
    const dupLines = manifest.duplicates.length
        ? manifest.duplicates.flatMap(d => [`- ${d.base}`, ...d.members.map(m => `  - ${m}`)])
        : ["- none"];
    const auditContent = [
        `# Repo Structure`,
        `Scanned ${manifest.fileCount} files across ${manifest.dirCount} directories.`,
        "",
        "## Top-level",
        ...manifest.topLevel.map(d => `- ${d}`),
        "",
        "## Duplicate dir candidates",
        ...dupLines
    ].join("\n");
    await writeFileSafe(auditPath, auditContent);
    const roadmapDir = path.join(TARGET_PATH, "roadmap");
    const roadmapFresh = await readOr(path.join(roadmapDir, "new.md"));
    const roadmapTasks = await readOr(path.join(roadmapDir, "tasks.md"));
    const visionLocal = await readOr(path.join(TARGET_PATH, "vision.md"));
    const visionRoadmap = await readOr(path.join(roadmapDir, "vision.md"));
    const vision = visionLocal || visionRoadmap;
    if (visionLocal)
        console.log("found vision.md");
    else if (visionRoadmap)
        console.log("found roadmap/vision.md");
    else
        console.log("no vision file");
    const plan = await planRepo({
        manifest,
        roadmap: { tasks: roadmapTasks, fresh: roadmapFresh, vision },
        maxTasks: MAX_TASKS,
        protected: PROTECTED_PATHS,
    });
    const required = ["REPO_SUMMARY", "STRUCTURE_FINDINGS", "TOP_MILESTONE", "TASKS"];
    const ok = required.every(h => plan.includes(h));
    if (!ok)
        throw new Error("Planner output missing required sections");
    await writeFileSafe(path.join(roadmapDir, "new.md"), plan);
    const taskCount = (plan.match(/^\s*-/mg) || []).length;
    console.log(`roadmap/new.md tasks: ${taskCount}`);
}
async function readOr(p) {
    try {
        return await fs.readFile(p, "utf8");
    }
    catch {
        return "";
    }
}
main().catch(err => { console.error(err); process.exit(1); });
