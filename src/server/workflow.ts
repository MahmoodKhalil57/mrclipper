// The workflow: thirteen nodes in six phases, one rule for who does what.
//
//   1 Inputs      Source video · Outline · Reference clip · Copy guide           (you)
//   2 Understand  Transcript · Reference style                                   (Transcriber: code + perception models)
//   3 Brief       Brief                                                          (LLM writes)
//   4 Make        Pick clips · Design edits · Render · Check                     (Jev judges, code assembles)
//   5 Review      Review                                                         (you)
//   6 Learn       Coach → the next Outline version                               (LLM writes, Jev picks, you apply)
//
// Every node's state is computed here, the same way for all of them, from what's on disk and which
// jobs are running: empty/optional (an input you haven't given), locked (waiting on an earlier node),
// ready, running, done, stale (an input changed since it was made; Run redoes it), waiting (your turn),
// failed or stopped. ▶ Run does every step that isn't done, in order, and stops at Review.
//
// Steps are idempotent: each output records fingerprints of the inputs it was made from, and a step is
// done while they still match. A done step won't run again (stepUpToDate says why), because it would
// give the same result; changing one of its inputs is what makes it run.
import { existsSync, readFileSync } from "node:fs";
import { basename, join, parse } from "node:path";
import { startBrief, startCheck, startCoach, startDesign, startPick, startRefStyle, startRender, startTranscript } from "./actions";
import { briefInputs, readBrief } from "./agents/brief";
import { checkStatus, readCheck } from "./agents/check";
import { coachInputs } from "./agents/coach";
import { designInputs } from "./agents/design";
import { outlineState } from "./agents/outlines";
import { pendingGuide, readReference } from "./agents/reference";
import { renderStatus } from "./agents/render";
import { hashText } from "./agents/text";
import { pickInputs, readPickSettings, readTakeInfo, savePickSettings, takeSettings, type PickSettings, type TakeInfo } from "./agents/take";
import { readVision } from "./agents/vision";
import { cancelJob, getJob, listJobs, startJob, waitForJob, type Job, type JobContext } from "./jobs";
import { OUTLINE_FILE, listRuns, readSetting, readText, readTranscript, resolveVideo, runDir } from "./library";
import { readReview } from "./review";

export type NodeId = "source" | "outline" | "refclip" | "guide" | "transcript" | "refstyle" | "brief" | "pick" | "design" | "render" | "check" | "review" | "coach";
export type NodeState = "empty" | "optional" | "locked" | "ready" | "stale" | "running" | "waiting" | "done" | "failed" | "stopped";
export type Who = "you" | "transcriber" | "llm" | "jev" | "code";
export type WfNode = { id: NodeId; phase: number; who: Who; state: NodeState; reason?: string; facts: [string, string][]; job?: string; cost?: number };
export type TakeRef = {
  id: string; created: string; current: boolean; reviewed: boolean; score: number | null; clips: number;
  /** The Pick settings it was made with, and whether its other inputs (brief, notes, transcript) are current:
   *  then saving those settings again brings it back rather than making a new take. */
  settings: PickSettings; otherInputsCurrent: boolean;
};
export type Workflow = {
  video: string; stem: string;
  take: TakeRef | null; takes: TakeRef[];
  /** Pick's saved settings: its inputs for the next take. */
  pick: PickSettings;
  nodes: Record<NodeId, WfNode>;
  plan: NodeId[];
  next: { node: NodeId; text: string };
  run: string | null;
};

/** What changed since a take was made, or null if it's current. Fingerprints a take doesn't have
 *  (older takes) count as unchanged, or as "no notes" and "the settings it recorded". */
function takeChange(info: TakeInfo | null, brief: string, now: ReturnType<typeof pickInputs>): string | null {
  if (!info) return "Made before the workflow update";
  if (info.inputs.brief !== brief) return "Made from an older outline, reference or brief";
  if ((info.inputs.settings ?? hashText(JSON.stringify(takeSettings(info)))) !== now.settings) return "Pick's direction or clip count changed since";
  if ((info.inputs.notes ?? hashText("[]")) !== now.notes) return "Your transcript notes changed since";
  if (info.inputs.transcript && info.inputs.transcript !== now.transcript) return "The transcript changed since";
  return null;
}

