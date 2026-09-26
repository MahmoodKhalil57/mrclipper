// Outline coach: the LLM node after Clips that feeds back into the Outline.
//
// Every take snapshots the outline it was planned with (clips/<run>/outline.md), and every distinct
// outline becomes a version in outlines/ledger.json. Your review of a take is its reward: a
// "one-shot" score for how close the take came to being approved as-is (no drops, nudges or
// comments). The coach reads the current outline, the evidence from recent takes, the best-scoring
// earlier versions and how its own earlier proposals turned out, then proposes a revised outline.
// You apply it (or not); the next takes score the new version, and the loop continues.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, ROOT } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter } from "../lib";
import { CLIPS_DIR, OUTLINE_FILE, historyPaths, listRuns, readClipData, readText, readTranscript } from "../library";
import { readReview } from "../review";
import { readWatch, watchSummary } from "./watch";

const DIR = join(ROOT, "outlines");
const LEDGER = join(DIR, "ledger.json");
const VERSIONS = join(DIR, "versions");
const PROPOSALS = join(DIR, "proposals");
const RUBRICS = join(DIR, "rubrics");
const SCORECARDS = join(DIR, "scorecards");

// ── Rubric (the LLM step before the Jev coach) and scorecards (Jev's judgement) ──
export type RubricRule = { key: string; section: string; rule: string; question: string };
export type RubricVariant = { key: string; summary: string; text: string };
export type Rubric = {
  source: "llm" | "default"; model?: string; at: number; outline_hash: string; cost: number; diagnosis: string;
  rules: RubricRule[];
  /** Sections the evidence says are hurting clips, each with rewrites for Jev to choose between. */
  sections: { section: string; why: string; variants: RubricVariant[] }[];
};
export type Scorecard = {
  id: string; at: number; mode: "jev" | "hybrid"; outline_hash: string; rubric_source: "llm" | "default"; cost: number; calls: number;
  diagnosis: string;
  rules: { key: string; section: string; rule: string; followed: number; good: number | null; bad: number | null; n: number }[];
  clips: { run: string; clip: number; title: string; reward: number | null; watched: boolean; answers: Record<string, number> }[];
  decisions: { section: string; chosen: string; summary: string; p: number; options: Record<string, number>; applied: boolean }[];
  proposal?: string;
};

export function saveRubric(r: Rubric) {
  mkdirSync(RUBRICS, { recursive: true });
  writeFileSync(join(RUBRICS, `${r.outline_hash}.json`), JSON.stringify(r, null, 1), "utf8");
}
export const readRubric = (hash: string) => readJson<Rubric | null>(join(RUBRICS, `${hash.replace(/[^0-9a-f]/g, "")}.json`), null);

export function saveScorecard(sc: Scorecard) {
  mkdirSync(SCORECARDS, { recursive: true });
  writeFileSync(join(SCORECARDS, `${sc.id}.json`), JSON.stringify(sc, null, 1), "utf8");
}
function latestScorecard(): Scorecard | null {
  if (!existsSync(SCORECARDS)) return null;
  const f = readdirSync(SCORECARDS).filter((x) => x.endsWith(".json")).sort().pop();
  return f ? readJson<Scorecard | null>(join(SCORECARDS, f), null) : null;
}

export const hashText = (t: string) => createHash("sha1").update(t.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 12);

export type OutlineVersion = { hash: string; at: number; source: "user" | "coach"; parent?: string; proposal?: string };
export type Proposal = {
  id: string; at: number; status: "proposed" | "applied" | "discarded";
  parent: string; hash: string; outline: string;
  changes: { section: string; change: string; evidence: string }[];
  hypothesis: string; keep: string; warnings: string[];
  takes: string[]; direction?: string; model: string; cost: number;
  /** Who decided: the LLM coach, or Jev (System One / Hybrid) choosing between the rubric's rewrites. */
  mode?: "llm" | "jev" | "hybrid"; scorecard?: string;
};
export type TakeOutcome = {
  run: string; videoStem: string; created: string; engine: string; hash: string | null;
  clips: number; dropped: number; nudged: number; comments: number; approved: boolean;
  rated: boolean; score: number | null;
};

const readJson = <T,>(f: string, fallback: T): T => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback;
  } catch {
    return fallback;
  }
};

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

/** Called when a take is written: keep the outline it was planned with, and version it. */
export function snapshotOutline(runDirPath: string) {
  const text = readText(OUTLINE_FILE);
  if (!text) return;
  writeFileSync(join(runDirPath, "outline.md"), text, "utf8");
  registerOutline(text);
}

