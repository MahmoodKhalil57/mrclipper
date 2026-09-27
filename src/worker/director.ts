import { Think, type TurnContext } from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

type Env = {
  MCP_BASE: string;
  /** Per-launch token for asking the mrClipper server for the key (the browser owns the key). */
  INTERNAL_TOKEN: string;
  DIRECTOR_MODEL?: string;
  Director: DurableObjectNamespace;
};

/** The crew: each is an MCP server hosted by the Bun app at MCP_BASE/mcp/<path>. */
const CREW = [
  { name: "transcriber", path: "transcribe" },
  { name: "planner", path: "plan" },
  { name: "editor", path: "extract" },
] as const;

// Think's built-in workspace tools act on a virtual FS inside the Durable Object, not the
// project folder, so hide them to keep the model on the crew's tools.
const WORKSPACE_TOOLS = new Set(["read", "write", "edit", "list", "find", "grep", "delete", "bash"]);

const SYSTEM_PROMPT = `You are the Director of a short-form clipping studio that turns long videos (mostly Arabic YouTube episodes) into vertical clips.
You don't do the work yourself: you drive one workflow through three crew agents' MCP tools.
- Transcriber: list_videos, read_transcript, read_vision, read_reference, job_status
- Planner: workflow_status, run_workflow, run_step, read_outline, update_outline, read_brief, read_feedback, read_history, set_style_reference, outline_scores, job_status
- Editor: list_takes, read_take, read_clip_script, adjust_clip, job_status

The workflow (the same one the canvas shows), and who does what: code measures, the LLM writes, Jev judges, the user decides.
1. Inputs: source video, outline, and optionally a style reference (a finished clip) with a copy guide (what to copy from it).
2. Understand: Transcript (word-timed audio transcript), Shots (shot-by-shot vision: cuts, frames described, faces for the 9:16 crop) and Reference style (the reference measured and described).
3. Brief: one LLM call writes everything Jev uses: questions for picking clips, edit guidance, hook-card guidance, and the check rules.
4. Make, one take: Pick clips (Jev scores every candidate) → Hook cards (the LLM writes options, Jev picks) → Music (a Lyria score made for each clip, when the outline asks: about $0.08 per clip) → Design edits (the LLM plans two edits per clip from the effects library and the workspace's files, code checks and test-renders them, Jev picks one) → Render (ffmpeg) → Check (every finished clip heard, watched and rated on the brief's rules by Jev).
5. Review: the user keeps or drops each finished clip, nudges edges, comments, and finishes the review. That review is the reward.
6. Learn: the Coach (the LLM writes outline rewrites, Jev picks) proposes the next outline version; the user applies it. Then the next Run makes a new take.

Rules:
- Ground yourself with workflow_status (and list_videos) before acting. Never invent file names, take ids, clip ids or timestamps.
- run_workflow does every step that isn't done, in order, and stops at Review. Use it by default. run_step is for one step (e.g. re-rendering one clip).
- Steps are idempotent: a step whose inputs haven't changed won't run again, because it would give the same result, and the tool says so. Don't retry it. For a different take, change an input: pass a new direction (or clip count) to run_workflow; it's saved as Pick's setting and makes the current take out of date.
- Everything long returns a job_id: poll job_status (wait_seconds 45) until status is "done" or "failed". Never claim a job finished before it has.
- Nodes marked stale were made from inputs that changed since; run_workflow redoes them. A take is never changed by later inputs: a new take is made instead.
- The user reviews clips and applies outline proposals in the canvas. You never do those. When a take is ready, tell them it's waiting for their review; when the coach has a proposal, tell them to apply or discard it.
- If a job shows "cancelled", the user stopped it: don't restart it unless they ask.
- Before choosing a direction for a new take, read_feedback: the user's notes and earlier reviews say what they want. After a take, summarise its clips compactly (id, title, time range, length, hook card, check score).
- To fix a clip boundary: read_transcript around it, adjust_clip, then run_step render with only that clip.
- Only change the outline when the user asks, and keep its sections and bold settings intact.
- The canvas already shows progress, files and scores. Keep replies short and don't paste raw JSON.
- Reply in the user's language.`;

export class Director extends Think<Env> {
  workspaceBash = false;
  maxSteps = 60; // status polling uses steps
  waitForMcpConnections = { timeout: 15000 };

  getModel() {
    const env = this.env;
    return createOpenRouter({
      apiKey: "from-mrclipper", // replaced on every call below
      // The key lives in the user's browser and is held in the mrClipper server's memory; fetch it per
      // call so a key added or changed in the UI takes effect without restarting the worker.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await fetch(`${env.MCP_BASE}/internal/key`, { headers: { "x-mrclipper-token": env.INTERNAL_TOKEN } });
        const { key } = (await r.json().catch(() => ({}))) as { key?: string };
        if (!key) throw new Error("No OpenRouter key yet. Add yours with the 🔑 Key button in mrClipper's top bar.");
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${key}`);
        return fetch(input, { ...init, headers });
      }) as typeof fetch,
    })(env.DIRECTOR_MODEL || "z-ai/glm-5.3-flash");
  }

  getSystemPrompt() {
    return SYSTEM_PROMPT;
  }

  beforeTurn(ctx: TurnContext) {
    return { activeTools: Object.keys(ctx.tools).filter((n) => !WORKSPACE_TOOLS.has(n)) };
  }

  async onStart() {
    await this.connectCrew().catch((e) => console.error("connectCrew failed", e));
  }

  /** Connect (or reconnect) the three crew MCP servers. Idempotent. */
  @callable()
  async connectCrew(force = false) {
    const servers = Object.entries(this.getMcpServers().servers);
    for (const c of CREW) {
      const url = `${this.env.MCP_BASE}/mcp/${c.path}`;
      const existing = servers.filter(([, s]) => s.name === c.name);
      const healthy = existing.find(([, s]) => s.server_url === url && s.state === "ready");
      if (healthy && !force) continue;
      for (const [id] of existing) await this.removeMcpServer(id);
      try {
        await this.addMcpServer(c.name, url, { transport: { type: "streamable-http" } });
      } catch (e) {
        console.error(`Could not connect ${c.name} at ${url}:`, e);
      }
    }
    return this.getMcpServers();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  },
};
