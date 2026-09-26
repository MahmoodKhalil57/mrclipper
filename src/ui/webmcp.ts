// WebMCP mode: Clipdesk as a deterministic workflow shell for whatever agent runs in the browser.
// The page registers tools with document.modelContext (Chrome 149+, chrome://flags/#enable-webmcp-testing).
// The agent does the thinking (planning, labelling shots); the server only runs deterministic steps
// (captions import, shot detection, ffmpeg) and enforces the rules (snapping, lengths, overlaps, the
// review gate). There is no approve tool: approval stays with the human.
import { useSyncExternalStore } from "react";
import { fileUrl, getJSON, type Job, type Library, type Run } from "./api";
import { derivePipeline, nextStep } from "./pipeline";

type Json = Record<string, unknown>;
type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
type ToolDef = {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean; untrustedContentHint?: boolean };
  run: (input: any, signal?: AbortSignal) => Promise<unknown>;
};

export type CallLog = { id: number; tool: string; input: unknown; output?: string; error?: string; at: number; ms?: number; by: "agent" | "you" };

// ── call log store (for the Agent panel) ────────────────────────────

let calls: CallLog[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function useCallLog() {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => calls);
}
let nextId = 1;

// ── HTTP helpers ───────────────────────────────────────────────────

async function req<T = any>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `HTTP ${r.status}: ${String(text).slice(0, 200)}`);
  return data;
}

const lib = () => getJSON<Library>("/api/library");
const jobs = () => getJSON<Job[]>("/api/jobs");
const runOf = async (id: string): Promise<Run> => {
  const r = (await lib()).runs.find((x) => x.id === id);
  if (!r) throw new Error(`No take "${id}". Call list_takes first.`);
  return r;
};
const summarizeJob = (j: Job) => ({
  job_id: j.id, status: j.status, progress: +j.progress.toFixed(2), stage: j.stage, error: j.error,
  result: j.status === "done" ? j.result : undefined,
  recent_log: j.log.slice(-6).map((l) => `${l.level}: ${l.msg}`),
});
const video = { type: "string", description: "Video file name, stem, or its YouTube id" };

// ── the tools ─────────────────────────────────────────────────────

export const AGENT_BRIEF = `You are operating Clipdesk, a workflow for cutting short vertical clips from long videos.
Clipdesk is deterministic: it runs ffmpeg, captions import and validation. You do the judgement.

Workflow (call get_workflow any time to see where each video stands):
1. add_video_from_url (optional) -> job_status until done
2. prepare_video: audio transcript (existing, or YouTube captions) + shot detection and frames. No AI is used.
3. (optional) get_unlabelled_shots -> look at the frames -> label_shots, so the vision transcript has labels
4. read_outline, read_feedback, read_history, then read_transcript / read_vision in windows to choose moments
5. submit_plan with your clips (start/end in seconds). Clipdesk snaps them to line boundaries and enforces the
   outline's length range and no overlaps; it tells you which clips were rejected and why.
6. The human reviews and approves the take in Clipdesk. You cannot approve. cut_clips fails until they do.
7. cut_clips, then job_status until done. Use adjust_clip and comment to refine.
Rules: never invent timestamps; read the transcript around a moment before choosing it; keep the human informed.`;