/** Is the Coach up to date: same outline, reference and evidence as its last run (and no new direction)? */
function coachChange(video: string, direction?: string): { locked: boolean; change: string | null } {
  const now = coachInputs(video);
  if (!now) return { locked: true, change: null };
  const last = outlineState().scorecard;
  const dir = direction?.trim();
  if (dir && dir !== (last?.direction ?? "")) return { locked: false, change: "A new direction" };
  if (!last) return { locked: false, change: "It hasn't run yet" };
  if (!last.inputs) return { locked: false, change: null }; // an older scorecard: see the fallback in workflowState
  if (last.inputs.evidence !== now.evidence) return { locked: false, change: "New reviews or checks since it last ran" };
  if (last.inputs.outline !== now.outline) return { locked: false, change: "The outline changed since it last ran" };
  if (last.inputs.reference !== now.reference) return { locked: false, change: "The style reference changed since it last ran" };
  return { locked: false, change: null };
}

export const LABEL: Record<NodeId, string> = {
  source: "Source video", outline: "Outline", refclip: "Reference clip", guide: "Copy guide",
  transcript: "Transcript", refstyle: "Reference style", brief: "Brief",
  pick: "Pick clips", design: "Design edits", render: "Render", check: "Check",
  review: "Review", coach: "Coach",
};

const mmss = (t: number) => {
  const s = Math.max(0, Math.round(t));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const pct = (v: number) => `${Math.round(v * 100)}%`;
const readJson = (p: string): any => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
};

/** The latest job for a node, matching its video or take. */
function jobFor(agent: Job["agent"], match: (j: Job) => boolean) {
  return listJobs().find((j) => j.agent === agent && match(j));
}

/** Apply a job to a node's state: running wins; a failed/stopped job shows unless newer output exists
 *  or the node has a result to act on (done, or waiting on you). */
function withJob(node: WfNode, job: Job | undefined, outputAt = 0): WfNode {
  if (!job) return node;
  node.job = job.id;
  node.cost = job.cost || undefined;
  if (job.status === "running") return { ...node, state: "running", reason: job.stage };
  const needsRun = node.state === "ready" || node.state === "stale" || node.state === "optional" || node.state === "empty";
  if ((job.status === "failed" || job.status === "cancelled") && (job.finishedAt ?? 0) > outputAt && needsRun) {
    return { ...node, state: job.status === "failed" ? "failed" : "stopped", reason: job.error };
  }
  return node;
}

