// Planner, System One and Hybrid modes. Jev can't write a clip list, so the work is split the other
// way round: code generates candidates, Jev answers typed questions about each one, and code ranks
// and picks. The questions come from a brief: System One's fixed default, or (Hybrid) one an LLM
// compiled from the outline for this plan.
//
//   A. openers   every line:          the brief's opener questions
//   B. endings   every line:          the brief's ending questions
//   C. windows   best openers x ends: the brief's clip questions, tone, direction, feedback, visuals
//   D. select    greedy by score, gates, no overlaps, spread across tones, avoid moments already clipped
// Edit decisions happen in the next step (design.ts), which the plan job runs right after.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import type { JobContext } from "../jobs";
import { decide, level, noul, pick, type Question } from "../jev";
import { listRuns, transcriptDir } from "../library";
import { hashText } from "./coach";
import { fmt, pool, type Segment } from "../lib";
import { feedbackDigest } from "../review";
import { planContext, writeRun, type PlanInput, type PlannedClip } from "./plan";
import { readVision, verticalSafe, visualsIn } from "./vision";
import { autoEdit, readEditStyle } from "./edit";
import { compileBrief, defaultBrief, type BriefQuestion, type JevBrief } from "./jev-brief";
import { designEdits } from "./design";

export type JevClipScores = {
  overall: number; hook: number; cold: number; payoff: number; complete: number;
  fit: number; standalone: number; respectful: number; tone: { key: string; p: number };
  direction?: number; against?: number; repeat?: boolean;
  /** From the vision transcript: visuals hold attention (Jev), subject survives a centred 9:16 crop (measured). */
  visual?: number; vertical?: number;
  /** Every brief question's answer (0..1) with its label, in brief order: what the UI shows. */
  rows?: { key: string; label: string; value: number }[];
};

const clip = (t: string, n = 240) => (t.length > n ? t.slice(0, n) + "…" : t);