// ── Rewards ─────────────────────────────────────────────────────────

/**
 * One-shot score, 0-100: the share of clips you kept (a 👎 on a finished clip counts as a drop),
 * x0.85 if the take wasn't approved, x0.9 per clip whose edges you nudged, x0.95 per comment on a
 * clip you didn't 👍 (up to 6). Unreviewed takes aren't scored.
 */
export function takeOutcome(r: ReturnType<typeof listRuns>[number]): TakeOutcome {
  const rv = readReview(r.id);
  const snap = join(CLIPS_DIR, r.id, "outline.md");
  const clips = r.clips.length;
  const verdicts = Object.values(rv.clips);
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
    run: r.id, videoStem: r.videoStem, created: r.created, engine: r.engine,
    hash: existsSync(snap) ? hashText(readFileSync(snap, "utf8")) : null,
    clips, dropped, nudged, comments, approved: rv.approved, rated, score,
  };
}

export type CoachState = {
  current: string;
  versions: (OutlineVersion & { label: string; takes: number; rated: number; mean: number | null })[];
  outcomes: Record<string, { score: number | null; hash: string | null }>;
  pending: Proposal | null;
  proposals: Omit<Proposal, "outline">[];
  rubric: (Rubric & { fresh: boolean }) | null;
  scorecard: Scorecard | null;
};

export function coachState(): CoachState {
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
  return {
    current, versions,
    outcomes: Object.fromEntries(outcomes.map((o) => [o.run, { score: o.score, hash: o.hash }])),
    pending: proposals.find((p) => p.status === "proposed" && p.parent === current) ?? null,
    proposals: proposals.map(({ outline, ...p }) => p),
    rubric: (() => {
      const r = readRubric(current) ?? latestRubric();
      return r ? { ...r, fresh: r.outline_hash === current } : null;
    })(),
    scorecard: latestScorecard(),
  };
}

function latestRubric(): Rubric | null {
  if (!existsSync(RUBRICS)) return null;
  return readdirSync(RUBRICS).filter((x) => x.endsWith(".json")).map((x) => readJson<Rubric | null>(join(RUBRICS, x), null))
    .filter((r): r is Rubric => !!r).sort((a, b) => b.at - a.at)[0] ?? null;
}

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

// ── Evidence ────────────────────────────────────────────────────────

export const bold = (t: string) => [...t.matchAll(/\*\*([^*]+?):\*\*/g)].map((m) => m[1].trim());
export const clipStr = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function takeEvidence(r: ReturnType<typeof listRuns>[number], o: TakeOutcome, label: (h: string | null) => string) {
  const rv = readReview(r.id);
  let data: ReturnType<typeof readClipData> | null = null;
  try {
    data = readClipData(join(CLIPS_DIR, r.id, "clip_script.md"));
  } catch {}
  const segs = data ? readTranscript(data.video) ?? [] : [];
  const line = (t: number, first: boolean) => {
    const inside = segs.filter((s) => s.end > t - 0.2 && s.start < t + 0.2);
    return clipStr((first ? inside[0] : inside[inside.length - 1])?.text ?? "", 140);
  };
  const out = [
    `### Take ${r.created} of "${clipStr(r.videoStem, 60)}" · ${r.engine} · outline ${label(o.hash)} · one-shot ${o.score ?? "not reviewed"}${o.approved ? " · approved" : ""}`,
  ];
  for (const c of r.clips) {
    const v = rv.clips[c.id];
    const status = (v?.status === "drop" ? "DROPPED before cutting" : v?.status === "keep" ? "kept" : o.approved ? "approved" : "unreviewed") +
      (v?.rating === 1 ? ", 👍 after watching the finished clip" : v?.rating === -1 ? ", 👎 after watching the finished clip" : "");
    const jev = r.jev?.clips?.[c.id];
    const low = (jev?.rows ?? []).filter((x: any) => x.value < 0.4).map((x: any) => x.label);
    const moves = c.edit?.segments?.map((s: any) => s.zoom ?? "none").join("/") ?? "";
    out.push(
      `- Clip ${c.id} "${clipStr(c.title, 60)}" ${(c.end - c.start).toFixed(0)}s: ${status}${v?.nudges ? `, edges nudged ${v.nudges}x` : ""}` +
        `${jev ? `, Jev overall ${Math.round(jev.overall * 100)}, tone ${jev.tone?.key}${low.length ? `, low: ${low.join(", ")}` : ""}` : ""}` +
        `${moves ? `, moves ${moves}${c.edit?.transitions?.length ? ` via ${c.edit.transitions.join("/")}` : ""}` : ""}`,
      `  opens "${line(c.edit?.segments?.[0]?.start ?? c.start, true)}" · ends "${line(c.edit?.segments?.at(-1)?.end ?? c.end, false)}"`,
      ...(c.file && readWatch(r.id, c.id) ? [`  finished clip: ${watchSummary(readWatch(r.id, c.id))}`] : []),
      ...(v?.comments ?? []).filter((x) => x.by !== "agent").map((x) => `  your comment: "${clipStr(x.text, 240)}"`),
    );
  }
  for (const x of rv.comments.filter((x) => x.by !== "agent")) out.push(`- Comment on the whole take: "${clipStr(x.text, 300)}"`);
  return out.join("\n");
}

