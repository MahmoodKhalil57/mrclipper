// Job starters shared by the MCP crew (Director) and the UI's own buttons, so both paths
// get the same validation, de-duplication and review gate.
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { extractClips, type ExtractInput } from "./agents/extract";
import { planClips, planFromAgent, type PlanInput } from "./agents/plan";
import { planClipsJev } from "./agents/plan-jev";
import { checkRun } from "./agents/qa-jev";
import { designEdits } from "./agents/design";
import { buildBrief } from "./agents/plan-jev";
import { coachOutline } from "./agents/coach";
import { coachOutlineJev } from "./agents/coach-jev";
import { buildRubric } from "./agents/rubric";
import { watchClips } from "./agents/watch";
import { transcribe, type TranscribeInput } from "./agents/transcribe";
import { ROOT } from "./config";
import { listJobs, startJob, type AgentName, type Job } from "./jobs";
import { readText, readTranscript, rel, resolveVideo, runDir } from "./library";
import { run } from "./lib";
import { readReview, readSettings } from "./review";

/** Reuse a running job with identical input instead of starting a duplicate. */
function runningDuplicate(agent: AgentName, input: unknown): Job | undefined {
  const key = JSON.stringify(input);
  return listJobs().find((j) => j.agent === agent && j.status === "running" && JSON.stringify(j.input) === key);
}

export function startTranscribe(args: TranscribeInput): Job {
  const video = resolveVideo(args.video);
  const input = { ...args, video: basename(video) };
  return runningDuplicate("transcribe", input) ??
    startJob("transcribe", `Transcribe ${basename(video)}`, input, (ctx) => transcribe(ctx, video, args));
}

export function startPlan(args: PlanInput & { engine?: "classic" | "hybrid" | "jev" | "webmcp" }): Job {
  const video = resolveVideo(args.video);
  if (!readTranscript(video)) throw new Error("No transcript yet. Transcribe the video first.");
  const engine = args.engine ?? readSettings().engine;
  if (engine === "webmcp") {
    throw new Error(
      "In WebMCP mode the server doesn't plan: the agent in your browser reads the transcripts through the page's tools and calls submit_plan.",
    );
  }
  const input = { ...args, video: basename(video), engine };
  const label = engine === "jev" ? "Plan clips (Jev)" : engine === "hybrid" ? "Plan clips (Hybrid)" : "Plan clips";
  return startJob("plan", `${label} for ${basename(video)}`, input, (ctx) =>
    engine === "jev" || engine === "hybrid" ? planClipsJev(ctx, video, { ...args, hybrid: engine === "hybrid" }) : planClips(ctx, video, args),
  );
}

/** WebMCP mode: validate and save a plan written by the browser agent. */
export function startAgentPlan(args: { video: string; clips: any[]; direction?: string; agent?: string }): Job {
  const video = resolveVideo(args.video);
  if (!readTranscript(video)) throw new Error("No transcript yet. Run prepare_video first.");
  if (!Array.isArray(args.clips) || !args.clips.length) throw new Error("clips must be a non-empty array");
  const input = { video: basename(video), engine: "webmcp", agent: args.agent ?? null, clips: args.clips.length };
  return startJob("plan", `Plan from ${args.agent || "browser agent"} for ${basename(video)}`, input, async (ctx) => planFromAgent(ctx, video, args));
}

/** Edit design: Jev picks camera moves and transitions for a take (and, in Hybrid, the LLM writes titles). */
export function startDesign(run: string, hybrid?: boolean): Job {
  runDir(run);
  const eng = JSON.parse(readText(join(runDir(run), "engine.json")) || "{}").engine ?? "classic";
  if (eng === "classic" || eng === "webmcp") {
    throw new Error(`This take's edits were written by ${eng === "classic" ? "the LLM" : "your browser agent"}; edit design runs on System One and Hybrid takes.`);
  }
  const h = hybrid ?? eng === "hybrid";
  return runningDuplicate("design", { run }) ?? startJob("design", `Design edits${h ? " (Hybrid)" : ""}`, { run }, (ctx) => designEdits(ctx, run, { hybrid: h }));
}

/** The Brief node: compile the outline into Jev's brief for a video (Hybrid). */
export function startBrief(ref: string): Job {
  const video = resolveVideo(ref);
  if (!readTranscript(video)?.length) throw new Error("The brief samples the transcript; transcribe the video first.");
  const input = { video: basename(video) };
  return runningDuplicate("brief", input) ?? startJob("brief", `Brief for ${basename(video)}`, input, (ctx) => buildBrief(ctx, video).then((b) => ({ questions: b.opener.length + b.ending.length + b.window.length, source: b.source })));
}

/**
 * The Outline coach: propose a revised outline from how the takes went.
 * LLM engine: one LLM call. Hybrid: the Rubric (LLM) then Jev judges. System One: Jev scorecard only.
 */