/** `self`: the ▶ Run job asking about its own video, which doesn't count as a run in progress. */
export function workflowState(videoRef: string, takeId?: string | null, self?: string): Workflow {
  const videoPath = resolveVideo(videoRef);
  const video = basename(videoPath);
  const stem = parse(videoPath).name;
  const outline = readText(OUTLINE_FILE);
  const os = outlineState();
  const version = os.versions.find((v) => v.hash === os.current);
  const ref = readReference();
  const guide = ref?.guide ?? pendingGuide();
  const segs = readTranscript(videoPath);
  const vt = readVision(videoPath);
  const onVideo = (j: Job) => j.input.video === video;
  const N = {} as Record<NodeId, WfNode>;
  const node = (id: NodeId, phase: number, who: Who, state: NodeState, facts: [string, string][] = [], reason?: string): WfNode => ({ id, phase, who, state, facts, ...(reason ? { reason } : {}) });

  // ── 1 · Inputs ────────────────────────────────────────────────
  N.source = node("source", 1, "you", "done", [["File", video.length > 34 ? `${video.slice(0, 32)}…` : video]]);
  const clipCount = readSetting(outline, "Number of clips");
  const clipLen = readSetting(outline, "Clip length");
  N.outline = node("outline", 1, "you", outline.trim() ? "done" : "empty", [
    ["Version", version ? `${version.label}${version.source === "coach" ? " · by the coach" : ""}` : "–"],
    ["One-shot", version?.mean !== null && version?.mean !== undefined ? `${version.mean} over ${version.rated} take${version.rated === 1 ? "" : "s"}` : "not scored yet"],
    ["Clips", [clipCount, clipLen].filter(Boolean).join(" · ") || "–"],
  ], os.pending ? "The coach has a proposal for it" : undefined);
  N.refclip = withJob(node("refclip", 1, "you", ref ? "done" : "optional", ref ? [["Clip", ref.name.length > 30 ? `${ref.name.slice(0, 28)}…` : ref.name], ["From", ref.source ? "a link" : "a file"]] : [], ref ? undefined : "Optional: a finished clip whose style to copy"), jobFor("refclip", () => true), ref?.at ?? 0);
  N.guide = node("guide", 1, "you", guide.trim() ? "done" : "optional", guide.trim() ? [["Copy", guide.length > 70 ? `${guide.slice(0, 68)}…` : guide]] : [], guide.trim() ? undefined : "Optional: what to copy from the reference");

  // ── 2 · Understand ────────────────────────────────────────────
  const aligned = segs?.length ? segs.filter((s) => s.timing === "aligned").length / segs.length : 0;
  let trState: NodeState = !segs ? "ready" : !vt || aligned < 0.5 ? "stale" : "done";
  N.transcript = withJob(node("transcript", 2, "transcriber", trState, segs ? [
    ["Lines", String(segs.length)], ["Timing", aligned >= 0.5 ? `${pct(aligned)} measured` : "estimated"], ["Shots", vt ? String(vt.shots.length) : "not yet"],
  ] : [], segs && trState === "stale" ? (!vt ? "No vision transcript yet" : "Word timings not measured yet") : undefined), jobFor("transcript", onVideo), segs ? Date.now() : 0);
  const a = ref?.analysis;
  N.refstyle = withJob(node("refstyle", 2, "transcriber",
    !ref ? "optional" : !a ? "ready" : a.guide !== ref.guide ? "stale" : "done",
    a ? [["Cuts", `every ${a.avg_shot.toFixed(1)}s`], ["Speech", `${Math.round(a.words_per_min)} words/min`], ["Traits", String(a.profile.traits.length)]] : [],
    !ref ? "No reference clip" : a && a.guide !== ref.guide ? "The copy guide changed since" : undefined,
  ), ref ? jobFor("refstyle", () => true) : undefined, a?.at ?? 0);

  // ── 3 · Brief ─────────────────────────────────────────────────
  const bf = readBrief(videoPath);
  const bin = briefInputs(videoPath);
  const briefReason = !bf ? undefined : bf.outline_hash !== bin.outlineHash ? "The outline changed since"
    : bf.reference !== bin.reference ? "The style reference changed since"
    : bf.inputs !== bin.hash ? "Written by an older version of this step" : undefined;
  N.brief = withJob(node("brief", 3, "llm",
    !segs ? "locked" : !bf ? "ready" : bf.inputs !== bin.hash ? "stale" : "done",
    bf ? [
      ["Questions", String(bf.brief.pick.opener.length + bf.brief.pick.ending.length + bf.brief.pick.window.length)],
      ["Check rules", String(bf.brief.check.length)],
      ["Written by", bf.brief.source === "llm" ? (bf.brief.model ?? "LLM").split("/").pop()! : "built-in"],
    ] : [],
    !segs ? "Needs the transcript" : briefReason,
  ), jobFor("brief", onVideo), bf?.at ?? 0);

  // ── 4 · Make (the selected take, else the latest) ─────────────
  const runs = listRuns().filter((r) => r.videoStem === stem);
  const pin = pickInputs(videoPath);
  const takeOf = (r: (typeof runs)[number]): TakeRef => {
    const info = readTakeInfo(r.id);
    const ownSettings = info?.inputs.settings ?? hashText(JSON.stringify(takeSettings(info)));
    return {
      id: r.id, created: r.created, current: !takeChange(info, bin.hash, pin),
      reviewed: readReview(r.id).approved, score: os.outcomes[r.id]?.score ?? null, clips: r.clips.length, settings: takeSettings(info),
      otherInputsCurrent: !takeChange(info, bin.hash, { ...pin, settings: ownSettings }),
    };
  };
  const takes = runs.map(takeOf);
  // The take asked for; else the latest one made from the current inputs (so going back to earlier inputs
  // finds the take already made from them, instead of making it again); else the latest.
  const take = takes.find((t) => t.id === takeId) ?? takes.find((t) => t.current) ?? takes[0] ?? null;
  const tr = take ? runs.find((r) => r.id === take.id)! : null;
  const onTake = (j: Job) => !!take && j.input.run === take.id;
  const jev = tr?.jev;
  N.pick = withJob(node("pick", 4, "jev",
    !segs ? "locked" : !take ? "ready" : take.current ? "done" : "stale",
    take ? [["Clips", String(take.clips)], ["Decisions", jev?.stats ? String(jev.stats.calls) : "–"], ["Take", `${takes.length - takes.indexOf(take)} of ${takes.length}`]] : [],
    !segs ? "Needs the transcript" : take && !take.current ? `${takeChange(readTakeInfo(take.id), bin.hash, pin)}: Run makes a new take` : undefined,
  ), jobFor("pick", onVideo), take ? readTakeInfo(take.id)?.created ?? Date.now() : 0);

  let dState: NodeState = "locked";
  const design = tr ? readJson(join(runDir(tr.id), "design.json")) : null;
  const created = take ? readTakeInfo(take.id)?.created ?? 0 : 0;
  // Designed from the take, the planner's version, your effects/ and your assets/: a change to any is a redesign.
  const din = designInputs();
  const designReason = !design || design.at < created ? undefined
    : !design.inputs || design.inputs.version < din.version ? "Designed before the effects library: Run plans it again with effects"
    : design.inputs.effects !== din.effects ? "Your effects/ folder changed since"
    : design.inputs.assets !== din.assets ? "Files in assets/ changed since" : undefined;
  if (take) dState = !design || design.at < created ? "ready" : designReason ? "stale" : "done";
  const planned = Object.values<any>(design?.clips ?? {}).filter((c) => c.mode === "concepts").length;
  const fxCount = tr ? tr.clips.reduce((n, c) => n + (c.edit?.fx?.length ?? 0), 0) : 0;
  const moves: Record<string, number> = {};
  for (const c of Object.values<any>(design?.clips ?? {})) {
    for (const z of c.zooms ?? []) moves[z.zoom] = (moves[z.zoom] ?? 0) + 1;
    for (const t of c.transitions ?? []) moves[t.transition] = (moves[t.transition] ?? 0) + 1;
  }
  const topMoves = Object.entries(moves).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, n]) => `${k.replace(/_/g, " ")} ×${n}`).join(", ");
  N.design = withJob(node("design", 4, "jev", dState, design ? [
    ...(planned
      ? [["Plans", `${planned}/${tr?.clips.length ?? planned} clips, Jev picked`], ["Effects", String(fxCount)]] as [string, string][]
      : [["Choices", String(Object.values<any>(design.clips ?? {}).reduce((n, c) => n + (c.zooms?.length ?? 0) + (c.transitions?.length ?? 0) + (c.hook ? 1 : 0), 0))], ["Moves", topMoves || "–"]] as [string, string][]),
    ["Hook cards", String(Object.values<any>(design.clips ?? {}).filter((c) => c.hook).length)],
  ] : [], !take ? "Needs a take" : designReason), jobFor("design", onTake), design?.at ?? 0);

  const rs = take ? renderStatus(take.id) : null;
  N.render = withJob(node("render", 4, "code",
    !take || dState !== "done" ? "locked" : rs!.missing.length === rs!.total ? "ready" : rs!.missing.length || rs!.stale.length ? "stale" : "done",
    rs ? [["Rendered", `${rs.total - rs.missing.length}/${rs.total}`], ...(rs.stale.length ? [["Changed since", `clip ${rs.stale.join(", ")}`] as [string, string]] : [])] : [],
    !take ? "Needs a take" : dState !== "done" ? "Needs the edit design" : rs!.stale.length ? "Edits changed since these were rendered" : undefined,
  ), jobFor("render", onTake));

  const cs = take ? checkStatus(take.id) : null;
  const ck = take ? readCheck(take.id) : null;
  const checked = ck ? Object.values(ck.clips) : [];
  const avg = checked.length ? checked.reduce((n, c) => n + c.followed, 0) / checked.length : null;
  const edgeFlags = checked.filter((c) => c.edges && (c.edges.start_clean < 0.5 || c.edges.end_clean < 0.5)).length;
  N.check = withJob(node("check", 4, "jev",
    !take || !cs || !cs.rendered ? "locked" : !ck ? "ready" : cs.todo.length ? "stale" : "done",
    cs?.rendered ? [["Checked", `${cs.checked}/${cs.rendered}`], ["Rules followed", avg === null ? "–" : `${pct(avg)} on average`], ["Edges flagged", String(edgeFlags)]] : [],
    !take || !cs?.rendered ? "Needs rendered clips" : ck && cs.todo.length ? "Clips were rendered again since" : undefined,
  ), jobFor("check", onTake), ck?.at ?? 0);

  // ── 5 · Review ────────────────────────────────────────────────
  const rv = take ? readReview(take.id) : null;
  const verdicts = rv ? Object.values(rv.clips) : [];
  const kept = tr ? tr.clips.filter((c) => rv!.clips[c.id]?.status === "keep" || rv!.clips[c.id]?.rating === 1).length : 0;
  const dropped = tr ? tr.clips.filter((c) => rv!.clips[c.id]?.status === "drop" || rv!.clips[c.id]?.rating === -1).length : 0;
  const rendered = rs ? rs.total - rs.missing.length : 0;
  const nudged = verdicts.filter((v) => (v.nudges ?? 0) > 0).length;
  // Finishing the review keeps every clip you didn't drop, the same rule the one-shot score uses.
  N.review = node("review", 5, "you",
    !take || !rendered ? "locked" : rv!.approved ? "done" : "waiting",
    !take || !rendered ? [] : rv!.approved
      ? [["Kept", String(take.clips - dropped)], ["Dropped", String(dropped)], ["Nudged", String(nudged)]]
      : [["Kept", String(kept)], ["Dropped", String(dropped)], ["Undecided", String(Math.max(0, take.clips - kept - dropped))]],
    !take || !rendered ? "Needs rendered clips" : rv!.approved ? `One-shot ${take.score ?? "–"}` : `${verdicts.filter((v) => v.comments.length).length ? "Comments noted · " : ""}Keep or drop each clip, then finish the review (clips you don't drop count as kept)`,
  );

  // ── 6 · Learn ─────────────────────────────────────────────────
  const reviewed = listRuns().map((r) => ({ r, rv: readReview(r.id) })).filter((x) => x.rv.approved);
  const cc = coachChange(video);
  // A scorecard from before the Coach recorded its inputs: new reviews since then are what counts.
  const fresh = reviewed.filter((x) => (x.rv.approvedAt ?? 0) > os.lastCoach).length + (a && a.at > os.lastCoach ? 1 : 0);
  const coachReason = cc.change ?? (os.scorecard && !os.scorecard.inputs && fresh ? "New reviews since it last ran" : null);
  N.coach = withJob(node("coach", 6, "jev",
    os.pending ? "waiting" : cc.locked ? "locked" : coachReason ? "ready" : "done",
    [
      ["Evidence", `${reviewed.length} reviewed take${reviewed.length === 1 ? "" : "s"}${a ? " + reference" : ""}`],
      ...(os.pending ? [["Proposal", `${os.pending.changes.length} change${os.pending.changes.length === 1 ? "" : "s"}`] as [string, string]] : []),
    ],
    os.pending ? "Apply or discard its proposal" : cc.locked ? "Review a take (or add a style reference) first" : coachReason ?? undefined,
  ), jobFor("coach", () => true), os.lastCoach);

  // ── What ▶ Run does ───────────────────────────────────────────
  const todo = (s: NodeState) => s !== "done" && s !== "running" && s !== "locked" && s !== "optional" && s !== "empty" && s !== "waiting";
  const plan: NodeId[] = [];
  if (N.transcript.state !== "done") plan.push("transcript");
  if (todo(N.refstyle.state)) plan.push("refstyle");
  if (N.brief.state !== "done" || plan.includes("refstyle")) plan.push("brief");
  if (!take || N.pick.state === "stale" || plan.includes("brief")) plan.push("pick", "design", "render", "check");
  else {
    if (N.design.state !== "done") plan.push("design");
    if (plan.includes("design") || N.render.state !== "done") plan.push("render");
    if (plan.includes("render") || N.check.state !== "done") plan.push("check");
  }
  if (!plan.length && N.review.state === "done" && N.coach.state === "ready") plan.push("coach");
  if (!outline.trim()) plan.length = 0;
  // Out of date means ▶ Run will redo it, so a done step after one that runs again shows as out of date too.
  for (const [i, id] of plan.entries()) {
    if (N[id].state !== "done") continue;
    const reason = plan.includes("pick") && plan.indexOf("pick") < i ? "Run makes it again for the new take" : i ? `Run redoes it after ${LABEL[plan[i - 1]]}` : "Run redoes it";
    N[id] = { ...N[id], state: "stale", reason };
  }

  const wfJob = jobFor("workflow", (j) => onVideo(j) && j.id !== self);
  const running = wfJob?.status === "running" ? wfJob.id : null;
  const next: Workflow["next"] = !outline.trim()
    ? { node: "outline", text: "Write an outline first: who the clips are for and how to cut them." }
    : running
      ? { node: plan[0] ?? "review", text: `Running: ${wfJob!.stage}` }
      : plan.length
        ? { node: plan[0], text: `▶ Run will: ${plan.map((s) => LABEL[s]).join(" → ")}` }
        : N.review.state === "waiting"
          ? { node: "review", text: "Your turn: keep or drop each clip, nudge edges, comment, then finish the review." }
          : N.coach.state === "waiting"
            ? { node: "coach", text: "The coach proposed a revised outline: apply it or discard it." }
            : { node: "pick", text: "Everything is up to date. To make another take, change an input: Pick's direction or clip count, your notes, or the outline." };

  return { video, stem, take, takes, pick: readPickSettings(videoPath), nodes: N, plan, next, run: running };
}