export const TOOLS: ToolDef[] = [
  {
    name: "get_workflow",
    description: "Where every video is in the Clipdesk pipeline, what the next step is, and the rules. Start here.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const [l, js] = await Promise.all([lib(), jobs()]);
      return {
        brief: AGENT_BRIEF,
        review_gate: l.settings.requireApproval ? "on: the human must approve a take before cutting" : "off",
        running_jobs: js.filter((j) => j.status === "running").map(summarizeJob),
        videos: l.videos.map((v) => {
          const p = derivePipeline(v, l, js, null);
          return {
            video: v.name, duration_s: Math.round(v.duration),
            transcript: v.transcript ? `${v.transcript.segments} lines` : "none",
            vision: v.vision ? `${v.vision.shots} shots, ${v.vision.labelled} labelled` : "none",
            takes: p.runs.map((r) => ({ run: r.id, created: r.created, clips: r.clips.length, approved: r.review.approved, cut: r.clips.filter((c) => c.file).length })),
            stages: { transcript: p.transcribe.state, plan: p.plan.state, review: p.review.state, cut: p.cut.state },
            next: nextStep(p).text,
          };
        }),
      };
    },
  },
  {
    name: "list_videos",
    description: "List source videos with duration and transcript/vision status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => (await lib()).videos.map((v) => ({ video: v.name, duration_s: Math.round(v.duration), transcript: v.transcript?.segments ?? 0, shots: v.vision?.shots ?? 0, takes: v.runs.length })),
  },
  {
    name: "add_video_from_url",
    description: "Download a video (e.g. a YouTube link) into the project. Returns a job_id; poll job_status.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    run: ({ url }) => req("/api/import", "POST", { url }),
  },
  {
    name: "prepare_video",
    description: "Deterministic preparation: keeps an existing transcript or imports YouTube captions with word timings, then detects shots and grabs one frame per shot. No AI. Returns a job_id.",
    inputSchema: { type: "object", properties: { video }, required: ["video"] },
    run: ({ video }) => req("/api/jobs", "POST", { agent: "transcribe", args: { video } }),
  },
  {
    name: "job_status",
    description: "Check a job. Waits up to wait_seconds (max 50) for it to finish. Poll again while status is running.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" }, wait_seconds: { type: "number", maximum: 50 } }, required: ["job_id"] },
    annotations: { readOnlyHint: true },
    run: async ({ job_id, wait_seconds = 30 }, signal) => {
      const until = Date.now() + Math.min(50, Math.max(0, wait_seconds)) * 1000;
      for (;;) {
        const j = (await jobs()).find((x) => x.id === job_id);
        if (!j) throw new Error(`Unknown job ${job_id}`);
        if (j.status !== "running" || Date.now() >= until || signal?.aborted) return summarizeJob(j);
        await new Promise((r) => setTimeout(r, 1500));
      }
    },
  },
  {
    name: "stop_job",
    description: "Stop a running job.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    run: ({ job_id }) => req(`/api/jobs/${job_id}/cancel`, "POST"),
  },
  {
    name: "read_outline",
    description: "The editor's outline: audience, tone, clip count and length, aspect ratio.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => (await lib()).outline,
  },
  {
    name: "read_feedback",
    description: "The human's comments on transcript moments, takes and clips, and which clips they kept or dropped. Follow it.",
    inputSchema: { type: "object", properties: { video }, required: ["video"] },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    run: ({ video }) => req(`/api/feedback?video=${encodeURIComponent(video)}`),
  },
  {
    name: "read_history",
    description: "Log of previously cut clips with the human's performance notes.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const h = (await lib()).history[0];
      return h ? req(`/api/file?path=${encodeURIComponent(h.path)}`) : "No history yet.";
    },
  },
  {
    name: "read_transcript",
    description: "Audio transcript lines with measured start/end seconds for a time window.",
    inputSchema: {
      type: "object",
      properties: { video, from_s: { type: "number" }, to_s: { type: "number" }, max_lines: { type: "number", maximum: 200 } },
      required: ["video"],
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    run: async ({ video, from_s = 0, to_s = Infinity, max_lines = 120 }) => {
      const { segments } = await req(`/api/transcript?video=${encodeURIComponent(video)}`);
      if (!segments.length) throw new Error("No transcript yet. Run prepare_video.");
      const rows = segments.filter((s: any) => s.end > from_s && s.start < to_s).slice(0, Math.min(200, max_lines));
      return rows.map((s: any) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join("\n") || "No lines in that window.";
    },
  },
  {
    name: "read_vision",
    description: "Vision transcript for a time window: one line per shot (kind, description, on-screen text, x = subject position 0-1).",
    inputSchema: {
      type: "object",
      properties: { video, from_s: { type: "number" }, to_s: { type: "number" }, max_shots: { type: "number", maximum: 200 } },
      required: ["video"],
    },
    annotations: { readOnlyHint: true },
    run: async ({ video, from_s = 0, to_s = Infinity, max_shots = 80 }) => {
      const vt = await req(`/api/vision?video=${encodeURIComponent(video)}`);
      if (!vt.shots?.length) throw new Error("No shots yet. Run prepare_video.");
      return vt.shots
        .filter((s: any) => s.end > from_s && s.start < to_s)
        .slice(0, Math.min(200, max_shots))
        .map((s: any) => `[${s.start.toFixed(2)}-${s.end.toFixed(2)}] #${s.id} ${s.kind ?? "unlabelled"}${s.desc ? `: ${s.desc}` : ""}${s.text ? ` | text: ${s.text}` : ""}${s.subject_x !== undefined ? ` (x ${s.subject_x.toFixed(2)})` : ""}`)
        .join("\n");
    },
  },
  {
    name: "get_unlabelled_shots",
    description: "Shots that still need a label, with frame URLs (and the frames as images if include_images). Label them with label_shots.",
    inputSchema: {
      type: "object",
      properties: { video, limit: { type: "number", maximum: 24 }, include_images: { type: "boolean" } },
      required: ["video"],
    },
    annotations: { readOnlyHint: true },
    run: async ({ video, limit = 12, include_images = false }) => {
      const r = await req(`/api/webmcp/shots?video=${encodeURIComponent(video)}&limit=${limit}`);
      const shots = r.shots.map((s: any) => ({ id: s.id, start: s.start, end: s.end, frame_url: new URL(fileUrl(s.frame), location.href).href }));
      const text = { type: "text" as const, text: JSON.stringify({ total: r.total, unlabelled: r.unlabelled, shots, kinds: ["host_closeup", "host_wide", "broll_footage", "archival_photo", "map", "graphic", "text_card", "animation", "other"] }, null, 1) };
      if (!include_images) return { content: [text] } satisfies ToolResult;
      const images = await Promise.all(shots.map(async (s: any) => {
        const blob = await (await fetch(s.frame_url)).blob();
        const data = await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(",")[1]);
          fr.readAsDataURL(blob);
        });
        return [{ type: "text" as const, text: `Shot #${s.id}` }, { type: "image" as const, data, mimeType: "image/jpeg" }];
      }));
      return { content: [text, ...images.flat()] } satisfies ToolResult;
    },
  },
  {
    name: "label_shots",
    description: "Save your labels for shots (from get_unlabelled_shots). kind must be one of the listed kinds; subject_x is 0 (left) to 1 (right).",
    inputSchema: {
      type: "object",
      properties: {
        video,
        labels: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "number" }, kind: { type: "string" }, desc: { type: "string" }, text: { type: "string" }, subject_x: { type: "number" }, people: { type: "number" } },
            required: ["id", "kind", "desc"],
          },
        },
      },
      required: ["video", "labels"],
    },
    run: ({ video, labels }) => req("/api/webmcp/labels", "POST", { video, labels }),
  },
  {
    name: "submit_plan",
    description: "Submit your clip plan for a video. Clipdesk snaps clips to transcript line boundaries, enforces the outline's length range and no overlaps, saves a take for the human to review, and reports rejected clips. Returns a job_id.",
    inputSchema: {
      type: "object",
      properties: {
        video,
        clips: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "number", description: "seconds from the video start" },
              end: { type: "number" },
              title: { type: "string" },
              hook: { type: "string", description: "why the first 3 seconds grab attention" },
              reason: { type: "string", description: "why it fits the audience and tone" },
              on_screen_text: { type: "string", description: "short caption, in the video's language" },
              edit_notes: { type: "string" },
              edit: {
                type: "object",
                description: "Optional creative edit, following the outline's Story/Editing/Effects/Captions/Title sections. Without it Clipdesk builds a default (pauses removed, jump-cut zoom).",
                properties: {
                  segments: {
                    type: "array",
                    description: "Source ranges in play order (a cold open may put the payoff first). Total length must fit the outline.",
                    items: {
                      type: "object",
                      properties: {
                        start: { type: "number" }, end: { type: "number" },
                        role: { type: "string", enum: ["hook", "setup", "payoff", "context"] },
                        zoom: { type: "string", enum: ["none", "punch_in", "slow_push", "ken_burns", "zoom_out", "drift"] },
                        look: { type: "string", enum: ["none", "bw", "sepia"], description: "flashback look, if the outline allows it" },
                        speed: { type: "number", minimum: 0.8, maximum: 1.5 },
                        reframe_x: { type: "number", minimum: 0, maximum: 1 },
                      },
                      required: ["start", "end"],
                    },
                  },
                  transitions: { type: "array", items: { type: "string", enum: ["cut", "crossfade", "dip_black", "slide", "zoom", "whip", "flash", "iris", "blur"] } },
                  title: { type: "string", description: "hook card in the video's language" },
                  emphasis: { type: "array", items: { type: "string" }, description: "exact words to highlight" },
                },
              },
            },
            required: ["start", "end", "title"],
          },
        },
        direction: { type: "string", description: "what you were aiming for with this take" },
        agent: { type: "string", description: "your name, for the take's credits" },
      },
      required: ["video", "clips"],
    },
    run: (a) => req("/api/webmcp/plan", "POST", a),
  },
  {
    name: "list_takes",
    description: "Takes (clip plans) for a video with approval and cut status.",
    inputSchema: { type: "object", properties: { video }, required: ["video"] },
    annotations: { readOnlyHint: true },
    run: async ({ video: v }) => {
      const l = await lib();
      const vid = l.videos.find((x) => x.name === v || x.stem === v || x.name.includes(v));
      if (!vid) throw new Error(`No video matching "${v}"`);
      return l.runs.filter((r) => r.videoStem === vid.stem).map((r) => ({
        run: r.id, created: r.created, engine: r.engine, approved: r.review.approved,
        clips: r.clips.map((c) => ({ id: c.id, title: c.title, start: c.start, end: c.end, cut: !!c.file, human: r.review.clips[c.id]?.status ?? null })),
      }));
    },
  },
  {
    name: "read_take",
    description: "The full clip script of a take (hooks, reasons, transcript excerpts).",
    inputSchema: { type: "object", properties: { run: { type: "string" } }, required: ["run"] },
    annotations: { readOnlyHint: true },
    run: async ({ run }) => req(`/api/file?path=${encodeURIComponent((await runOf(run)).script)}`),
  },
  {
    name: "adjust_clip",
    description: "Change a clip's start/end (seconds) or title in a take. Check read_transcript around the edge first.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, clip_id: { type: "number" }, start: { type: "number" }, end: { type: "number" }, title: { type: "string" } },
      required: ["run", "clip_id"],
    },
    run: ({ run, clip_id, ...patch }) => req(`/api/runs/${encodeURIComponent(run)}/clip/${clip_id}`, "POST", patch),
  },
  {
    name: "comment",
    description: "Leave a note on a take or one of its clips for the human (shown as from the agent).",
    inputSchema: { type: "object", properties: { run: { type: "string" }, clip_id: { type: "number" }, text: { type: "string" } }, required: ["run", "text"] },
    run: ({ run, clip_id, text }) => req(`/api/runs/${encodeURIComponent(run)}/comment`, "POST", { text, clip: clip_id, by: "agent" }),
  },
  {
    name: "cut_clips",
    description: "Render a take's clips with ffmpeg (9:16 crop and captions by default). Fails while the review gate is on and the human hasn't approved the take. Returns a job_id.",
    inputSchema: {
      type: "object",
      properties: { run: { type: "string" }, only: { type: "array", items: { type: "number" } }, captions: { type: "boolean" }, vertical: { type: "boolean" } },
      required: ["run"],
    },
    annotations: { consequentialHint: true },
    run: ({ run, only, captions = true, vertical = true }) => req("/api/jobs", "POST", { agent: "extract", args: { run, only, subs: captions, vertical } }),
  },
];

