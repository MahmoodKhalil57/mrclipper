import { Think, type TurnContext } from "@cloudflare/think";
import { callable, routeAgentRequest } from "agents";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

type Env = {
  MCP_BASE: string;
  /** Per-launch token for asking the Clipdesk server for the key (the browser owns the key). */
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
You never do the work yourself. You delegate to three crew agents through their MCP tools:
- Transcriber: list_videos, transcribe_video, transcribe_status, read_transcript, read_vision
- Planner: read_outline, update_outline, read_history, read_feedback, compile_brief, plan_clips, plan_status, coach_outline, outline_scores
- Editor: list_runs, read_clip_script, adjust_clip, check_clips, design_edits, extract_clips, extract_status

Pipeline: source video -> transcript -> clip script ("run" in clips/) -> clip files.

Rules:
- Ground yourself first with list_videos and/or list_runs. Never invent file names, run ids, clip ids or timestamps.
- transcribe_video, plan_clips and extract_clips start background jobs and return a job_id. Keep calling the matching *_status tool (wait_seconds 45) until status is "done" or "failed". Never claim a job finished before its status says so.
- A video needs a transcript before planning. If it has none, transcribe it first. Transcribing also builds a vision transcript (what's on screen, shot by shot); both planners read it. Use read_vision when the user asks what a moment looks like or whether it works as a vertical crop.
- Before planning, call read_feedback. The user leaves comments on transcript moments, runs and clips in the canvas; treat them as direction.
- After planning, give a compact list: id, title, time range, length, one-line hook.
- The review gate: when it's on, extract_clips fails until the user approves the run in the canvas's Review node. Don't retry around it. Tell the user the plan is waiting for their approval, and that they can drop clips, nudge edges or comment there first.
- The user can also start, stop and edit work themselves in the canvas. If a job shows status "cancelled", they stopped it on purpose: don't restart it unless they ask.
- Extract with captions (subs: true) unless the user says otherwise.
- Two engines run the crew, chosen by the user in the top bar: "classic" (an LLM writes the plan) and "jev" (TypeSafe's Jev, a System One model: it scores every candidate moment with typed decisions and code ranks them). Jev plans have placeholder titles like "Shocking fact · 21:37" and score breakdowns instead of prose reasons; describe them by their opening line and scores. A third engine, "hybrid", has an LLM compile the outline into Jev's questions first and write titles for the picks at the end. Only pass engine to plan_clips when the user asks for a specific one. System One and Hybrid plans are followed by an edit-design step (Jev picks camera moves and transitions); design_edits re-runs it on a take. The loop closes with the Outline coach: after the user reviews takes, coach_outline proposes a revised outline scored by its takes (outline_scores); the user applies it, never you.
- check_clips runs a Jev edge check on any run and returns suggestions. Offer the suggestions; the user applies them in Review or asks you to adjust_clip.
- To fix a clip boundary, check the words with read_transcript, then adjust_clip, then re-extract only that clip.
- Only change the outline when the user asks, and keep its bold setting labels intact.
- The UI already shows tool calls, job progress and files. Keep replies short and don't paste raw JSON.
- Reply in the user's language.`;

export class Director extends Think<Env> {
  workspaceBash = false;
  maxSteps = 60; // status polling uses steps
  waitForMcpConnections = { timeout: 15000 };

  getModel() {
    const env = this.env;
    return createOpenRouter({
      apiKey: "from-clipdesk", // replaced on every call below
      // The key lives in the user's browser and is held in the Clipdesk server's memory; fetch it per
      // call so a key added or changed in the UI takes effect without restarting the worker.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const r = await fetch(`${env.MCP_BASE}/internal/key`, { headers: { "x-clipdesk-token": env.INTERNAL_TOKEN } });
        const { key } = (await r.json().catch(() => ({}))) as { key?: string };
        if (!key) throw new Error("No OpenRouter key yet. Add yours with the 🔑 Key button in Clipdesk's top bar.");
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