/** Why running `step` now would change nothing (it's up to date with its inputs), or null if it can run.
 *  The API and the Director's tools both check this, so a step never reruns on unchanged inputs. */
export function stepUpToDate(step: NodeId, video: string | undefined, take: string | null, opts: { direction?: string } = {}): string | null {
  if (!video) {
    // The style reference belongs to no video in particular.
    const ref = readReference();
    return step === "refstyle" && ref?.analysis && ref.analysis.guide === ref.guide
      ? "Reference style is up to date: the reference clip and the copy guide haven't changed since it ran."
      : null;
  }
  const w = workflowState(video, take);
  const n = w.nodes[step];
  if (step === "coach") {
    const cc = coachChange(w.video, opts.direction);
    if (cc.change === "A new direction") return null;
    if (n.state === "waiting" && !cc.change) return "The Coach is up to date: its proposal is waiting for you to apply or discard.";
  }
  return n?.state === "done"
    ? `${LABEL[step]} is up to date: none of its inputs changed since it ran, so it would give the same result. Change one of them to run it again.`
    : null;
}

// ── ▶ Run ────────────────────────────────────────────────────────

/** Wait for a child job; stopping the workflow stops it too. */
async function follow(job: Job, ctx: JobContext) {
  const stop = () => cancelJob(job.id);
  ctx.signal.addEventListener("abort", stop, { once: true });
  try {
    let j = getJob(job.id)!;
    while (j.status === "running") j = (await waitForJob(job.id, 30))!;
    return j;
  } finally {
    ctx.signal.removeEventListener("abort", stop);
  }
}

