// Outline coach on System One. The LLM only writes (the Rubric step); Jev judges:
//   1. Clip transcript  make sure every finished clip in the evidence has been watched and heard
//   2. Rubric           Hybrid: the LLM's rules and rewrites; System One: one rule per section
//   3. Rules            Jev rates every clip on every rule, blind to your verdict
//   4. Code             per rule: how often clips follow it, and how kept/liked clips differ from dropped ones
//   5. Rewrites         per section, Jev chooses between the current text and the rewrites, given 4 and your feedback
//   6. Code             assembles the revised outline from the winning rewrites; you apply it in the Coach node
import { join } from "node:path";
import type { JobContext } from "../jobs";
import { decide, noul, type Question } from "../jev";
import { pool } from "../lib";
import { CLIPS_DIR, OUTLINE_FILE, readClipData, readText, readTranscript } from "../library";
import { readReview } from "../review";
import {
  bold, clipReward, clipStr, hashText, saveProposal, saveRubric, saveScorecard, selectTakes, takeEvidence,
  type Proposal, type Rubric, type Scorecard,
} from "./coach";
import { compileRubric, defaultRubric, replaceSection, sectionsOf } from "./rubric";
import { readWatch, watchClips, watchSummary } from "./watch";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export async function coachOutlineJev(ctx: JobContext, input: { video?: string; direction?: string; hybrid: boolean }) {
  const outline = readText(OUTLINE_FILE).replace(/\r\n/g, "\n");
  if (!outline) throw new Error("No clip_outline.md to improve");
  const hash = hashText(outline);
  const { cur, takes, outcomes, label, ratedCount } = selectTakes(input);
  ctx.log(`Coaching outline ${cur.label} with Jev from ${takes.length} take(s), ${ratedCount} reviewed`);
  let cost = 0;
  let calls = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));

  // 1. Clip transcripts for every finished clip in the evidence.
  ctx.progress(0.02, "watching finished clips");
  for (const r of takes.filter((t) => t.clips.some((c) => c.file))) {
    try {
      await watchClips({ ...ctx, addCost, progress: () => {} }, r.id);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.log(`Couldn't watch the clips of ${r.created}: ${e instanceof Error ? e.message : e}`, "warn");
    }
  }

  // 2. Rubric.
  ctx.progress(0.3, input.hybrid ? "LLM writing the rubric" : "rubric from the outline's sections");
  const rubric: Rubric = input.hybrid
    ? await compileRubric({ ...ctx, addCost }, { outline, evidence: takes.map((t) => takeEvidence(t, outcomes.get(t.id)!, label)).join("\n\n"), direction: input.direction })
    : defaultRubric(outline);
  saveRubric(rubric);

  // 3. Jev rates every clip on every rule. Your verdict is left out so the ratings stay unbiased.
  const items = takes.flatMap((r) => {
    let data: ReturnType<typeof readClipData> | null = null;
    try {
      data = readClipData(join(CLIPS_DIR, r.id, "clip_script.md"));
    } catch {}
    const segs = data ? readTranscript(data.video) ?? [] : [];
    return r.clips.map((c) => ({ r, c, segs, reward: clipReward(r.id, c.id), watch: c.file ? readWatch(r.id, c.id) : null }));
  }).filter((x) => x.reward !== null || x.watch).slice(0, 24);
  if (!items.length) throw new Error("No reviewed or finished clips to learn from yet.");
  const ruleQ: Record<string, Question> = Object.fromEntries(rubric.rules.map((q) => [q.key, { type: "noul", instructions: q.question }]));
  ctx.log(`Jev: rating ${items.length} clip(s) on ${rubric.rules.length} rule(s)${items.some((x) => x.watch) ? ", using what the finished clips say and show" : ""}`);
  let done = 0;
  const rated = await pool(items, 8, async (x) => {
    const e = x.c.edit;
    const planned = (e?.segments?.length ? e.segments : [{ start: x.c.start, end: x.c.end }])
      .map((s) => x.segs.filter((l) => l.end > s.start && l.start < s.end).map((l) => l.text).join(" ")).join(" … ");
    const d = await decide({
      outline_summary: rubric.diagnosis || undefined,
      clip_title: x.c.title,
      hook_card: e?.title,
      seconds: Math.round(x.c.end - x.c.start),
      clip_transcript: clipStr(x.watch?.audio?.text || planned, 3000),
      ...(x.watch ? { finished_clip: watchSummary(x.watch), frames: x.watch.frames.map((f) => `${f.t.toFixed(0)}s ${f.desc ?? ""}${f.effect ? ` [${f.effect}]` : ""}${f.captions ? ` captions: ${f.captions}` : ""}`).slice(0, 14) } : {}),
      edit: e?.segments?.length ? { parts: e.segments.map((s) => s.zoom ?? "none"), transitions: e.transitions, looks: e.segments.map((s) => s.look ?? "") } : undefined,
    }, ruleQ, ctx.signal);
    addCost(d.cost);
    calls++;
    ctx.progress(0.35 + 0.4 * (++done / items.length), `rules ${done}/${items.length}`);
    return { ...x, answers: Object.fromEntries(rubric.rules.map((q) => [q.key, noul(d.answers[q.key])])) };
  }, ctx.signal);

  // 4. Per rule: followed how often, and on kept/liked vs dropped/disliked clips.
  const rules = rubric.rules.map((q) => {
    const all = rated.map((x) => x.answers[q.key]);
    const good = rated.filter((x) => x.reward !== null && x.reward >= 0.75).map((x) => x.answers[q.key]);
    const bad = rated.filter((x) => x.reward !== null && x.reward <= 0.25).map((x) => x.answers[q.key]);
    return { key: q.key, section: q.section, rule: q.rule, followed: +(mean(all) ?? 0).toFixed(2), good: mean(good), bad: mean(bad), n: all.length };
  });
  const weak = rules.filter((r) => r.followed < 0.5).sort((a, b) => a.followed - b.followed);
  if (!rated.some((x) => x.reward !== null && x.reward <= 0.25)) {
    ctx.log("No dropped or 👎 clips in the evidence, so Jev can't tell which rules predict your verdict. 👎 the finished clips you don't like to sharpen it.", "warn");
  }
  ctx.log(`Rules followed least: ${weak.slice(0, 4).map((r) => `${r.rule} (${pct(r.followed)})`).join("; ") || "none under 50%"}`);

  // 5. Jev chooses per section: keep, or one of the rewrites.
  const verdicts = { kept: rated.filter((x) => (x.reward ?? 0) >= 0.75).length, corrected: rated.filter((x) => x.reward === 0.5).length, dropped: rated.filter((x) => x.reward === 0).length, unreviewed: rated.filter((x) => x.reward === null).length };
  const feedback = takes.flatMap((r) => {
    const rv = readReview(r.id);
    return [...rv.comments, ...Object.values(rv.clips).flatMap((c) => c.comments)].filter((c) => c.by !== "agent").map((c) => clipStr(c.text, 200));
  }).slice(0, 12);
  const secs = sectionsOf(outline);
  const decisions: Scorecard["decisions"] = [];
  let revised = outline;
  await Promise.all(rubric.sections.map(async (s) => {
    const current = secs.find((x) => x.name === s.section);
    if (!current) return;
    const criteria: Record<string, string> = { keep: `Keep the current text: ${clipStr(current.body, 500)}` };
    for (const v of s.variants) criteria[v.key] = `${v.summary}: ${clipStr(v.text, 500)}`;
    const d = await decide({
      section: s.section,
      why_it_may_be_hurting: s.why,
      diagnosis: rubric.diagnosis,
      rules_in_this_section: rules.filter((r) => r.section === s.section).map((r) => ({ rule: r.rule, followed: pct(r.followed), on_kept_clips: r.good === null ? "n/a" : pct(r.good), on_dropped_clips: r.bad === null ? "n/a" : pct(r.bad) })),
      rules_followed_least: weak.slice(0, 5).map((r) => `${r.rule} (${pct(r.followed)})`),
      your_verdicts: verdicts,
      your_comments: feedback,
      ...(input.direction ? { your_direction: input.direction } : {}),
    }, { version: { type: "choice", instructions: "Which version of this outline section makes the next take most likely to be approved as-is, with every clip kept and liked?", criteria } }, ctx.signal);
    addCost(d.cost);
    calls++;
    const a = d.answers.version;
    if (a?.type !== "choice") return;
    const v = s.variants.find((x) => x.key === a.choice);
    const p = a.probabilities[a.choice] ?? a.confidence;
    // A rewrite needs a clear win: at least 40%, and 10 points ahead of the next option (keeping included).
    const second = Math.max(0, ...Object.entries(a.probabilities).filter(([k]) => k !== a.choice).map(([, x]) => x));
    const applied = !!v && p >= 0.4 && p - second >= 0.1;
    decisions.push({ section: s.section, chosen: a.choice, summary: v?.summary ?? "keep the current text", p, options: a.probabilities, applied });
  }));
  ctx.progress(0.9, "assembling");
  decisions.sort((a, b) => secs.findIndex((x) => x.name === a.section) - secs.findIndex((x) => x.name === b.section));
  for (const d of decisions.filter((x) => x.applied)) {
    const v = rubric.sections.find((s) => s.section === d.section)!.variants.find((x) => x.key === d.chosen)!;
    revised = replaceSection(revised, d.section, v.text);
  }

  // 6. A proposal when Jev picked any rewrite; always a scorecard.
  const sc: Scorecard = {
    id: `s${Date.now().toString(36)}`, at: Date.now(), mode: input.hybrid ? "hybrid" : "jev", outline_hash: hash,
    rubric_source: rubric.source, cost, calls, diagnosis: rubric.diagnosis, rules, decisions,
    clips: rated.map((x) => ({ run: x.r.id, clip: x.c.id, title: x.c.title, reward: x.reward, watched: !!x.watch, answers: x.answers })),
  };
  const changed = decisions.filter((d) => d.applied);
  if (changed.length && hashText(revised) !== hash) {
    const missing = bold(outline).filter((l) => !bold(revised).includes(l));
    const p: Proposal = {
      id: `p${Date.now().toString(36)}`, at: Date.now(), status: "proposed", parent: hash, hash: hashText(revised), outline: revised.trim() + "\n",
      changes: changed.map((d) => {
        const s = rubric.sections.find((x) => x.section === d.section)!;
        const inSec = rules.filter((r) => r.section === d.section);
        return {
          section: d.section, change: d.summary,
          evidence: `Jev ${pct(d.p)} for this rewrite vs ${pct(d.options.keep ?? 0)} to keep it. ${s.why}${inSec.length ? ` Rules here followed ${inSec.map((r) => pct(r.followed)).join(", ")}.` : ""}`,
        };
      }),
      hypothesis: rubric.diagnosis || `Jev picked ${changed.length} rewrite(s)`,
      keep: decisions.filter((d) => !d.applied).map((d) => `${d.section} (keep ${pct(d.options.keep ?? d.p)})`).join(", ") || "Every section the rubric didn't flag.",
      warnings: missing.length ? [`Settings removed: ${missing.join(", ")}`] : [],
      takes: takes.map((t) => t.id), direction: input.direction, model: `Jev${rubric.model ? ` + ${rubric.model}` : ""}`, cost,
      mode: input.hybrid ? "hybrid" : "jev", scorecard: sc.id,
    };
    saveProposal(p);
    sc.proposal = p.id;
    ctx.log(`Jev picked ${changed.length} rewrite(s): ${changed.map((d) => `${d.section} (${pct(d.p)})`).join(", ")}`);
  } else {
    ctx.log(rubric.sections.length ? "Jev kept every section as it is; see the scorecard for which rules the clips miss" : "Scorecard only: System One mode has no rewrites to choose between (use Hybrid for proposals)");
  }
  saveScorecard(sc);
  ctx.progress(1, "coached");
  return { scorecard: sc.id, proposal: sc.proposal ?? null, calls, cost, weakest: weak.slice(0, 3).map((r) => r.rule) };
}
