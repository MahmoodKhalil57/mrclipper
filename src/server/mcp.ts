// The Director's crew, as three MCP servers over the same workflow the canvas shows.
//   Transcriber   what the videos say and show, and the style reference     (read)
//   Planner       the workflow: its state, ▶ Run, one step, the outline and brief
//   Editor        takes: their clips, check scores and your reviews; clip edges
// The Director never reviews clips or applies outline changes: those are yours.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { startBrief, startCheck, startCoach, startDesign, startPick, startRefImport, startRefStyle, startRender, startTranscript } from "./actions";
import { readBrief } from "./agents/brief";
import { readCheck } from "./agents/check";
import { outlineState } from "./agents/outlines";
import { readReference, referenceText, setGuide } from "./agents/reference";
import { adjustClipEdges } from "./agents/take";
import { readVision } from "./agents/vision";
import { getJob, jobSummary, waitForJob, type Job } from "./jobs";
import { fmt } from "./lib";
import { OUTLINE_FILE, historyPaths, listRuns, listVideos, readText, readTranscript, rel, resolveVideo, runDir } from "./library";
import { feedbackDigest, readReview } from "./review";
import { LABEL, describeWorkflow, startWorkflow, workflowState, type NodeId } from "./workflow";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Wrap a handler so thrown errors come back as tool errors the model can read. */
const safe =
  <A,>(fn: (args: A) => Promise<unknown> | unknown) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  };

const started = (job: Job) => ({ job_id: job.id, status: job.status, title: job.title });

function jobStatusTool(server: McpServer) {
  server.registerTool(
    "job_status",
    {
      description:
        "Check any background job (a step or a ▶ Run). Blocks up to wait_seconds (max 50) for it to finish, then returns status, " +
        "progress (0-1), stage, recent log lines, and the result when done. Poll again while status is \"running\".",
      inputSchema: { job_id: z.string(), wait_seconds: z.number().min(0).max(50).optional() },
    },
    safe(async ({ job_id, wait_seconds }: { job_id: string; wait_seconds?: number }) => {
      if (!getJob(job_id)) throw new Error(`Unknown job ${job_id}`);
      return jobSummary((await waitForJob(job_id, wait_seconds ?? 45))!);
    }),
  );
}

const STEPS = ["transcript", "refstyle", "brief", "pick", "design", "render", "check", "coach"] as const;

