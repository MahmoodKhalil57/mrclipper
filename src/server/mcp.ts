import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { startBrief, startCheck, startCoach, startDesign, startWatch, startExtract, startPlan, startTranscribe } from "./actions";
import { coachState } from "./agents/coach";
import { MODELS } from "./config";
import { getJob, jobSummary, waitForJob, type AgentName } from "./jobs";
import { feedbackDigest, readReview, readSettings } from "./review";
import { readVision } from "./agents/vision";
import {
  OUTLINE_FILE, historyPaths, listRuns, listVideos, readClipData, readText, readTranscript, rel,
  resolveVideo, runDir, writeClipData,
} from "./library";
import { fmt } from "./lib";

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

function statusTool(server: McpServer, name: string, agent: AgentName) {
  server.registerTool(
    name,
    {
      description:
        `Check a ${agent} job. Blocks up to wait_seconds (max 50) for it to finish, then returns status, ` +
        "progress (0-1), stage, recent log lines, and the result when done. Poll again while status is \"running\".",
      inputSchema: { job_id: z.string(), wait_seconds: z.number().min(0).max(50).optional() },
    },
    safe(async ({ job_id, wait_seconds }: { job_id: string; wait_seconds?: number }) => {
      if (!getJob(job_id)) throw new Error(`Unknown job ${job_id}`);
      return jobSummary((await waitForJob(job_id, wait_seconds ?? 45))!);
    }),
  );
}

