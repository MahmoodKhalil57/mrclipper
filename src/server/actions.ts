// One starter per workflow step, shared by the canvas, the Run button (workflow.ts) and the Director's
// MCP tools, so every path gets the same checks and de-duplication. Job names match the canvas nodes.
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { buildBrief } from "./agents/brief";
import { checkTake } from "./agents/check";
import { coachOutline } from "./agents/coach";
import { designEdits } from "./agents/design";
import { pickClips } from "./agents/pick";
import { analyzeReference, newReference, pendingGuide, readReference, saveReference } from "./agents/reference";
import { renderTake, type RenderInput } from "./agents/render";
import { transcribe } from "./agents/transcribe";
import { VIDEOS_DIR, toolPath } from "./config";
import { listJobs, startJob, type AgentName, type Job } from "./jobs";
import { readTranscript, rel, resolveVideo, runDir } from "./library";
import { run } from "./lib";

/** Reuse a running job with identical input instead of starting a duplicate. */
function runningDuplicate(agent: AgentName, input: unknown): Job | undefined {
  const key = JSON.stringify(input);
  return listJobs().find((j) => j.agent === agent && j.status === "running" && JSON.stringify(j.input) === key);
}

/** yt-dlp into a folder; returns the saved file. */
async function download(ctx: Parameters<Parameters<typeof startJob>[3]>[0], url: string, outDir: string, template: string) {
  let file = "";
  // yt-dlp merges video and audio with ffmpeg; ours may not be on PATH (the desktop app's, or one in .store/tools).
  const ffmpeg = toolPath("ffmpeg");
  const r = await run(
    [toolPath("yt-dlp"), "--newline", "--progress", "--no-playlist", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4",
      ...(isAbsolute(ffmpeg) ? ["--ffmpeg-location", ffmpeg] : []),
      "-o", join(outDir, template), "--print", "after_move:filepath", url],
    {
      signal: ctx.signal,
      onStdout: (line) => {
        const m = line.match(/\[download\]\s+([\d.]+)%.*?(?:\s+ETA\s+(\S+))?/);
        if (m) ctx.progress((Number(m[1]) / 100) * 0.97, `downloading ${m[1]}%${m[2] ? ` · ETA ${m[2]}` : ""}`);
        else if (/^\[(Merger|ExtractAudio|FixupM3u8)\]/.test(line)) ctx.progress(0.98, "merging audio and video");
        else if (/^[A-Z]:[\\/]|^\//.test(line.trim())) file = line.trim();
        if (/^(WARNING|ERROR)/.test(line)) ctx.log(line, line.startsWith("ERROR") ? "error" : "warn");
      },
    },
  );
  if (r.code !== 0 || !file) throw new Error(`yt-dlp failed: ${(r.stderr || r.stdout).slice(-400)}`);
  return file;
}

// ── 1 · Inputs ──────────────────────────────────────────────────────

/** Source video from a link, into videos/. */
export function startSourceImport(url: string): Job {
  if (!/^https?:\/\//i.test(url)) throw new Error("Paste a full http(s) link");
  const outDir = VIDEOS_DIR;
  mkdirSync(outDir, { recursive: true });
  return runningDuplicate("source", { url }) ?? startJob("source", `Import ${url}`, { url }, async (ctx) => {
    ctx.progress(0.01, "starting download");
    const file = await download(ctx, url, outDir, "%(title)s [%(id)s].%(ext)s");
    ctx.log(`Saved ${rel(file)}`);
    return { video: basename(file), path: rel(file) };
  });
}

/** Reference clip from a link (TikTok, Reels, Shorts, YouTube…). */
export function startRefImport(url: string): Job {
  if (!/^https?:\/\//i.test(url)) throw new Error("Paste a full http(s) link");
  return runningDuplicate("refclip", { url }) ?? startJob("refclip", `Reference from ${url}`, { url }, async (ctx) => {
    const { id, dir, guide } = newReference("");
    ctx.progress(0.02, "downloading the reference");
    const file = await download(ctx, url, dir, "%(title).80s [%(id)s].%(ext)s");
    saveReference({ id, name: basename(file), file: rel(file), source: url, at: Date.now(), guide: guide || pendingGuide() });
    ctx.log(`Reference saved: ${basename(file)}`);
    return { reference: id, name: basename(file) };
  });
}

// ── 2 · Understand ──────────────────────────────────────────────────

export function startTranscript(ref: string): Job {
  const video = resolveVideo(ref);
  const input = { video: basename(video) };
  return runningDuplicate("transcript", input) ?? startJob("transcript", `Transcribe ${basename(video)}`, input, (ctx) => transcribe(ctx, video, input));
}

export function startRefStyle(): Job {
  if (!readReference()) throw new Error("Add a reference clip first.");
  return runningDuplicate("refstyle", {}) ?? startJob("refstyle", "Reference style", {}, (ctx) => analyzeReference(ctx));
}

// ── 3 · Brief ───────────────────────────────────────────────────────

export function startBrief(ref: string): Job {
  const video = resolveVideo(ref);
  if (!readTranscript(video)?.length) throw new Error("The brief reads a transcript sample; transcribe the video first.");
  const input = { video: basename(video) };
  return runningDuplicate("brief", input) ?? startJob("brief", `Brief for ${basename(video)}`, input, (ctx) => buildBrief(ctx, video));
}

// ── 4 · Make ────────────────────────────────────────────────────────

export function startPick(args: { video: string; notes?: string; count?: number }): Job {
  const video = resolveVideo(args.video);
  if (!readTranscript(video)) throw new Error("No transcript yet. Transcribe the video first.");
  const input = { video: basename(video), ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}), ...(args.count ? { count: args.count } : {}) };
  return runningDuplicate("pick", input) ?? startJob("pick", `Pick clips from ${basename(video)}`, input, (ctx) => pickClips(ctx, video, input));
}

export function startDesign(run: string): Job {
  runDir(run);
  return runningDuplicate("design", { run }) ?? startJob("design", "Design edits", { run }, (ctx) => designEdits(ctx, run));
}

export function startRender(args: RenderInput): Job {
  runDir(args.run);
  const label = args.only?.length ? `clips ${args.only.join(", ")}` : "the take";
  return runningDuplicate("render", args) ?? startJob("render", `Render ${label}`, { ...args }, (ctx) => renderTake(ctx, args));
}

export function startCheck(args: { run: string; only?: number[] }): Job {
  runDir(args.run);
  return runningDuplicate("check", args) ?? startJob("check", "Check clips", { ...args }, (ctx) => checkTake(ctx, args.run, { only: args.only }));
}

// ── 6 · Learn ───────────────────────────────────────────────────────

export function startCoach(args: { video?: string; direction?: string }): Job {
  const video = args.video ? basename(resolveVideo(args.video)) : undefined;
  const input = { ...(video ? { video } : {}), ...(args.direction?.trim() ? { direction: args.direction.trim() } : {}) };
  return runningDuplicate("coach", input) ?? startJob("coach", "Coach the outline", input, (ctx) => coachOutline(ctx, input));
}
