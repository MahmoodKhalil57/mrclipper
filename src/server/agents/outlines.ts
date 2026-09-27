// The outline's memory: every version, how its takes were reviewed, and the coach's proposals.
//
// Every take snapshots the outline it was made from (clips/<run>/outline.md), and every distinct
// outline becomes a version in outlines/ledger.json. Your review of a take is its reward: a
// "one-shot" score for how close the take came to being accepted as-is (no drops, nudges or
// comments). The Coach (coach.ts) proposes the next version; you apply it here.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config";
import { CLIPS_DIR, OUTLINE_FILE, listRuns, readClipData, readText, readTranscript } from "../library";
import { readReview } from "../review";
import { readCheck } from "./check";
import { readReference } from "./reference";
import { clipStr, hashText } from "./text";
import { readWatch, watchSummary } from "./watch";

const DIR = join(ROOT, "outlines");
const LEDGER = join(DIR, "ledger.json");
const VERSIONS = join(DIR, "versions");
const PROPOSALS = join(DIR, "proposals");
const SCORECARDS = join(DIR, "scorecards");

export type OutlineVersion = { hash: string; at: number; source: "user" | "coach"; parent?: string; proposal?: string };
export type Proposal = {
  id: string; at: number; status: "proposed" | "applied" | "discarded";
  parent: string; hash: string; outline: string;
  changes: { section: string; change: string; evidence: string }[];
  hypothesis: string; keep: string; warnings: string[];
  takes: string[]; direction?: string; model: string; cost: number; scorecard?: string;
};
export type Scorecard = {
  id: string; at: number; outline_hash: string; cost: number; calls: number; diagnosis: string;
  /** Per check rule: how often the reviewed clips follow it, and on clips you kept vs dropped. */
  rules: { key: string; section: string; rule: string; followed: number; good: number | null; bad: number | null; n: number }[];
  decisions: { section: string; chosen: string; summary: string; p: number; options: Record<string, number>; applied: boolean }[];
  proposal?: string;
};
export type TakeOutcome = {
  run: string; videoStem: string; created: string; hash: string | null;
  clips: number; dropped: number; nudged: number; comments: number; approved: boolean; approvedAt?: number;
  rated: boolean; score: number | null;
};

const readJson = <T,>(f: string, fallback: T): T => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

// ── Versions ────────────────────────────────────────────────────────

export const readLedger = (): OutlineVersion[] => readJson<OutlineVersion[]>(LEDGER, []);

/** Record an outline version (idempotent). Returns its hash. */
export function registerOutline(text: string, source: "user" | "coach" = "user", extra: Partial<OutlineVersion> = {}) {
  const hash = hashText(text);
  const ledger = readLedger();
  if (!ledger.some((v) => v.hash === hash)) {
    mkdirSync(VERSIONS, { recursive: true });
    writeFileSync(join(VERSIONS, `${hash}.md`), text, "utf8");
    ledger.push({ hash, at: Date.now(), source, parent: ledger[ledger.length - 1]?.hash, ...extra });
    writeFileSync(LEDGER, JSON.stringify(ledger, null, 1), "utf8");
  }
  return hash;
}

export const versionText = (hash: string) => readText(join(VERSIONS, `${hash.replace(/[^0-9a-f]/g, "")}.md`));

/** Called when a take is written: keep the outline it was made with, and version it. */
export function snapshotOutline(runDirPath: string) {
  const text = readText(OUTLINE_FILE);
  if (!text) return;
  writeFileSync(join(runDirPath, "outline.md"), text, "utf8");
  registerOutline(text);
}

// ── Rewards ─────────────────────────────────────────────────────────

/**
 * One-shot score, 0-100: the share of clips you kept, x0.85 if you haven't finished reviewing the take,
 * x0.9 per clip whose edges you nudged, x0.95 per comment (up to 6). Takes you haven't touched aren't scored.
 */
export function takeOutcome(r: ReturnType<typeof listRuns>[number]): TakeOutcome {
  const rv = readReview(r.id);
  const snap = join(CLIPS_DIR, r.id, "outline.md");
  const clips = r.clips.length;
  const verdicts = Object.values(rv.clips);
  // Older takes: a 👎 on the finished clip counts like a drop, a 👍 like a keep.
  const bad = (c: (typeof verdicts)[number]) => c.status === "drop" || c.rating === -1;
  const dropped = verdicts.filter(bad).length;
  const nudged = verdicts.filter((c) => !bad(c) && (c.nudges ?? 0) > 0).length;
  const comments = rv.comments.filter((c) => c.by !== "agent").length +
    verdicts.filter((c) => c.rating !== 1).reduce((n, c) => n + c.comments.filter((x) => x.by !== "agent").length, 0);
  const rated = rv.approved || verdicts.some((c) => c.status || c.rating) || comments > 0 || nudged > 0;
  const score = rated && clips
    ? Math.round(100 * ((clips - dropped) / clips) * (rv.approved ? 1 : 0.85) * 0.9 ** nudged * 0.95 ** Math.min(comments, 6))
    : null;
  return {
    run: r.id, videoStem: r.videoStem, created: r.created,
    hash: existsSync(snap) ? hashText(readFileSync(snap, "utf8")) : null,
    clips, dropped, nudged, comments, approved: rv.approved, approvedAt: rv.approvedAt, rated, score,
  };
}

