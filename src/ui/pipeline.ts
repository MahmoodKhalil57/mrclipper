// Derive the node-graph state for one project (a source video) from the files on disk and live jobs.
import type { Clip, Engine, Job, Library, OutlineVersion, Proposal, Rubric, Run, Scorecard, Video } from "./api";

export type NodeState = "locked" | "ready" | "running" | "waiting" | "done" | "failed" | "stopped";
export type StageKey = "source" | "outline" | "transcribe" | "brief" | "plan" | "design" | "review" | "cut" | "clips" | "watch" | "rubric" | "coach";

/** A bold-label setting from the outline ("- **Label:** value"). */
export const outlineSetting = (outline: string, label: string) =>
  outline.match(new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*\\s*(.+)`))?.[1].trim();

export type Pipeline = {
  video: Video;
  runs: Run[];
  run: Run | null;
  gate: boolean;
  engine: Engine;
  source: { state: NodeState };
  outline: { state: NodeState; text: string };
  transcribe: { state: NodeState; job?: Job; chunks: { total: number; done: number } };
  /** LLM node: the outline compiled into Jev's brief. Used by the Hybrid engine. */
  brief: { state: NodeState; job?: Job; active: boolean };
  plan: { state: NodeState; job?: Job };
  /** Edit design: Jev's camera moves and transitions. "by" says who designed the take's edits. */
  design: { state: NodeState; job?: Job; by: "jev" | "llm" | "agent" | null; decisions: number };
  review: { state: NodeState; kept: number; dropped: number; comments: number };
  cut: { state: NodeState; job?: Job; cut: number; total: number; current?: number };
  clips: { state: NodeState; files: { id: number; title: string; file: string }[] };
  /** LLM node: learns a better outline from how the takes were reviewed, and feeds it back. */
  /** Transcriber on the finished clips: what was actually rendered, heard and seen. */
  watch: { state: NodeState; job?: Job; clips: Clip[]; watched: number };
  /** LLM node before the Jev coach (Hybrid): rules for Jev and candidate rewrites. */
  rubric: { state: NodeState; job?: Job; active: boolean; rubric: Rubric | null };
  coach: { state: NodeState; job?: Job; versions: OutlineVersion[]; current?: OutlineVersion; pending: Proposal | null; scorecard: Scorecard | null; by: "llm" | "jev" | "hybrid" | null };
};

const CHUNK = 120;

/** Most recent job of `agent` that matches. Jobs arrive newest-first. */
const latest = (jobs: Job[], agent: Job["agent"], match: (j: Job) => boolean) =>
  jobs.find((j) => j.agent === agent && match(j));

function jobState(job: Job | undefined): NodeState | null {
  if (!job) return null;
  return job.status === "running" ? "running" : job.status === "failed" ? "failed" : job.status === "cancelled" ? "stopped" : null;
}

export function derivePipeline(video: Video, lib: Library, jobs: Job[], runId: string | null): Pipeline {
  const runs = lib.runs.filter((r) => r.videoStem === video.stem);
  const run = runs.find((r) => r.id === runId) ?? runs[0] ?? null;
  const gate = lib.settings?.requireApproval ?? true;

  // Transcribe
  const tJob = latest(jobs, "transcribe", (j) => j.input.video === video.name);
  const total = Math.max(1, Math.ceil(video.duration / CHUNK));
  let tState: NodeState = video.transcript ? "done" : "ready";
  const tJobState = jobState(tJob);
  if (tJobState === "running" || (!video.transcript && tJobState)) tState = tJobState;
  // Only the audio phase maps onto chunk cells; timing and vision phases have their own counters.
  const stageCount = tJob?.status === "running" && /^transcribing/.test(tJob.stage) ? tJob.stage.match(/(\d+)\/(\d+)/) : null;
  const chunksDone = video.transcript && tState !== "running" ? total : stageCount ? Number(stageCount[1]) : 0;

  // Plan
  const pJob = latest(jobs, "plan", (j) => j.input.video === video.name);
  let pState: NodeState = !video.transcript ? "locked" : run ? "done" : "ready";
  const pJobState = jobState(pJob);
  if (pJobState === "running" || (!run && video.transcript && pJobState)) pState = pJobState;

  // Brief (LLM): compiled on its own, or by a Hybrid plan when missing or stale.
  const engine = lib.settings?.engine ?? "classic";
  const bJob = latest(jobs, "brief", (j) => j.input.video === video.name);
  const planBriefing = pState === "running" && /brief/i.test(pJob?.stage ?? "");
  let bState: NodeState = !video.transcript ? "locked" : video.brief?.fresh ? "done" : engine === "hybrid" ? "ready" : "locked";
  const bJobState = jobState(bJob);
  if (planBriefing) bState = "running";
  else if (bJobState === "running" || (bJobState && bJob!.finishedAt! > (video.brief?.at ?? 0))) bState = bJobState ?? bState;

  // Edit design: runs at the end of a System One / Hybrid plan, or on its own (Redesign).
  const dJob = run ? latest(jobs, "design", (j) => j.input.run === run.id) : undefined;
  const designBy = !run ? null : run.engine === "classic" ? "llm" : run.engine === "webmcp" ? "agent" : "jev";
  const planDesigning = pState === "running" && /design/.test(pJob?.stage ?? "");
  let dState: NodeState = !run || (pState === "running" && !planDesigning) ? "locked" : designBy !== "jev" || run.design ? "done" : "ready";
  if (planDesigning) dState = "running";
  const dJobState = jobState(dJob);
  if (dJobState === "running" || (dJobState && dState !== "locked" && dJob!.finishedAt! > (run?.design?.at ?? 0))) dState = dJobState ?? dState;
  const decisions = run?.design ? Object.values(run.design.clips).reduce((n, c) => n + c.zooms.length + c.transitions.length, 0) : 0;

  // Review (the gate)
  const verdicts = run ? Object.values(run.review.clips) : [];
  const dropped = verdicts.filter((c) => c.status === "drop").length;
  const comments = run ? run.review.comments.length + verdicts.reduce((n, c) => n + c.comments.length, 0) : 0;
  const approved = !!run && (run.review.approved || !gate);
  const revState: NodeState = !run || pState === "running" || dState === "running" ? "locked" : approved ? "done" : "waiting";

  // Cut
  const kept = run ? run.clips.filter((c) => run.review.clips[c.id]?.status !== "drop") : [];
  const cutCount = kept.filter((c) => c.file).length;
  const cJob = run ? latest(jobs, "extract", (j) => j.input.run === run.id) : undefined;
  let cState: NodeState = !approved ? "locked" : kept.length && cutCount === kept.length ? "done" : "ready";
  const cJobState = jobState(cJob);
  if (cJobState === "running" || (cState !== "done" && cJobState && approved)) cState = cJobState;
  const current = cJob?.status === "running" ? Number(cJob.stage.match(/clip (\d+)/)?.[1]) || undefined : undefined;

  const files = (run?.clips ?? []).filter((c) => c.file).map((c) => ({ id: c.id, title: c.title, file: c.file! }));

  // Outline coach: waiting when it has a proposal for the current outline.
  const coach = lib.coach;
  const coJob = latest(jobs, "coach", () => true);
  const coachStage = coJob?.status === "running" ? coJob.stage : "";

  // Clip transcript of this take's finished clips (the coach also runs it for its evidence).
  const cutClips = (run?.clips ?? []).filter((c) => c.file);
  const watched = cutClips.filter((c) => c.watch?.fresh).length;
  const wJob = run ? latest(jobs, "watch", (j) => j.input.run === run.id) : undefined;
  let wState: NodeState = !cutClips.length ? "locked" : watched === cutClips.length ? "done" : "ready";
  if (/watch/i.test(coachStage)) wState = "running";
  else if (jobState(wJob) === "running" || (jobState(wJob) && wState !== "done")) wState = jobState(wJob)!;

  // Rubric (LLM), Hybrid only.
  const rJob = latest(jobs, "rubric", () => true);
  const rubricActive = engine === "hybrid";
  let rState: NodeState = !rubricActive || !lib.runs.length ? "locked" : coach?.rubric?.fresh && coach.rubric.source === "llm" ? "done" : "ready";
  if (rubricActive && /rubric/i.test(coachStage)) rState = "running";
  else if (jobState(rJob) === "running" || (jobState(rJob) && rJob!.finishedAt! > (coach?.rubric?.at ?? 0))) rState = jobState(rJob)!;
  let coState: NodeState = !lib.runs.length ? "locked" : coach?.pending ? "waiting" : "ready";
  const coJobState = jobState(coJob);
  if (coJobState === "running" || (coJobState && coJob!.finishedAt! > (coach?.proposals[0]?.at ?? 0))) coState = coJobState ?? coState;

  return {
    video, runs, run, gate, engine,
    source: { state: "done" },
    outline: { state: lib.outline.trim() ? "done" : "ready", text: lib.outline },
    transcribe: { state: tState, job: tJob, chunks: { total, done: chunksDone } },
    brief: { state: bState, job: planBriefing ? pJob : bJob, active: engine === "hybrid" },
    plan: { state: pState, job: pJob },
    design: { state: dState, job: dJob?.status === "running" ? dJob : planDesigning ? pJob : dJob, by: designBy, decisions },
    review: { state: revState, kept: (run?.clips.length ?? 0) - dropped, dropped, comments },
    cut: { state: cState, job: cJob, cut: cutCount, total: kept.length, current },
    clips: { state: files.length ? "done" : "locked", files },
    watch: { state: wState, job: /watch/i.test(coachStage) ? coJob : wJob, clips: cutClips, watched },
    rubric: { state: rState, job: rubricActive && /rubric/i.test(coachStage) ? coJob : rJob, active: rubricActive, rubric: coach?.rubric ?? null },
    coach: {
      state: coState, job: coJob, versions: coach?.versions ?? [], pending: coach?.pending ?? null,
      current: coach?.versions.find((v) => v.hash === coach.current),
      scorecard: coach?.scorecard ?? null,
      by: engine === "classic" ? "llm" : engine === "hybrid" ? "hybrid" : engine === "jev" ? "jev" : null,
    },
  };
}

/** The one thing the user should do next, for the guide strip. */
export function nextStep(p: Pipeline): { stage: StageKey; text: string } {
  if (p.transcribe.state === "running") return { stage: "transcribe", text: "Transcribing. Watch the chunks fill in, or open the node to read along." };
  if (p.transcribe.state !== "done") return { stage: "transcribe", text: "Start by transcribing the video. Everything after this reads the transcript." };
  if (p.plan.state === "running") return { stage: "plan", text: "The Planner is choosing clips from the transcript." };
  if (!p.run) return { stage: "plan", text: "Plan clips. The Planner follows your outline, history and comments." };
  if (p.design.state === "running") return { stage: "design", text: "Jev is choosing each clip's camera moves and transitions." };
  if (p.design.state === "ready") return { stage: "design", text: "This take has no edit design yet. Let Jev design its camera moves and transitions." };
  if (p.review.state === "waiting") return { stage: "review", text: "Your turn: review the plan. Drop clips, nudge their edges, comment, then approve." };
  if (p.cut.state === "running") return { stage: "cut", text: "The Editor is cutting clips with ffmpeg." };
  if (p.cut.state !== "done") return { stage: "cut", text: "Approved. Cut the clips." };
  if (p.coach.state === "waiting") return { stage: "coach", text: "The Outline coach proposed a revised outline. Read the diff, apply it, and plan a new take with it." };
  return { stage: "clips", text: "Clips are ready. Keep, drop and comment, then ask the Outline coach to learn a better outline from it." };
}
