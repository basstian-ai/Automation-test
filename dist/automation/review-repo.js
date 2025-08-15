import { promises as fs } from "fs";
import path from "node:path";
import crypto from "node:crypto";
import { planRepo } from "./prompt.js";
const TARGET_PATH = process.env.TARGET_PATH || "target";
const MAX_FILES = Number(process.env.MAX_FILES || 180);
const MAX_SAMPLED_FILES = Number(process.env.MAX_SAMPLED_FILES || 80);
const MAX_BYTES = Number(process.env.MAX_BYTES_PER_FILE || 1500);
const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 80000);
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
    const files = [];
    const dirs = [];
    const byBasename = new Map();
    async function walk(cur) {
        const entries = await fs.readdir(cur, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(cur, e.name);
            const rel = path.relative(root, full).replace(/\\/g, "/");
            if (IGNORE_DIRS.has(e.name))
                continue;
            if (e.isDirectory()) {
                dirs.push({ path: rel });
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
                try {
                    const stat = await fs.stat(full);
                    let sample;
                    if (TEXT_EXT.test(e.name)) {
                        try {
                            const buf = await fs.readFile(full, "utf8");
                            sample = buf.slice(0, MAX_BYTES);
                        }
                        catch { }
                    }
                    files.push({ path: rel, size: stat.size, sample });
                }
                catch { }
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
    return { files, dirs, duplicates };
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
    const { files, dirs, duplicates } = await scanRepo(TARGET_PATH);
    console.log(`Scanned ${files.length} files in ${dirs.length} dirs`);
    if (duplicates.length) {
        console.log(`Duplicate dirs: ${duplicates.map(d => d.base).join(", ")}`);
    }
    const topLevel = dirs.filter(d => !d.path.includes(path.sep)).map(d => d.path);
    const auditPath = path.join(TARGET_PATH, "audits", "repo-structure.md");
    const dupLines = duplicates.length
        ? duplicates.flatMap(d => [`- ${d.base}`, ...d.members.map(m => `  - ${m}`)])
        : ["- none"];
    const auditContent = [
        `# Repo Structure`,
        `Scanned ${files.length} files across ${dirs.length} directories.`,
        "",
        "## Top-level",
        ...topLevel.map(d => `- ${d}`),
        "",
        "## Duplicate dir candidates",
        ...dupLines
    ].join("\n");
    await writeFileSafe(auditPath, auditContent);
    // PRIORITIZE routes/config/docs; sample only a subset
    const PRIORITY = [
        /^package\.json$/i,
        /^tsconfig\.json$/i,
        /^next\.config\.(js|ts|mjs|cjs)$/i,
        /^readme\.md$/i,
        /^roadmap\/[^/]+\.md$/i,
        /^(app|pages)\//i,
        /^src\/(app|pages|api|lib|components|routes)\//i
    ];
    const score = (p) => {
        for (let i = 0; i < PRIORITY.length; i++)
            if (PRIORITY[i].test(p))
                return i;
        return PRIORITY.length;
    };
    const sorted = files.slice().sort((a, b) => score(a.path) - score(b.path) || b.size - a.size);
    const head = sorted.slice(0, MAX_FILES);
    const sampled = new Set(head.slice(0, MAX_SAMPLED_FILES).map(f => f.path));
    const manifestFiles = head.map(f => ({
        path: f.path,
        size: f.size,
        sample: (sampled.has(f.path) && f.sample)
            ? f.sample.slice(0, MAX_BYTES)
            : undefined
    }));
    let manifest = {
        stats: {
            files: files.length,
            dirs: dirs.length,
            protectedPaths: PROTECTED_PATHS,
        },
        topLevel,
        duplicates,
        files: manifestFiles
    };
    // Trim roadmap/vision inputs and enforce a global budget
    const trim = (s, n) => (s && s.length > n ? s.slice(0, n) : (s || ""));
    const READ_LIMIT = 8000;
    const readOr = async (p) => { try {
        return trim(await fs.readFile(p, "utf8"), READ_LIMIT);
    }
    catch {
        return "";
    } };
    const roadmapDir = path.join(TARGET_PATH, "roadmap");
    const roadmapFresh = await readOr(path.join(roadmapDir, "new.md"));
    const roadmapTasks = await readOr(path.join(roadmapDir, "tasks.md"));
    const vision = await (async () => {
        for (const rel of ["vision.md", "roadmap/vision.md"]) {
            try {
                return { path: rel, content: trim(await fs.readFile(path.join(TARGET_PATH, rel), "utf8"), READ_LIMIT) };
            }
            catch { }
        }
        return { path: "", content: "" };
    })();
    const sizeOf = (obj) => JSON.stringify(obj).length
        + roadmapFresh.length + roadmapTasks.length + vision.content.length;
    while (sizeOf(manifest) > MAX_INPUT_CHARS) {
        const idx = manifest.files.findLastIndex((f) => !!f.sample);
        if (idx === -1)
            break;
        manifest.files[idx].sample = undefined;
    }
    console.log(`[review] vision doc: ${vision.path || "none"}`);
    const plan = await planRepo({
        manifest,
        roadmap: { tasks: roadmapTasks, fresh: roadmapFresh },
        vision,
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
main().catch(err => { console.error(err); process.exit(1); });