/** How one clip went for you: 1 kept, 0 dropped, 0.5 kept but corrected or commented on, null not reviewed. */
export function clipReward(runId: string, clipId: number): number | null {
  const rv = readReview(runId);
  const v = rv.clips[clipId];
  if (v?.status === "drop" || v?.rating === -1) return 0;
  if (v?.rating === 1) return 1;
  const touched = (v?.nudges ?? 0) > 0 || (v?.comments ?? []).some((c) => c.by !== "agent");
  if (touched) return 0.5;
  if (v?.status === "keep" || rv.approved) return 1;
  return null;
}

// ── Proposals and scorecards ────────────────────────────────────────

function listProposals(): Proposal[] {
  if (!existsSync(PROPOSALS)) return [];
  return readdirSync(PROPOSALS).filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Proposal | null>(join(PROPOSALS, f), null)).filter((p): p is Proposal => !!p)
    .sort((a, b) => b.at - a.at);
}
export const saveProposal = (p: Proposal) => (mkdirSync(PROPOSALS, { recursive: true }), writeFileSync(join(PROPOSALS, `${p.id}.json`), JSON.stringify(p, null, 1), "utf8"), p);
const readProposal = (id: string) => {
  const p = readJson<Proposal | null>(join(PROPOSALS, `${id.replace(/[^\w-]/g, "")}.json`), null);
  if (!p) throw new Error(`No outline proposal "${id}"`);
  return p;
};

export function applyProposal(id: string) {
  const p = readProposal(id);
  writeFileSync(OUTLINE_FILE, p.outline, "utf8");
  registerOutline(p.outline, "coach", { parent: p.parent, proposal: p.id });
  p.status = "applied";
  return saveProposal(p);
}

export function discardProposal(id: string) {
  const p = readProposal(id);
  p.status = "discarded";
  return saveProposal(p);
}

export function restoreVersion(hash: string) {
  const text = versionText(hash);
  if (!text) throw new Error(`No outline version ${hash}`);
  writeFileSync(OUTLINE_FILE, text, "utf8");
  return { hash };
}

export function saveScorecard(sc: Scorecard) {
  mkdirSync(SCORECARDS, { recursive: true });
  writeFileSync(join(SCORECARDS, `${sc.id}.json`), JSON.stringify(sc, null, 1), "utf8");
}
function latestScorecard(): Scorecard | null {
  if (!existsSync(SCORECARDS)) return null;
  const f = readdirSync(SCORECARDS).filter((x) => x.endsWith(".json")).sort().pop();
  return f ? readJson<Scorecard | null>(join(SCORECARDS, f), null) : null;
}

export type OutlineState = {
  current: string;
  versions: (OutlineVersion & { label: string; takes: number; rated: number; mean: number | null })[];
  outcomes: Record<string, { score: number | null; hash: string | null }>;
  pending: Proposal | null;
  proposals: Omit<Proposal, "outline">[];
  scorecard: Scorecard | null;
  /** When the coach last ran (a proposal or a scorecard), to tell whether there's new evidence since. */
  lastCoach: number;
};

export function outlineState(): OutlineState {
  const current = registerOutline(readText(OUTLINE_FILE));
  const outcomes = listRuns().map(takeOutcome);
  const versions = readLedger().map((v, i) => {
    const mine = outcomes.filter((o) => o.hash === v.hash);
    const scored = mine.filter((o) => o.score !== null);
    return {
      ...v, label: `v${i + 1}`, takes: mine.length, rated: scored.length,
      mean: scored.length ? Math.round(scored.reduce((n, o) => n + o.score!, 0) / scored.length) : null,
    };
  });
  const proposals = listProposals();
  const scorecard = latestScorecard();
  return {
    current, versions,
    outcomes: Object.fromEntries(outcomes.map((o) => [o.run, { score: o.score, hash: o.hash }])),
    pending: proposals.find((p) => p.status === "proposed" && p.parent === current) ?? null,
    proposals: proposals.map(({ outline, ...p }) => p),
    scorecard,
    lastCoach: Math.max(proposals[0]?.at ?? 0, scorecard?.at ?? 0),
  };
}