// ── The coach ───────────────────────────────────────────────────────

/** Evidence for a coach run: this video's recent takes (reviewed first), plus a few reviewed takes from other videos. */
export function selectTakes(input: { video?: string }) {
  const state = coachState();
  const label = (h: string | null) => (h ? state.versions.find((v) => v.hash === h)?.label ?? "?" : "unrecorded");
  const cur = state.versions.find((v) => v.hash === state.current)!;
  const runs = listRuns();
  const outcomes = new Map(runs.map((r) => [r.id, takeOutcome(r)]));
  const stem = input.video?.replace(/\.[^.]+$/, "");
  const byRecency = (a: typeof runs[number], b: typeof runs[number]) => b.created.localeCompare(a.created);
  const here = runs.filter((r) => !stem || r.videoStem === stem).sort((a, b) => Number(outcomes.get(b.id)!.rated) - Number(outcomes.get(a.id)!.rated) || byRecency(a, b)).slice(0, 4);
  const elsewhere = runs.filter((r) => !here.includes(r) && outcomes.get(r.id)!.rated).sort(byRecency).slice(0, 2);
  const takes = [...here, ...elsewhere];
  if (!takes.length) throw new Error("No takes yet. Plan and review a take first; the coach learns from how it went.");
  return { state, label, cur, takes, outcomes, ratedCount: takes.filter((r) => outcomes.get(r.id)!.rated).length };
}

/** How one clip went for you: 1 good, 0 bad, 0.5 kept but corrected or commented on, null unreviewed. */
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