export const AGENTS = {
  transcribe: {
    title: "Transcriber",
    blurb: "Audio: Gemini text on Whisper word timings. Vision: shot changes plus a label for every shot.",
    build(server: McpServer) {
      server.registerTool(
        "list_videos",
        { description: "List source videos in the project with duration, transcript status and clip runs.", inputSchema: {} },
        safe(async () => (await listVideos()).map((v) => ({ ...v, duration: fmt(v.duration) }))),
      );
      server.registerTool(
        "transcribe_video",
        {
          description:
            "Start transcribing a video (runs in the background, typically 1-4 minutes). Returns a job_id; " +
            "follow up with transcribe_status. Cached chunks are reused, so re-running only redoes missing parts.",
          inputSchema: {
            video: z.string().describe("File name, stem, or unique part of the name such as the YouTube id"),
            model: z.string().optional().describe(`Audio-capable OpenRouter model (default ${MODELS.transcribe})`),
            chunk_seconds: z.number().int().min(30).max(600).optional(),
            vision: z.boolean().optional().describe("Also build the vision transcript of what's on screen (default true)"),
          },
        },
        safe(async (args: { video: string; model?: string; chunk_seconds?: number; vision?: boolean }) => {
          const job = startTranscribe(args);
          return { job_id: job.id, status: job.status };
        }),
      );
      statusTool(server, "transcribe_status", "transcribe");
      server.registerTool(
        "read_transcript",
        {
          description: "Read transcript lines for a time window (seconds). Use it to check what's said around a clip.",
          inputSchema: {
            video: z.string(),
            from_s: z.number().optional(),
            to_s: z.number().optional(),
            max_lines: z.number().int().max(200).optional(),
          },
        },
        safe(({ video, from_s = 0, to_s = Infinity, max_lines = 80 }: { video: string; from_s?: number; to_s?: number; max_lines?: number }) => {
          const segs = readTranscript(resolveVideo(video));
          if (!segs) throw new Error("No transcript yet; run transcribe_video first");
          return segs
            .filter((s) => s.end > from_s && s.start < to_s)
            .slice(0, max_lines)
            .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`)
            .join("\n");
        }),
      );
      server.registerTool(
        "read_vision",
        {
          description:
            "Read the vision transcript for a time window: one line per shot with its kind (host_closeup, archival_photo, map, text_card, ...), " +
            "a short description, on-screen text, and x (0-1) = where the main subject sits, which matters for 9:16 crops.",
          inputSchema: { video: z.string(), from_s: z.number().optional(), to_s: z.number().optional(), max_shots: z.number().int().max(200).optional() },
        },
        safe(({ video, from_s = 0, to_s = Infinity, max_shots = 60 }: { video: string; from_s?: number; to_s?: number; max_shots?: number }) => {
          const vt = readVision(resolveVideo(video));
          if (!vt) throw new Error("No vision transcript yet; run transcribe_video (vision defaults on)");
          return vt.shots
            .filter((s) => s.end > from_s && s.start < to_s)
            .slice(0, max_shots)
            .map((s) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.kind ?? "?"}: ${s.desc ?? ""}${s.text ? ` | text: ${s.text}` : ""} (x ${s.subject_x?.toFixed(2) ?? "?"})`)
            .join("\n");
        }),
      );
    },
  },
  plan: {
    title: "Planner",
    blurb: "Reads the outline, clip history and transcript, then writes a clip script.",
    build(server: McpServer) {
      server.registerTool(
        "read_outline",
        { description: "Read clip_outline.md (audience, tone, clip count/length, history files).", inputSchema: {} },
        safe(() => readText(OUTLINE_FILE)),
      );
      server.registerTool(
        "update_outline",
        {
          description: "Replace clip_outline.md with new full markdown. Keep the bold setting labels intact. Only use when the user asks to change the outline.",
          inputSchema: { content: z.string().min(50) },
        },
        safe(({ content }: { content: string }) => {
          writeFileSync(OUTLINE_FILE, content, "utf8");
          return `Saved ${rel(OUTLINE_FILE)}`;
        }),
      );
      server.registerTool(
        "read_history",
        { description: "Read previous clip attempts and performance notes referenced by the outline.", inputSchema: {} },
        safe(() => historyPaths(readText(OUTLINE_FILE)).map((p) => `## ${rel(p)}\n${readText(p).slice(-15000)}`).join("\n\n") || "No history yet."),
      );
      server.registerTool(
        "plan_clips",
        {
          description:
            "Start planning clips for a transcribed video (background job, usually 20-90s). Writes clips/<run>/clip_script.md. " +
            "Returns a job_id; follow up with plan_status. Optional overrides beat the outline's settings.",
          inputSchema: {
            video: z.string(),
            count: z.number().int().min(1).max(20).optional(),
            min_len: z.number().int().optional(),
            max_len: z.number().int().optional(),
            notes: z.string().optional().describe("Extra direction for this run, e.g. 'focus on the buffalo section'"),
            engine: z.enum(["classic", "hybrid", "jev"]).optional().describe(
              "Override the user's engine setting. classic = LLM writes the plan; hybrid = an LLM compiles the outline into Jev's questions, Jev scores every candidate, then the LLM titles the picks; jev = System One with fixed questions (placeholder titles).",
            ),
          },
        },
        safe(async (args: { video: string; count?: number; min_len?: number; max_len?: number; notes?: string; engine?: "classic" | "hybrid" | "jev" }) => {
          const job = startPlan(args);
          return { job_id: job.id, status: job.status };
        }),
      );
      statusTool(server, "plan_status", "plan");
      server.registerTool(
        "compile_brief",
        {
          description:
            "Hybrid engine: have the LLM compile the outline into Jev's brief for a video (questions, weights, tones, gates, edit guidance). " +
            "Hybrid plans reuse it until the outline changes. Background job; follow up with plan_status.",
          inputSchema: { video: z.string() },
        },
        safe(({ video }: { video: string }) => ({ job_id: startBrief(video).id })),
      );
      server.registerTool(
        "coach_outline",
        {
          description:
            "Outline coach. It watches and listens to finished clips first (clip transcripts), then, by engine: LLM = one LLM call proposes a revised outline; " +
            "Hybrid = an LLM writes a rubric and candidate section rewrites, Jev rates every clip on every rule and picks the rewrites; System One = a Jev scorecard only. " +
            "Evidence is how the user reviewed takes (kept, dropped, 👍/👎, nudged, commented). The user applies proposals in the Coach node. " +
            "Background job; follow up with plan_status.",
          inputSchema: { video: z.string().optional(), direction: z.string().optional().describe("What the user wants the revision to focus on") },
        },
        safe((a: { video?: string; direction?: string }) => ({ job_id: startCoach(a).id })),
      );
      server.registerTool(
        "outline_scores",
        {
          description: "Outline versions with their one-shot scores (0-100: how close their takes came to approved as-is), and any pending coach proposal.",
          inputSchema: {},
        },
        safe(() => {
          const s = coachState();
          return {
            current: s.versions.find((v) => v.hash === s.current)?.label,
            versions: s.versions.map(({ label, source, takes, rated, mean }) => ({ label, source, takes, rated, one_shot: mean })),
            pending: s.pending && { id: s.pending.id, hypothesis: s.pending.hypothesis, changes: s.pending.changes },
          };
        }),
      );
      server.registerTool(
        "read_feedback",
        {
          description:
            "Read the user's own feedback for a video: comments pinned to transcript moments, comments on runs and clips, " +
            "and clips they kept or dropped. Check it before planning and whenever the user mentions their notes.",
          inputSchema: { video: z.string() },
        },
        safe(({ video }: { video: string }) => feedbackDigest(resolveVideo(video)) || "No feedback yet."),
      );
    },
  },
  extract: {
    title: "Editor",
    blurb: "Cuts clips from a clip script with ffmpeg: 9:16 crop, burned captions, history log.",
    build(server: McpServer) {
      server.registerTool(
        "list_runs",
        {
          description: "List clip runs (planned clip scripts) with their clips and which have been extracted.",
          inputSchema: { video: z.string().optional().describe("Filter by video") },
        },
        safe(({ video }: { video?: string }) => {
          const stem = video ? basename(resolveVideo(video)).replace(/\.[^.]+$/, "") : undefined;
          return listRuns()
            .filter((r) => !stem || r.videoStem === stem)
            .map((r) => {
              const review = readReview(r.id);
              return {
                run: r.id, created: r.created,
                approved: review.approved || !readSettings().requireApproval,
                clips: r.clips.map((c) => ({
                  id: c.id, title: c.title, start: fmt(c.start), end: fmt(c.end), extracted: !!c.file,
                  user: review.clips[c.id]?.status ?? null,
                })),
              };
            });
        }),
      );
      server.registerTool(
        "read_clip_script",
        { description: "Read the full clip_script.md of a run (hooks, reasons, transcript excerpts).", inputSchema: { run: z.string() } },
        safe(({ run }: { run: string }) => readText(join(runDir(run), "clip_script.md"))),
      );
      server.registerTool(
        "adjust_clip",
        {
          description: "Change a clip's start/end (seconds from video start) in the run's clip data before (re-)extracting.",
          inputSchema: { run: z.string(), clip_id: z.number().int(), start: z.number().optional(), end: z.number().optional() },
        },
        safe(({ run, clip_id, start, end }: { run: string; clip_id: number; start?: number; end?: number }) => {
          const script = join(runDir(run), "clip_script.md");
          const data = readClipData(script);
          const clip = data.clips.find((c) => c.id === clip_id);
          if (!clip) throw new Error(`No clip ${clip_id} in ${run}`);
          if (start !== undefined) clip.start = start;
          if (end !== undefined) clip.end = end;
          if (clip.end <= clip.start) throw new Error("end must be after start");
          writeClipData(script, data);
          return { clip_id, start: fmt(clip.start, "tenths"), end: fmt(clip.end, "tenths"), seconds: +(clip.end - clip.start).toFixed(1) };
        }),
      );
      server.registerTool(
        "extract_clips",
        {
          description:
            "Start cutting clips from a run with ffmpeg (background job, ~10-40s per clip). Returns a job_id; follow up with extract_status. " +
            "Defaults: all clips except ones the user dropped, 9:16 crop when the run targets 9:16, captions off. " +
            "Fails if the review gate is on and the user hasn't approved the run yet.",
          inputSchema: {
            run: z.string(),
            only: z.array(z.number().int()).optional().describe("Clip ids to cut; omit for all"),
            subs: z.boolean().optional().describe("Burn in captions from the transcript"),
            vertical: z.boolean().optional().describe("Force 9:16 crop on/off"),
          },
        },
        safe(async (args: { run: string; only?: number[]; subs?: boolean; vertical?: boolean }) => {
          const job = startExtract(args);
          return { job_id: job.id, status: job.status };
        }),
      );
      statusTool(server, "extract_status", "extract");
      server.registerTool(
        "watch_clips",
        {
          description: "Clip transcripts: listen to (Whisper) and watch (frame check + face detection) a take's finished clips, to see what was actually rendered. Background job; follow up with extract_status.",
          inputSchema: { run: z.string() },
        },
        safe(({ run }: { run: string }) => ({ job_id: startWatch(run).id })),
      );
      server.registerTool(
        "design_edits",
        {
          description:
            "Re-run edit design on a System One or Hybrid take: Jev picks each segment's camera move and each gap's transition from the outline's " +
            "allowed options (Hybrid also re-writes titles). Unapproves the take if it was approved. Background job; follow up with extract_status.",
          inputSchema: { run: z.string() },
        },
        safe(({ run }: { run: string }) => ({ job_id: startDesign(run).id })),
      );
      server.registerTool(
        "check_clips",
        {
          description:
            "Run a Jev (System One) pre-flight on a run's clips: scores whether each start/end is clean and suggests better lines nearby. " +
            "Suggestions only; nothing is changed. Background job (a few seconds); follow up with extract_status. Works for any run, in either engine mode.",
          inputSchema: { run: z.string(), only: z.array(z.number().int()).optional() },
        },
        safe(({ run, only }: { run: string; only?: number[] }) => ({ job_id: startCheck(run, only).id })),
      );
    },
  },
} as const;

export type McpAgentKey = keyof typeof AGENTS;

/** Stateless Streamable HTTP: a fresh server + transport per request. */
export async function handleMcp(agent: McpAgentKey, req: Request): Promise<Response> {
  const def = AGENTS[agent];
  const server = new McpServer({ name: `clipdesk-${agent}`, version: "1.0.0" }, { instructions: def.blurb });
  def.build(server);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}