export function startCoach(args: { video?: string; direction?: string }): Job {
  const video = args.video ? basename(resolveVideo(args.video)) : undefined;
  const engine = readSettings().engine;
  if (engine === "webmcp") throw new Error("The Outline coach needs OpenRouter; WebMCP mode makes no hosted-model calls.");
  const input = { video, direction: args.direction?.trim() || undefined };
  const label = engine === "classic" ? "Coach the outline (LLM)" : engine === "hybrid" ? "Coach the outline (Rubric + Jev)" : "Score the outline (Jev)";
  return runningDuplicate("coach", input) ?? startJob("coach", label, input, (ctx) =>
    engine === "classic" ? coachOutline(ctx, input) : coachOutlineJev(ctx, { ...input, hybrid: engine === "hybrid" }),
  );
}

/** Clip transcript: listen to and watch a take's finished clips. */
export function startWatch(run: string, force = false): Job {
  runDir(run);
  return runningDuplicate("watch", { run }) ?? startJob("watch", "Clip transcripts", { run }, (ctx) => watchClips(ctx, run, { force }));
}

/** The Rubric node on its own (Hybrid coach): the LLM's rules and rewrites for Jev. */
export function startRubric(args: { video?: string; direction?: string }): Job {
  const video = args.video ? basename(resolveVideo(args.video)) : undefined;
  const input = { video, direction: args.direction?.trim() || undefined };
  return runningDuplicate("rubric", input) ?? startJob("rubric", "Rubric for the coach", input, (ctx) => buildRubric(ctx, input));
}

/** Jev pre-flight on a run's clip edges. Suggestions only; nothing is changed. */
export function startCheck(run: string, only?: number[]): Job {
  runDir(run);
  const input = { run, only, check: true };
  return runningDuplicate("extract", input) ?? startJob("extract", "Jev edge check", input, (ctx) => checkRun(ctx, run, only));
}

export class ApprovalRequired extends Error {}

export function startExtract(args: ExtractInput): Job {
  runDir(args.run);
  if (readSettings().requireApproval && !readReview(args.run).approved) {
    throw new ApprovalRequired(
      `Run "${args.run}" hasn't been approved yet. The review gate is on: the user must approve the plan ` +
        "in the Review node (they can drop or adjust clips first). Tell them it's waiting for approval.",
    );
  }
  const label = args.only?.length ? `clips ${args.only.join(", ")}` : "all clips";
  const jev = ["jev", "hybrid"].includes(readSettings().engine);
  return runningDuplicate("extract", args) ??
    startJob("extract", `Cut ${label}`, args, async (ctx) => {
      // System One mode: a quick Jev pre-flight logs edge warnings first. It never blocks or edits the cut.
      if (jev) {
        ctx.progress(0, "Jev pre-flight");
        await checkRun({ ...ctx, progress: () => {} }, args.run, args.only).catch((e) => {
          if (ctx.signal.aborted) throw e;
          ctx.log(`Jev pre-flight skipped: ${e instanceof Error ? e.message : e}`, "warn");
        });
      }
      return extractClips(ctx, args);
    });
}

/** Download a video with the project's yt-dlp into downloads/. */
export function startImport(url: string): Job {
  if (!/^https?:\/\//i.test(url)) throw new Error("Paste a full http(s) link");
  const bundled = join(ROOT, "tools", "yt-dlp.exe");
  const ytdlp = existsSync(bundled) ? bundled : "yt-dlp";
  const outDir = join(ROOT, "downloads");
  mkdirSync(outDir, { recursive: true });

  return runningDuplicate("import", { url }) ?? startJob("import", `Import ${url}`, { url }, async (ctx) => {
    ctx.progress(0.01, "starting download");
    let file = "";
    const r = await run(
      [
        ytdlp, "--newline", "--progress", "--no-playlist",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b", "--merge-output-format", "mp4",
        "-o", join(outDir, "%(title)s [%(id)s].%(ext)s"),
        "--print", "after_move:filepath",
        url,
      ],
      {
        signal: ctx.signal,
        onStdout: (line) => {
          const m = line.match(/\[download\]\s+([\d.]+)%.*?(?:at\s+(\S+))?(?:\s+ETA\s+(\S+))?/);
          if (m) ctx.progress(Number(m[1]) / 100 * 0.97, `downloading ${m[1]}%${m[3] ? ` · ETA ${m[3]}` : ""}`);
          else if (/^\[(Merger|ExtractAudio|FixupM3u8)\]/.test(line)) ctx.progress(0.98, "merging audio and video");
          else if (/^[A-Z]:[\\/]|^\//.test(line.trim())) file = line.trim();
          if (/^(WARNING|ERROR)/.test(line)) ctx.log(line, line.startsWith("ERROR") ? "error" : "warn");
        },
      },
    );
    if (r.code !== 0 || !file) throw new Error(`yt-dlp failed: ${(r.stderr || r.stdout).slice(-400)}`);
    ctx.log(`Saved ${rel(file)}`);
    return { video: basename(file), path: rel(file) };
  });
}