export async function coachOutline(ctx: JobContext, input: { video?: string; direction?: string }) {
  const outline = readText(OUTLINE_FILE);
  if (!outline) throw new Error("No clip_outline.md to improve");
  const { state, label, cur, takes, outcomes, ratedCount } = selectTakes(input);
  ctx.log(`Coaching outline ${cur.label} from ${takes.length} take(s), ${ratedCount} reviewed${input.direction ? `, with your direction` : ""}`);
  if (!ratedCount) ctx.log("None of these takes are reviewed yet, so there's little signal. Keep/drop, nudge or comment on clips first for better proposals.", "warn");

  // Retrieval: the best-scoring other versions, and what earlier proposals did to the score.
  const best = state.versions.filter((v) => v.hash !== state.current && v.mean !== null).sort((a, b) => b.mean! - a.mean!).slice(0, 2);
  const tried = state.proposals.filter((p) => p.status === "applied").slice(0, 6).map((p) => {
    const before = state.versions.find((v) => v.hash === p.parent);
    const after = state.versions.find((v) => v.hash === p.hash);
    return `- ${before?.label ?? "?"} → ${after?.label ?? "?"}: "${clipStr(p.hypothesis, 200)}" · one-shot ${before?.mean ?? "n/a"} → ${after?.mean ?? "not yet reviewed"} (${after?.rated ?? 0} reviewed takes)`;
  });
  const history = historyPaths(outline).map((p) => readText(p)).join("\n").slice(-2500);

  const prompt = `You improve a clip outline: the instructions a clipping pipeline follows to pick and edit short vertical clips from long videos.
Goal: the pipeline should one-shot it. The first take should be approved with no clips dropped, no edges nudged and no comments.
The one-shot score (0-100) is the share of clips kept (a thumbs-down on a finished clip counts as dropped), x0.85 if not approved, x0.9 per nudged clip, x0.95 per comment.
A thumbs up or down after watching the finished clip is the strongest signal; approval alone mostly means "worth cutting".

How the outline is used: an LLM reads it once and writes the questions a scoring model (Jev) asks about every candidate opening line, closing line and clip.
Jev also chooses camera moves and transitions per part from the allowed lists. The Editor reads the bold "**Label:** value" settings literally.
So be concrete: describe what a good opening line, ending and clip sound like in this material, and what to avoid.

Rules:
- Change only what the evidence supports. Keep everything that works. Small, targeted edits beat rewrites.
- Keep every "## " section and every "**Label:** value" setting, in the same format. You may change their values.
- Turn repeated complaints and dropped clips into explicit rules (what to avoid, what must be present).
- If an earlier change lowered the score, don't repeat it. If a best version did something better, borrow it.
- The outline is shared: it is used for whichever video is planned next. Don't add rules tied to one video unless the direction asks for it.
- Takes marked "outline unrecorded" may have been planned with a different outline. Weigh them lightly and don't infer from differences between them.
${input.direction ? `- The editor's direction for this revision: "${input.direction}"\n` : ""}
## Current outline (${cur.label}, one-shot ${cur.mean ?? "not yet scored"} over ${cur.rated} reviewed takes)
${outline}

## Evidence from takes
${takes.map((r) => takeEvidence(r, outcomes.get(r.id)!, label)).join("\n\n")}

${best.length ? `## Best-scoring earlier outline versions\n${best.map((v) => `### ${v.label} (one-shot ${v.mean} over ${v.rated} takes)\n${clipStr(versionText(v.hash), 3500)}`).join("\n\n")}\n` : ""}
${tried.length ? `## Earlier coach changes and what they did\n${tried.join("\n")}\n` : ""}
${history.trim() ? `## Clip history log (posted clips and their performance)\n${history}\n` : ""}
Reply with ONLY JSON:
{"hypothesis": "one sentence: what this revision should fix and why",
 "keep": "one sentence: what is working and was left alone",
 "changes": [{"section": "section name", "change": "what you changed", "evidence": "which take/clip/comment supports it"}],
 "outline": "the full revised outline markdown"}`;

  ctx.progress(0.1, `asking ${MODELS.plan[0]}`);
  let cost = 0;
  let raw: any;
  let model = MODELS.plan[0];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await openrouter({ temperature: 0.4, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
    ctx.addCost(res.usage?.cost);
    cost += res.usage?.cost ?? 0;
    model = res.model;
    try {
      raw = extractJson(res.content);
      if (typeof raw?.outline === "string" && raw.outline.trim().length > outline.length * 0.5) break;
      throw new Error("the revised outline was missing or too short");
    } catch (e) {
      if (attempt === 2) throw new Error(`The coach's reply wasn't usable: ${e instanceof Error ? e.message : e}`);
      ctx.log(`Retrying: ${e instanceof Error ? e.message : e}`, "warn");
    }
  }
  const revised = String(raw.outline).replace(/\r\n/g, "\n").trim() + "\n";
  const missing = bold(outline).filter((l) => !bold(revised).includes(l));
  const lost = [...outline.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim()).filter((s) => !revised.includes(`## ${s}`));
  const warnings = [
    ...(missing.length ? [`Settings removed: ${missing.join(", ")}`] : []),
    ...(lost.length ? [`Sections removed: ${lost.join(", ")}`] : []),
  ];
  const p: Proposal = {
    id: `p${Date.now().toString(36)}`, at: Date.now(), status: "proposed",
    parent: state.current, hash: hashText(revised), outline: revised,
    changes: (Array.isArray(raw.changes) ? raw.changes : []).slice(0, 12).map((c: any) => ({ section: String(c.section ?? ""), change: String(c.change ?? ""), evidence: String(c.evidence ?? "") })),
    hypothesis: String(raw.hypothesis ?? "").slice(0, 400), keep: String(raw.keep ?? "").slice(0, 400), warnings,
    takes: takes.map((r) => r.id), direction: input.direction, model, cost, mode: "llm",
  };
  if (p.hash === state.current) throw new Error("The coach proposed no changes. Review more clips (keep, drop, nudge, comment) to give it signal.");
  saveProposal(p);
  ctx.log(`Proposed ${p.changes.length} change(s): ${p.hypothesis}`);
  for (const w of warnings) ctx.log(w, "warn");
  ctx.progress(1, "proposal ready");
  return { proposal: p.id, changes: p.changes.length, hypothesis: p.hypothesis, warnings };
}