function startStep(step: NodeId, video: string, take: string | null): Job {
  switch (step) {
    case "transcript": return startTranscript(video);
    case "refstyle": return startRefStyle();
    case "brief": return startBrief(video);
    case "pick": return startPick({ video });
    case "design": return startDesign(take!);
    case "render": return startRender({ run: take! });
    case "check": return startCheck({ run: take! });
    case "coach": return startCoach({ video });
    default: throw new Error(`${LABEL[step]} isn't a step Run can do`);
  }
}

export async function runWorkflow(ctx: JobContext, videoRef: string, opts: { take?: string }) {
  const video = basename(resolveVideo(videoRef));
  const first = workflowState(video, opts.take ?? null, ctx.job.id);
  // The take the canvas shows: the one asked for, else the latest. Pick replaces it with the new take.
  let take = first.take?.id ?? null;
  // Only what isn't up to date: a new take happens when one of Pick's inputs changed (see takeChange).
  const steps = first.plan;
  if (!steps.length) {
    ctx.log(first.next.text);
    return { steps, take, next: first.next };
  }
  ctx.log(`Run: ${steps.map((s) => LABEL[s]).join(" → ")}`);
  // Each step's job carries its own cost (the meters add those up); the Run only reports the total.
  let total = 0;
  for (const [i, step] of steps.entries()) {
    ctx.progress(i / steps.length, `${LABEL[step]} (${i + 1}/${steps.length})`);
    const end = await follow(startStep(step, video, take), ctx);
    if (end.status !== "done") throw new Error(`${LABEL[step]} ${end.status === "cancelled" ? "was stopped" : `failed: ${end.error}`}`);
    if (step === "pick") take = (end.result as { run: string }).run;
    total += end.cost ?? 0;
    ctx.log(`${LABEL[step]} done${end.cost ? ` · $${end.cost.toFixed(4)}` : ""}`);
  }
  const after = workflowState(video, take, ctx.job.id);
  ctx.progress(1, "done");
  ctx.log(`Run done: ${steps.length} step${steps.length === 1 ? "" : "s"} for $${total.toFixed(4)}`);
  ctx.log(after.next.text);
  return { steps, take, next: after.next };
}

