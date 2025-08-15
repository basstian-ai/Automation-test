import OpenAI from "openai";
function requireEnv(names) {
    for (const n of names) {
        if (!process.env[n]) {
            throw new Error(`Missing env: ${n}`);
        }
    }
}
export async function planRepo(input) {
    requireEnv(["OPENAI_API_KEY"]);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = process.env.PLANNER_MODEL || "gpt-5";
    const maxOutput = Number(process.env.MAX_OUTPUT_TOKENS || 1200);
    const system = [
        "You are an agnostic, milestone-driven project planner.",
        "Use only neutral terms (entities, records, admin area, REST endpoints).",
        `Do not suggest changes in protected paths: ${input.protected.join(", ")}.`,
        "If no vision is provided, continue without inventing one.",
        `Output sections in markdown with exact headings: \n` +
            "REPO_SUMMARY\n" +
            "STRUCTURE_FINDINGS\n" +
            "TOP_MILESTONE\n" +
            "TASKS\n" +
            "DONE_UPDATES",
        "STRUCTURE_FINDINGS must contain 3-7 bullets.",
        "TOP_MILESTONE is one of: Foundation, CRUD Admin, Public API, Dashboard, Import/Export, Auth, Polish.",
        `TASKS: cap at ${input.maxTasks}. Each task must have Title, Rationale, Acceptance, Files, Tests.`,
        "Reject micro-tasks unless they unblock the milestone."
    ].join("\n");
    const user = JSON.stringify({ manifest: input.manifest, roadmap: input.roadmap, vision: input.vision });
    const r = await client.chat.completions.create({
        model,
        temperature: 0.2,
        max_output_tokens: maxOutput,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user }
        ]
    });
    return r.choices[0]?.message?.content || "";
}