/** The outline sections that describe the audience and tone, trimmed to fit Jev's state. */
function outlineBrief(outline: string): string {
  const grab = (h: string) => outline.match(new RegExp(`^## ${h}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1].trim() ?? "";
  return clip(`${grab("Audience")}\n\n${grab("Clipping tone")}`.trim() || outline, 1800);
}

const toQuestions = (qs: BriefQuestion[]): Record<string, Question> =>
  Object.fromEntries(qs.map((q) => [q.key, q.type === "score" ? { type: "score", instructions: q.instructions, criteria: q.criteria } : { type: "noul", instructions: q.instructions }]));

const valueOf = (q: BriefQuestion, a: any) => (q.type === "score" ? level(a, q.criteria.length) : noul(a));

/** Weighted mean of a brief section's answers (weights of 0 only gate). */
function weighted(qs: BriefQuestion[], vals: Record<string, number>) {
  const w = qs.reduce((n, q) => n + q.weight, 0);
  return w ? qs.reduce((n, q) => n + q.weight * (vals[q.key] ?? 0), 0) / w : 0;
}

// ── The Brief node: the LLM step between the Outline and the Planner ──
// Compiled once per video and outline version, cached next to the transcript, reused by every
// Hybrid take until the outline changes. Your per-take direction goes to Jev directly.
export const briefFile = (video: string) => join(transcriptDir(video), "jev_brief.json");
export type BriefCache = { at: number; outline_hash: string; cost: number; brief: JevBrief };

export function readBriefCache(video: string): BriefCache | null {
  try {
    return existsSync(briefFile(video)) ? JSON.parse(readFileSync(briefFile(video), "utf8")) : null;
  } catch {
    return null;
  }
}

export async function buildBrief(ctx: JobContext, video: string): Promise<JevBrief> {
  const { segs, outline } = planContext(video, { video });
  const sample = segs.filter((_, i) => i % Math.max(1, Math.floor(segs.length / 40)) === 0).slice(0, 40).map((s) => s.text).join("\n");
  let cost = 0;
  const brief = await compileBrief(
    { ...ctx, addCost: (c?: number) => ((cost += c ?? 0), ctx.addCost(c)) },
    { outline, feedback: clip(feedbackDigest(video), 1500), sample: clip(sample, 3000), style: readEditStyle(outline), summary: outlineBrief(outline) },
  );
  mkdirSync(transcriptDir(video), { recursive: true });
  const cache: BriefCache = { at: Date.now(), outline_hash: hashText(outline), cost, brief };
  writeFileSync(briefFile(video), JSON.stringify(cache, null, 1), "utf8");
  ctx.progress(1, "brief ready");
  return brief;
}

export async function planClipsJev(ctx: JobContext, video: string, input: PlanInput & { hybrid?: boolean }) {
  const { segs, outline, count, min, max, aspect, historyFile } = planContext(video, input);
  const editStyle = readEditStyle(outline);
  const summary = outlineBrief(outline);
  const feedback = clip(feedbackDigest(video), 1500);
  const notes = input.notes?.trim();
  const vt = readVision(video);
  if (vt) ctx.log(`Using the vision transcript (${vt.shots.length} shots) alongside the audio`);

  // Hybrid: the Brief node's output. Reuse it if it was compiled from this outline; else compile it now.
  let brief: JevBrief = defaultBrief(summary);
  if (input.hybrid) {
    const cached = readBriefCache(video);
    if (cached && cached.outline_hash === hashText(outline)) {
      brief = cached.brief;
      ctx.log(`Using the brief compiled ${new Date(cached.at).toLocaleString()} (${brief.opener.length + brief.ending.length + brief.window.length} questions)`);
    } else {
      ctx.progress(0.01, "LLM compiling the outline into Jev's brief");
      ctx.log(cached ? "The outline changed since the last brief; recompiling it" : "No brief for this video yet; compiling it");
      brief = await buildBrief({ ...ctx, progress: () => {} }, video);
    }
  }
  ctx.progress(0.03, "brief ready");

  const stats = { calls: 0, cost: 0, model: "" };
  const ask = async (state: unknown, q: Record<string, Question>) => {
    const d = await decide(state, q, ctx.signal);
    stats.calls++;
    stats.cost += d.cost;
    stats.model = d.model;
    ctx.addCost(d.cost);
    return d.answers;
  };
  const lastStart = segs[segs.length - 1].end - min;
  const gate = (key: string) => brief.gates.find((g) => g.key === key)?.min;

  // ── A. openers ────────────────────────────────────────────────
  const openers = segs.map((s, i) => ({ i, s })).filter(({ s }) => s.start <= lastStart && s.text.length > 3);
  ctx.log(`Jev pass A: scoring ${openers.length} possible opening lines (${brief.opener.map((q) => q.label).join(", ")})`);
  let done = 0;
  const openerQ = toQuestions(brief.opener);
  const opened = await pool(openers, 16, async ({ i, s }) => {
    const a = await ask({ brief: brief.summary, opening_line: s.text, next_line: segs[i + 1]?.text ?? "", line_before: segs[i - 1]?.text ?? "" }, openerQ);
    ctx.progress(0.03 + 0.35 * (++done / openers.length), `openers ${done}/${openers.length}`);
    const vals = Object.fromEntries(brief.opener.map((q) => [q.key, valueOf(q, a[q.key])]));
    return { i, vals, score: weighted(brief.opener, vals) };
  }, ctx.signal);

  // ── B. endings ────────────────────────────────────────────────
  ctx.log(`Jev pass B: scoring ${segs.length} possible closing lines (${brief.ending.map((q) => q.label).join(", ")})`);
  done = 0;
  const endingQ = toQuestions(brief.ending);
  const ended = await pool(segs.map((s, j) => ({ j, s })), 16, async ({ j, s }) => {
    const a = await ask({ brief: brief.summary, closing_line: s.text, line_before: segs[j - 1]?.text ?? "", line_after: segs[j + 1]?.text ?? "" }, endingQ);
    ctx.progress(0.38 + 0.27 * (++done / segs.length), `endings ${done}/${segs.length}`);
    const vals = Object.fromEntries(brief.ending.map((q) => [q.key, valueOf(q, a[q.key])]));
    return { j, vals, score: weighted(brief.ending, vals) };
  }, ctx.signal);

  // ── C. windows ────────────────────────────────────────────────
  // Top openers (spaced out so one strong passage doesn't hog the budget) x their best allowed endings.
  const openerOk = (o: (typeof opened)[number]) => brief.opener.every((q) => gate(q.key) === undefined || o.vals[q.key] >= gate(q.key)!);
  // Gates are soft when they'd leave too little to choose from: fall back to every opener.
  const gatedOpeners = opened.filter(openerOk);
  if (gatedOpeners.length < count * 4) ctx.log(`Only ${gatedOpeners.length} opening lines pass the brief's gates; considering all of them`, "warn");
  const topOpeners = [...(gatedOpeners.length >= count * 4 ? gatedOpeners : opened)].sort((a, b) => b.score - a.score);
  const chosenOpeners: typeof opened = [];
  for (const o of topOpeners) {
    if (chosenOpeners.length >= Math.max(24, count * 8)) break;
    if (chosenOpeners.some((c) => Math.abs(segs[c.i].start - segs[o.i].start) < 8)) continue;
    chosenOpeners.push(o);
  }
  const windows = chosenOpeners.flatMap((o) => {
    const start = segs[o.i].start;
    return segs
      .map((s, j) => ({ j, dur: s.end - start }))
      .filter(({ j, dur }) => j >= o.i && dur >= min && dur <= max)
      .sort((a, b) => ended[b.j].score - ended[a.j].score)
      .slice(0, 3)
      .map(({ j }) => ({ o, j }));
  });

  const previous = listRuns().filter((r) => r.videoStem === parse(video).name).flatMap((r) => r.clips.map((c) => [c.start, c.end] as const));
  ctx.log(`Jev pass C: judging ${windows.length} candidate clips (${brief.window.map((q) => q.label).join(", ")})${notes ? " and your direction" : ""}`);
  done = 0;
  const windowQ = toQuestions(brief.window);
  const judged = await pool(windows, 16, async ({ o, j }) => {
    const lines = segs.slice(o.i, j + 1).map((s) => s.text);
    const q: Record<string, Question> = { ...windowQ, tone: { type: "choice", instructions: "What is the clip's dominant appeal?", criteria: brief.tones } };
    if (notes) q.direction = { type: "noul", instructions: `The clip matches this direction from the editor: "${notes}"` };
    if (feedback) q.against = { type: "noul", instructions: "The clip repeats something the editor's feedback asked to avoid, or resembles a clip they dropped." };
    const visuals = visualsIn(vt, segs[o.i].start, segs[j].end);
    if (visuals.length) q.visual = { type: "noul", instructions: "The shot log shows visuals that support what is being said and would hold attention on a phone screen." };
    const a = await ask(
      {
        brief: brief.summary, ...(notes ? { direction: notes } : {}), ...(feedback ? { editor_feedback: feedback } : {}),
        clip_transcript: clip(lines.join("\n"), 6000),
        ...(visuals.length ? { shot_log: visuals } : {}),
      },
      q,
    );
    ctx.progress(0.65 + 0.25 * (++done / windows.length), `candidates ${done}/${windows.length}`);
    const start = segs[o.i].start;
    const end = segs[j].end;
    const wvals = Object.fromEntries(brief.window.map((qq) => [qq.key, valueOf(qq, a[qq.key])]));
    const all = { ...o.vals, ...ended[j].vals, ...wvals };
    const tone = pick(a.tone);
    const s: JevClipScores = {
      // Legacy fields keep System One takes' breakdowns readable; rows carry whatever the brief asked.
      hook: all.hook ?? o.score, cold: all.cold ?? o.score, payoff: all.payoff ?? ended[j].score, complete: all.complete ?? ended[j].score,
      fit: all.fit ?? weighted(brief.window, wvals), standalone: all.standalone ?? 0, respectful: all.respectful ?? 1,
      tone,
      rows: [...brief.opener, ...brief.ending, ...brief.window].map((qq) => ({ key: qq.key, label: qq.label, value: all[qq.key] ?? 0 })),
      ...(notes ? { direction: noul(a.direction) } : {}),
      ...(feedback ? { against: noul(a.against) } : {}),
      ...(visuals.length ? { visual: noul(a.visual) } : {}),
      ...(() => {
        const v = verticalSafe(vt, segs[o.i].start, segs[j].end);
        return v === null ? {} : { vertical: v };
      })(),
      repeat: previous.some(([ps, pe]) => Math.min(end, pe) - Math.max(start, ps) > 0.5 * (end - start)),
      overall: 0,
    };
    const passes = brief.gates.every((g) => all[g.key] === undefined || all[g.key] >= g.min);
    const base = 0.25 * o.score + 0.2 * ended[j].score + 0.55 * weighted(brief.window, wvals);
    s.overall =
      (s.visual !== undefined ? 0.9 * base + 0.1 * s.visual : base) *
      (aspect === "9:16" && s.vertical !== undefined ? 0.85 + 0.15 * s.vertical : 1) *
      (s.direction !== undefined ? 0.5 + s.direction : 1) *
      (1 - 0.6 * (s.against ?? 0)) *
      (s.repeat ? 0.7 : 1) *
      (brief.preferredTones.includes(tone.key) ? 1 + 0.15 * tone.p : 1);
    return { start, end, i: o.i, j, s, passes };
  }, ctx.signal);

  // ── D. select ─────────────────────────────────────────────────
  const passing = judged.filter((w) => w.passes);
  // Too few pass the gates: the rest compete too, scored down 25%, rather than failing the plan.
  if (passing.length < count) {
    ctx.log(`Only ${passing.length} candidates pass the brief's gates; relaxing them for the rest (scored down 25%)`, "warn");
    for (const w of judged) if (!w.passes) w.s.overall *= 0.75;
  }
  const eligible = (passing.length >= count ? passing : judged).sort((a, b) => b.s.overall - a.s.overall);
  const picked: typeof eligible = [];
  const remaining = [...eligible];
  while (picked.length < count && remaining.length) {
    // Soft diversity: each already-picked clip of the same tone costs 10% (less for preferred tones).
    remaining.sort((a, b) => adjusted(b) - adjusted(a));
    const next = remaining.shift()!;
    if (picked.some((p) => next.start < p.end + 2 && next.end > p.start - 2)) continue;
    picked.push(next);
  }
  function adjusted(w: (typeof eligible)[number]) {
    const same = picked.filter((p) => p.s.tone.key === w.s.tone.key).length;
    return w.s.overall * (brief.preferredTones.includes(w.s.tone.key) ? 0.96 : 0.9) ** same;
  }
  if (!picked.length) throw new Error("Jev found no candidate clips in this video");
  picked.sort((a, b) => a.start - b.start);

  const toneLabel = (k: string) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const clips: PlannedClip[] = picked.map((w, n) => {
    const s = w.s;
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const low = (s.rows ?? []).filter((r) => r.value < 0.4).map((r) => `${r.label.toLowerCase()} is low (${pct(r.value)})`);
    return {
      id: n + 1,
      title: `${toneLabel(s.tone.key)} · ${fmt(w.start).replace(/^00:/, "")}`,
      start: w.start,
      end: w.end,
      hook: `Opens on "${clip(segs[w.i].text, 90)}"`,
      reason:
        `Jev: ${(s.rows ?? []).map((r) => `${r.label.toLowerCase()} ${pct(r.value)}`).join(", ")}, tone ${toneLabel(s.tone.key)} ${pct(s.tone.p)}` +
        (s.direction !== undefined ? `, matches direction ${pct(s.direction)}` : "") +
        (s.visual !== undefined ? `, visuals ${pct(s.visual)}` : "") +
        (s.vertical !== undefined ? `, 9:16-safe ${pct(s.vertical)}` : ""),
      on_screen_text: clip(segs[w.i].text, 60),
      edit_notes: [...low, s.repeat && "overlaps a moment from an earlier take"].filter(Boolean).join("; "),
      // The pieces; the design step decides camera moves, transitions and (hybrid) titles next.
      edit: autoEdit(w.start, w.end, segs, editStyle, vt),
    };
  });

  const engine = input.hybrid ? "hybrid" : "jev";
  ctx.log(`Jev made ${stats.calls} decisions for $${stats.cost.toFixed(4)}; picked ${clips.length} of ${eligible.length} eligible clips`);
  const alternatives = eligible
    .filter((w) => !picked.includes(w))
    .slice(0, 8)
    .map((w) => ({ start: w.start, end: w.end, overall: w.s.overall, tone: w.s.tone.key, opening: clip(segs[w.i].text, 90) }));

  const result = writeRun(ctx, video, { model: `${stats.model || "Jev"} (${input.hybrid ? "Hybrid" : "System One"})`, aspect, historyFile, clips, segs }, {
    "engine.json": { engine, model: stats.model, ...(brief.model ? { brief_model: brief.model } : {}) },
    "jev.json": {
      model: stats.model,
      stats: { calls: stats.calls, cost: stats.cost, openers: openers.length, endings: segs.length, candidates: windows.length, eligible: eligible.length },
      direction: notes ?? null,
      brief,
      clips: Object.fromEntries(picked.map((w, n) => [n + 1, w.s])),
      alternatives,
    },
  });

  // The step between the Planner and the Editor: design each clip's edit.
  ctx.progress(0.92, "designing edits");
  try {
    await designEdits({ ...ctx, progress: (v, stage) => ctx.progress(0.92 + 0.08 * v, stage) }, result.run, { hybrid: !!input.hybrid });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Edit design failed; the take keeps its automatic edit. Retry from the Edit design node. (${e instanceof Error ? e.message : e})`, "warn");
  }
  return result;
}