export const AGENTS = {
  transcribe: {
    title: "Transcriber",
    blurb: "What the videos say and show: word-timed transcripts, shot-by-shot vision, and the style reference's profile.",
    build(server: McpServer) {
      server.registerTool(
        "list_videos",
        { description: "List source videos in the workspace with duration, transcript status and takes.", inputSchema: {} },
        safe(async () => (await listVideos()).map((v) => ({ ...v, duration: fmt(v.duration) }))),
      );
      server.registerTool(
        "read_transcript",
        {
          description: "Read transcript lines for a time window (seconds). Use it to check what's said around a clip.",
          inputSchema: { video: z.string(), from_s: z.number().optional(), to_s: z.number().optional(), max_lines: z.number().int().max(200).optional() },
        },
        safe(({ video, from_s = 0, to_s = Infinity, max_lines = 80 }: { video: string; from_s?: number; to_s?: number; max_lines?: number }) => {
          const segs = readTranscript(resolveVideo(video));
          if (!segs) throw new Error("No transcript yet; run the workflow (or the transcript step) first");
          return segs.filter((s) => s.end > from_s && s.start < to_s).slice(0, max_lines).map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
        }),
      );
      server.registerTool(
        "read_vision",
        {
          description:
            "Read the vision transcript for a time window: one line per shot with its kind, a short description, on-screen text, " +
            "and x (0-1) = where the main subject sits, which matters for 9:16 crops.",
          inputSchema: { video: z.string(), from_s: z.number().optional(), to_s: z.number().optional(), max_shots: z.number().int().max(200).optional() },
        },
        safe(({ video, from_s = 0, to_s = Infinity, max_shots = 60 }: { video: string; from_s?: number; to_s?: number; max_shots?: number }) => {
          const vt = readVision(resolveVideo(video));
          if (!vt) throw new Error("No vision transcript yet; run the workflow first");
          return vt.shots.filter((s) => s.end > from_s && s.start < to_s).slice(0, max_shots)
            .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.kind ?? "?"}: ${s.desc ?? ""}${s.text ? ` | text: ${s.text}` : ""} (x ${s.subject_x?.toFixed(2) ?? "?"})`).join("\n");
        }),
      );
      server.registerTool(
        "read_reference",
        { description: "The style reference (a finished clip to copy), its copy guide, and its analysed style profile and traits.", inputSchema: {} },
        safe(() => {
          const r = readReference();
          if (!r) return "No style reference set.";
          return r.analysis ? referenceText(r) : `Reference "${r.name}" (copy guide: ${r.guide || "none"}) isn't analysed yet; the Reference style step does that.`;
        }),
      );
      jobStatusTool(server);
    },
  },
  plan: {
    title: "Planner",
    blurb: "Runs the workflow: its state, ▶ Run, single steps, the outline, the brief, the style reference and the outline scores.",
    build(server: McpServer) {
      server.registerTool(
        "workflow_status",
        {
          description:
            "The workflow for a video: every node's state (ready, running, done, stale with why, waiting for the user, failed), " +
            "what ▶ Run would do next, and the takes. Call it first to ground yourself.",
          inputSchema: { video: z.string(), take: z.string().optional().describe("A take id; omit for the latest take") },
        },
        safe(({ video, take }: { video: string; take?: string }) => describeWorkflow(workflowState(video, take ?? null))),
      );
      server.registerTool(
        "run_workflow",
        {
          description:
            "▶ Run: do every step that isn't done, in order (transcribe, reference style, brief, then a take: pick → design → render → check), " +
            "stopping at Review for the user. After a finished review it runs the Coach. Returns a job_id; poll job_status.",
          inputSchema: {
            video: z.string(),
            take: z.string().optional(),
            direction: z.string().optional().describe("Direction for a new take, e.g. 'focus on the buffalo section'"),
            count: z.number().int().min(1).max(20).optional().describe("Number of clips for a new take (default: the outline's)"),
            new_take: z.boolean().optional().describe("Make a new take even if the current one is up to date"),
          },
        },
        safe((a: { video: string; take?: string; direction?: string; count?: number; new_take?: boolean }) => started(startWorkflow({ video: a.video, take: a.take, notes: a.direction, count: a.count, fresh: a.new_take }))),
      );
      server.registerTool(
        "run_step",
        {
          description:
            `Run one step on its own: ${STEPS.map((s) => `${s} (${LABEL[s]})`).join(", ")}. ` +
            "pick makes a new take (optionally with direction); design, render and check need a take id. Returns a job_id; poll job_status.",
          inputSchema: {
            step: z.enum(STEPS),
            video: z.string().optional(),
            take: z.string().optional(),
            direction: z.string().optional(),
            count: z.number().int().min(1).max(20).optional(),
            only: z.array(z.number().int()).optional().describe("render/check: just these clip ids"),
          },
        },
        safe((a: { step: (typeof STEPS)[number]; video?: string; take?: string; direction?: string; count?: number; only?: number[] }) => {
          const need = (x: string | undefined, what: string) => {
            if (!x) throw new Error(`${LABEL[a.step as NodeId]} needs a ${what}`);
            return x;
          };
          switch (a.step) {
            case "transcript": return started(startTranscript(need(a.video, "video")));
            case "refstyle": return started(startRefStyle());
            case "brief": return started(startBrief(need(a.video, "video")));
            case "pick": return started(startPick({ video: need(a.video, "video"), notes: a.direction, count: a.count }));
            case "design": return started(startDesign(need(a.take, "take")));
            case "render": return started(startRender({ run: need(a.take, "take"), only: a.only }));
            case "check": return started(startCheck({ run: need(a.take, "take"), only: a.only }));
            case "coach": return started(startCoach({ video: a.video, direction: a.direction }));
          }
        }),
      );
      server.registerTool(
        "read_outline",
        { description: "Read the outline: audience, tone, story and editing rules, and the settings the renderer reads.", inputSchema: {} },
        safe(() => readText(OUTLINE_FILE)),
      );
      server.registerTool(
        "update_outline",
        {
          description: "Replace the outline with new full markdown. Keep every '## ' section and '**Label:**' setting. Only when the user asks.",
          inputSchema: { content: z.string().min(50) },
        },
        safe(({ content }: { content: string }) => {
          writeFileSync(OUTLINE_FILE, content, "utf8");
          return `Saved ${rel(OUTLINE_FILE)}. The brief and the next take will follow it.`;
        }),
      );
      server.registerTool(
        "read_brief",
        { description: "The brief the LLM wrote for Jev from the outline and reference: pick questions, tones, gates, edit guidance, hook-card guidance, check rules.", inputSchema: { video: z.string() } },
        safe(({ video }: { video: string }) => readBrief(resolveVideo(video))?.brief ?? "No brief yet for this video; the Brief step writes it."),
      );
      server.registerTool(
        "read_feedback",
        { description: "The user's notes on transcript moments and their reviews of earlier takes (kept, dropped, comments).", inputSchema: { video: z.string() } },
        safe(({ video }: { video: string }) => feedbackDigest(resolveVideo(video)) || "No feedback yet."),
      );
      server.registerTool(
        "read_history",
        { description: "The clip history log (rendered clips and their posted performance), as referenced by the outline.", inputSchema: {} },
        safe(() => historyPaths(readText(OUTLINE_FILE)).map((p) => `## ${rel(p)}\n${readText(p).slice(-15000)}`).join("\n\n") || "No history yet."),
      );
      server.registerTool(
        "set_style_reference",
        {
          description:
            "Copy the style of another clip: a link to a finished short (TikTok, Reels, Shorts, YouTube) and/or a copy guide saying what to copy " +
            "(\"the captions and fast cuts\"). The workflow then analyses it and writes it into the brief. Returns a job_id when downloading.",
          inputSchema: { url: z.string().optional(), guide: z.string().optional() },
        },
        safe((a: { url?: string; guide?: string }) => {
          if (a.guide !== undefined) setGuide(a.guide);
          return a.url ? started(startRefImport(a.url)) : { reference: readReference()?.name ?? null, guide: a.guide };
        }),
      );
      server.registerTool(
        "outline_scores",
        { description: "Outline versions with their one-shot scores (0-100: how close their takes came to accepted as-is), and the coach's pending proposal.", inputSchema: {} },
        safe(() => {
          const s = outlineState();
          return {
            current: s.versions.find((v) => v.hash === s.current)?.label,
            versions: s.versions.map(({ label, source, takes, rated, mean }) => ({ label, source, takes, reviewed: rated, one_shot: mean })),
            pending: s.pending && { id: s.pending.id, hypothesis: s.pending.hypothesis, changes: s.pending.changes },
          };
        }),
      );
      jobStatusTool(server);
    },
  },
  extract: {
    title: "Editor",
    blurb: "Takes: their clips, edits, check scores and the user's reviews; moves clip edges when the user asks.",
    build(server: McpServer) {
      server.registerTool(
        "list_takes",
        { description: "List takes (newest first) with their clips, whether they're rendered, and the user's verdicts.", inputSchema: { video: z.string().optional() } },
        safe(({ video }: { video?: string }) => {
          const stem = video ? basename(resolveVideo(video)).replace(/\.[^.]+$/, "") : undefined;
          return listRuns().filter((r) => !stem || r.videoStem === stem).map((r) => {
            const review = readReview(r.id);
            return {
              take: r.id, created: r.created, review_finished: review.approved,
              clips: r.clips.map((c) => ({ id: c.id, title: c.title, start: fmt(c.start), end: fmt(c.end), rendered: !!c.file, verdict: review.clips[c.id]?.status ?? null })),
            };
          });
        }),
      );
      server.registerTool(
        "read_take",
        { description: "One take in detail: each clip's hook card, parts and moves, check scores (rules followed, edge warnings) and the user's comments.", inputSchema: { take: z.string() } },
        safe(({ take }: { take: string }) => {
          const r = listRuns().find((x) => x.id === take);
          if (!r) throw new Error(`No take ${take}`);
          const ck = readCheck(take);
          const rv = readReview(take);
          return r.clips.map((c) => {
            const k = ck?.clips[c.id];
            return {
              id: c.id, title: c.title, from: fmt(c.start), to: fmt(c.end), seconds: +(c.end - c.start).toFixed(1),
              hook_card: c.edit?.title ?? null,
              parts: c.edit?.segments.map((s) => `${fmt(s.start)}-${fmt(s.end)} ${s.zoom ?? "none"}${s.look ? ` ${s.look}` : ""}`) ?? [],
              transitions: c.edit?.transitions ?? [],
              check: k ? { rules_followed: k.followed, missed: (ck!.rules ?? []).filter((q) => (k.rules[q.key] ?? 1) < 0.4).map((q) => q.rule), edges: k.edges } : null,
              verdict: rv.clips[c.id]?.status ?? null,
              comments: (rv.clips[c.id]?.comments ?? []).map((x) => x.text),
            };
          });
        }),
      );
      server.registerTool(
        "adjust_clip",
        {
          description: "Move a clip's start/end (seconds from the source's start). The next render redoes only that clip. Only when the user asks.",
          inputSchema: { take: z.string(), clip_id: z.number().int(), start: z.number().optional(), end: z.number().optional() },
        },
        safe(({ take, clip_id, start, end }: { take: string; clip_id: number; start?: number; end?: number }) => {
          runDir(take);
          const r = adjustClipEdges(take, clip_id, { start, end });
          return { clip_id, start: fmt(r.start, "tenths"), end: fmt(r.end, "tenths"), seconds: +(r.end - r.start).toFixed(1), next: "run_step render (or run_workflow) to re-render it" };
        }),
      );
      server.registerTool(
        "read_clip_script",
        { description: "Read a take's full clip_script.md (hooks, reasons, transcript excerpts).", inputSchema: { take: z.string() } },
        safe(({ take }: { take: string }) => readText(join(runDir(take), "clip_script.md"))),
      );
      jobStatusTool(server);
    },
  },
} as const;

export type McpAgentKey = keyof typeof AGENTS;

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(agent: McpAgentKey, req: Request): Promise<Response> {
  const def = AGENTS[agent];
  const server = new McpServer({ name: `mrclipper-${agent}`, version: "2.0.0" }, { instructions: def.blurb });
  def.build(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