/** ▶ Run. A direction or clip count given here is saved as Pick's settings first (so they're Pick's inputs:
 *  if they differ from the current take's, the take is out of date and Run makes a new one). When every
 *  step is up to date there's nothing to run, and it says so instead of starting a job. */
export function startWorkflow(args: { video: string; take?: string; direction?: string; count?: number | null }): Job | { skipped: string } {
  const path = resolveVideo(args.video);
  const video = basename(path);
  const running = listJobs().find((j) => j.agent === "workflow" && j.status === "running" && j.input.video === video);
  if (running) return running;
  if (args.direction !== undefined || args.count !== undefined) savePickSettings(path, { direction: args.direction, count: args.count });
  const w = workflowState(video, args.take ?? null);
  if (!w.plan.length) return { skipped: w.next.text };
  const input = { video, ...(args.take ? { take: args.take } : {}) };
  return startJob("workflow", `Run the workflow for ${video}`, input, (ctx) => runWorkflow(ctx, video, input));
}

/** For the Director: the workflow as plain lines. */
export function describeWorkflow(w: Workflow) {
  const lines = Object.values(w.nodes).map((n) => `${n.phase}. ${LABEL[n.id]} [${n.who}]: ${n.state}${n.reason ? ` (${n.reason})` : ""}${n.facts.length ? ` · ${n.facts.map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
  return {
    video: w.video,
    take: w.take?.id ?? null,
    nodes: lines,
    run_would_do: w.plan.map((s) => LABEL[s]),
    next: w.next.text,
    takes: w.takes.map((t) => ({ id: t.id, created: t.created, current: t.current, reviewed: t.reviewed, one_shot: t.score })),
  };
}