// ── execution + registration ──────────────────────────────────────

function toResult(value: unknown): ToolResult {
  if (value && typeof value === "object" && Array.isArray((value as any).content)) return value as ToolResult;
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] };
}

/** Run a tool and log it. Used by the browser agent (via WebMCP) and the Agent panel's manual runner. */
export async function callTool(name: string, input: unknown, by: "agent" | "you", signal?: AbortSignal): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const entry: CallLog = { id: nextId++, tool: name, input, at: Date.now(), by };
  calls = [entry, ...calls].slice(0, 200);
  emit();
  const t0 = performance.now();
  try {
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const result = toResult(await tool.run(input ?? {}, signal));
    const text = result.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
    calls = calls.map((c) => (c.id === entry.id ? { ...c, output: text, ms: Math.round(performance.now() - t0) } : c));
    emit();
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    calls = calls.map((c) => (c.id === entry.id ? { ...c, error: msg, ms: Math.round(performance.now() - t0) } : c));
    emit();
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

export const webmcpAvailable = () => typeof document !== "undefined" && "modelContext" in document;

/** Register every tool with the browser. Returns an unregister function. */
export async function registerTools(): Promise<() => void> {
  const mc = (document as any).modelContext;
  if (!mc?.registerTool) return () => {};
  const controller = new AbortController();
  for (const t of TOOLS) {
    await mc.registerTool(
      {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
        // Implementations differ on whether input arrives bare or as { params }; accept both.
        async execute(arg: any, opts?: { signal?: AbortSignal }) {
          const input = arg && typeof arg === "object" && "params" in arg && Object.keys(arg).length === 1 ? arg.params : arg;
          return callTool(t.name, input, "agent", opts?.signal);
        },
      },
      { signal: controller.signal },
    );
  }
  return () => controller.abort();
}