// ── Evidence for the Coach ──────────────────────────────────────────

type Run = ReturnType<typeof listRuns>[number];

/** One take, as the Coach reads it: every clip's verdict, check scores, what the finished file shows, your comments. */
export function takeEvidence(r: Run, o: TakeOutcome, label: (h: string | null) => string) {
  const rv = readReview(r.id);
  const ck = readCheck(r.id);
  let data: ReturnType<typeof readClipData> | null = null;
  try {
    data = readClipData(join(CLIPS_DIR, r.id, "clip_script.md"));
  } catch {}
  const segs = data ? readTranscript(data.video) ?? [] : [];
  const line = (t: number, first: boolean) => {
    const inside = segs.filter((s) => s.end > t - 0.2 && s.start < t + 0.2);
    return clipStr((first ? inside[0] : inside[inside.length - 1])?.text ?? "", 140);
  };
  const out = [`### Take ${r.created} of "${clipStr(r.videoStem, 60)}" · outline ${label(o.hash)} · one-shot ${o.score ?? "not reviewed"}${o.approved ? " · review finished" : ""}`];
  for (const c of r.clips) {
    const v = rv.clips[c.id];
    const status = v?.status === "drop" || v?.rating === -1 ? "DROPPED" : v?.status === "keep" || v?.rating === 1 ? "kept" : o.approved ? "kept" : "not reviewed";
    const moves = c.edit?.segments?.map((s: any) => s.zoom ?? "none").join("/") ?? "";
    const cc = ck?.clips[c.id];
    const low = cc ? (ck?.rules ?? []).filter((q) => (cc.rules[q.key] ?? 1) < 0.4).map((q) => q.rule) : [];
    out.push(
      `- Clip ${c.id} "${clipStr(c.title, 60)}" ${(c.end - c.start).toFixed(0)}s: ${status}${v?.nudges ? `, edges nudged ${v.nudges}x` : ""}` +
        `${cc ? `, follows ${Math.round(cc.followed * 100)}% of the check rules${low.length ? ` (misses: ${low.slice(0, 3).join("; ")})` : ""}` : ""}` +
        `${moves ? `, moves ${moves}${c.edit?.transitions?.length ? ` via ${c.edit.transitions.join("/")}` : ""}` : ""}`,
      `  opens "${line(c.edit?.segments?.[0]?.start ?? c.start, true)}" · ends "${line(c.edit?.segments?.at(-1)?.end ?? c.end, false)}"`,
      ...(c.file && readWatch(r.id, c.id) ? [`  finished clip: ${watchSummary(readWatch(r.id, c.id))}`] : []),
      ...(v?.comments ?? []).filter((x) => x.by !== "agent").map((x) => `  your comment: "${clipStr(x.text, 240)}"`),
    );
  }
  for (const x of rv.comments.filter((x) => x.by !== "agent")) out.push(`- Comment on the whole take: "${clipStr(x.text, 300)}"`);
  return out.join("\n");
}

/** Evidence for a coach run: this video's recent takes (reviewed first), plus a few reviewed takes from other videos. */
export function selectTakes(input: { video?: string }) {
  const state = outlineState();
  const label = (h: string | null) => (h ? state.versions.find((v) => v.hash === h)?.label ?? "?" : "unrecorded");
  const cur = state.versions.find((v) => v.hash === state.current)!;
  const runs = listRuns();
  const outcomes = new Map(runs.map((r) => [r.id, takeOutcome(r)]));
  const stem = input.video?.replace(/\.[^.]+$/, "");
  const byRecency = (a: Run, b: Run) => b.created.localeCompare(a.created);
  const here = runs.filter((r) => !stem || r.videoStem === stem).sort((a, b) => Number(outcomes.get(b.id)!.rated) - Number(outcomes.get(a.id)!.rated) || byRecency(a, b)).slice(0, 4);
  const elsewhere = runs.filter((r) => !here.includes(r) && outcomes.get(r.id)!.rated).sort(byRecency).slice(0, 2);
  const takes = [...here, ...elsewhere];
  if (!takes.some((t) => outcomes.get(t.id)!.rated) && !readReference()?.analysis) {
    throw new Error("Nothing to learn from yet. Review a take (keep or drop its clips), or add a style reference to copy.");
  }
  return { state, label, cur, takes, outcomes, ratedCount: takes.filter((r) => outcomes.get(r.id)!.rated).length };
}
