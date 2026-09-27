// Step 6 · Coach (the LLM writes rewrites; Jev picks). It closes the loop back into the Outline:
//   1. evidence   the reviewed takes: your keep/drop, nudges and comments, and each clip's Check scores
//   2. stats      per check rule (code): how often clips follow it, on the clips you kept vs dropped
//   3. rewrites   the LLM writes two alternatives for each outline section the evidence (or the style
//                 reference) says should change. It writes; it doesn't decide
//   4. choose     per section, Jev picks keep or a rewrite, given the stats, your comments and the reference.
//                 A rewrite needs a clear win (at least 40%, and 10 points over the next option)
//   5. propose    code assembles the revised outline; you apply it (or not) in the Coach panel
import type { JobContext } from "../jobs";
import { decide } from "../jev";
import { MODELS, WRITER } from "../config";
import { extractJson, openrouter } from "../lib";
import { OUTLINE_FILE, readText } from "../library";
import { readReview } from "../review";
import { readCheck } from "./check";
import { clipReward, saveProposal, saveScorecard, selectTakes, takeEvidence, type Proposal, type Scorecard } from "./outlines";
import { ensureReference, readReference, referenceText } from "./reference";
import { bold, clipStr, hashText, replaceSection, sectionsOf } from "./text";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

type Rewrites = { diagnosis: string; sections: { section: string; why: string; variants: { key: string; summary: string; text: string }[] }[]; model: string; cost: number };

async function writeRewrites(ctx: JobContext, p: { outline: string; evidence: string; stats: string; reference: string; direction?: string }): Promise<Rewrites> {
  const secs = sectionsOf(p.outline);
  const prompt = `You write candidate rewrites of a clip outline: the instructions a clipping pipeline follows to pick, edit and title short vertical clips.
A scoring model (Jev) will choose, for each section you rewrite, between the current text and your rewrites, so write options, not a verdict.
The goal: the next take is accepted as-is, with every clip kept and nothing to fix.

## Outline
${p.outline}

## Evidence: reviewed takes, your verdict on each clip, what the finished clips show, and your comments
${p.evidence || "(no reviewed takes yet)"}

## How the finished clips did on the check rules (followed on all clips · on clips you kept · on clips you dropped)
${p.stats || "(no checked clips yet)"}
${p.reference ? `\n## Style reference: copy what the copy guide asks for\n${p.reference}\n` : ""}${p.direction ? `\n## The editor's direction for this revision\n${p.direction}\n` : ""}
Write up to ${p.reference ? 4 : 3} sections that should change (none if nothing should). For each:
{"section": "exact section name", "why": "one sentence citing the evidence${p.reference ? " or the reference" : ""}", "variants": [{"key": "a", "summary": "12 words max", "text": "the full new body of the section"}, {"key": "b", ...}]}
- Two genuinely different rewrites per section. Keep every "**Label:** value" line the section has; you may change the values.
- Turn repeated complaints and dropped clips into explicit rules. Rules that kept clips follow and dropped clips don't are working: keep them.
- The outline is shared across videos: no rules tied to one video. Takes marked "outline unrecorded" may have used another outline: weigh them lightly.
Also write "diagnosis": one sentence on the biggest reason takes aren't accepted as-is yet.
Reply with ONLY JSON: {"diagnosis": "...", "sections": [...]}`;
  const res = await openrouter({ temperature: 0.5, ...WRITER, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
  ctx.addCost(res.usage?.cost);
  const raw = extractJson(res.content);
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, p.reference ? 4 : 3).flatMap((x: any): Rewrites["sections"] => {
    const s = secs.find((y) => y.name === String(x.section ?? "").trim());
    if (!s) return [];
    const labels = bold(s.body);
    // A rewrite that drops one of the section's settings would break the renderer; leave it out.
    const variants = (Array.isArray(x.variants) ? x.variants : []).slice(0, 3)
      .map((v: any, i: number) => ({ key: String.fromCharCode(97 + i), summary: String(v.summary ?? "").slice(0, 120), text: String(v.text ?? "").trim() }))
      .filter((v: { text: string }) => v.text.length > 20 && labels.every((l) => bold(v.text).includes(l)) && v.text !== s.body.trim());
    return variants.length ? [{ section: s.name, why: String(x.why ?? "").slice(0, 300), variants }] : [];
  });
  ctx.log(`${res.model} via ${res.provider ?? "OpenRouter"}: ${res.usage?.completion_tokens ?? "?"} tokens`);
  return { diagnosis: String(raw.diagnosis ?? "").slice(0, 400), sections, model: res.model, cost: res.usage?.cost ?? 0 };
}

export async function coachOutline(ctx: JobContext, input: { video?: string; direction?: string }) {
  const outline = readText(OUTLINE_FILE).replace(/\r\n/g, "\n");
  if (!outline) throw new Error("The outline is empty");
  const hash = hashText(outline);
  await ensureReference(ctx);
  const { cur, takes, outcomes, label, ratedCount } = selectTakes(input);
  const ref = readReference();
  const refText = ref?.analysis ? referenceText(ref) : "";
  let cost = 0;
  let calls = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));
  ctx.log(`Coaching outline ${cur.label} from ${takes.length} take(s), ${ratedCount} reviewed${refText ? ", and the style reference" : ""}`);

  // 1-2. Evidence and per-rule stats from Check (clips rated blind to your verdict).
  const rows = takes.flatMap((t) => {
    const ck = readCheck(t.id);
    if (!ck) return [];
    return Object.entries(ck.clips).map(([id, c]) => ({ reward: clipReward(t.id, Number(id)), rules: c.rules, defs: ck.rules }));
  });
  const defs = new Map<string, { key: string; section: string; rule: string }>();
  for (const r of rows) for (const d of r.defs) defs.set(d.key, d);
  const rules: Scorecard["rules"] = [...defs.values()].map((d) => {
    const on = rows.filter((r) => d.key in r.rules);
    const all = on.map((r) => r.rules[d.key]);
    const good = on.filter((r) => r.reward !== null && r.reward >= 0.75).map((r) => r.rules[d.key]);
    const bad = on.filter((r) => r.reward !== null && r.reward <= 0.25).map((r) => r.rules[d.key]);
    return { key: d.key, section: d.section, rule: d.rule, followed: +(mean(all) ?? 0).toFixed(2), good: mean(good), bad: mean(bad), n: all.length };
  }).filter((r) => r.n > 0);
  const weak = [...rules].sort((a, b) => a.followed - b.followed).filter((r) => r.followed < 0.5);
  if (rows.length && !rows.some((r) => r.reward !== null && r.reward <= 0.25)) {
    ctx.log("No dropped clips in the evidence, so Jev can't tell which rules predict your verdict. Drop the clips you don't like to sharpen it.", "warn");
  }
  const stats = rules.map((r) => `- [${r.section || "general"}] ${r.rule}: ${pct(r.followed)} · kept ${r.good === null ? "n/a" : pct(r.good)} · dropped ${r.bad === null ? "n/a" : pct(r.bad)} (${r.n} clips)`).join("\n");

  // 3. The LLM writes the options.
  ctx.progress(0.2, "LLM writing rewrites");
  const evidence = takes.map((t) => takeEvidence(t, outcomes.get(t.id)!, label)).join("\n\n");
  const rw = await writeRewrites({ ...ctx, addCost }, { outline, evidence, stats, reference: refText, direction: input.direction }).catch((e): Rewrites => {
    if (ctx.signal.aborted) throw e;
    ctx.log(`The LLM rewrites failed (${e instanceof Error ? e.message : e}); saving the scorecard without proposing changes`, "warn");
    return { diagnosis: "", sections: [], model: MODELS.plan[0], cost: 0 };
  });
  ctx.log(`${rw.model}: ${rw.sections.length ? rw.sections.map((s) => `${s.section} (${s.variants.length} rewrites)`).join(", ") : "no section needs changing"}`);

  // 4. Jev chooses per section.
  ctx.progress(0.6, "Jev choosing");
  const verdicts = {
    kept: takes.reduce((n, t) => n + t.clips.filter((c) => (clipReward(t.id, c.id) ?? 0) >= 0.75).length, 0),
    dropped: takes.reduce((n, t) => n + t.clips.filter((c) => clipReward(t.id, c.id) === 0).length, 0),
  };
  const feedback = takes.flatMap((t) => {
    const rv = readReview(t.id);
    return [...rv.comments, ...Object.values(rv.clips).flatMap((c) => c.comments)].filter((c) => c.by !== "agent").map((c) => clipStr(c.text, 200));
  }).slice(0, 12);
  const secs = sectionsOf(outline);
  const decisions: Scorecard["decisions"] = [];
  await Promise.all(rw.sections.map(async (s) => {
    const current = secs.find((x) => x.name === s.section);
    if (!current) return;
    const criteria: Record<string, string> = { keep: `Keep the current text: ${clipStr(current.body, 500)}` };
    for (const v of s.variants) criteria[v.key] = `${v.summary}: ${clipStr(v.text, 500)}`;
    const d = await decide({
      section: s.section,
      why_it_may_need_changing: s.why,
      diagnosis: rw.diagnosis,
      rules_in_this_section: rules.filter((r) => r.section === s.section).map((r) => ({ rule: r.rule, followed: pct(r.followed), on_kept_clips: r.good === null ? "n/a" : pct(r.good), on_dropped_clips: r.bad === null ? "n/a" : pct(r.bad) })),
      rules_followed_least: weak.slice(0, 5).map((r) => `${r.rule} (${pct(r.followed)})`),
      your_verdicts: verdicts,
      your_comments: feedback,
      ...(input.direction ? { your_direction: input.direction } : {}),
      ...(ref?.analysis ? { style_reference: { copy_guide: ref.guide || "copy the overall style", summary: ref.analysis.profile.summary, traits: ref.analysis.profile.traits.filter((t) => t.section === s.section || !secs.some((x) => x.name === t.section)).map((t) => t.trait) } } : {}),
    }, {
      version: {
        type: "choice",
        instructions: ref?.analysis
          ? "Which version of this outline section makes the next take match the style reference in what the copy guide asks for, while staying likely to be accepted as-is with every clip kept?"
          : "Which version of this outline section makes the next take most likely to be accepted as-is, with every clip kept?",
        criteria,
      },
    }, ctx.signal);
    addCost(d.cost);
    calls++;
    const a = d.answers.version;
    if (a?.type !== "choice") return;
    const v = s.variants.find((x) => x.key === a.choice);
    const p = a.probabilities[a.choice] ?? a.confidence;
    const second = Math.max(0, ...Object.entries(a.probabilities).filter(([k]) => k !== a.choice).map(([, x]) => x));
    const applied = !!v && p >= 0.4 && p - second >= 0.1;
    decisions.push({ section: s.section, chosen: a.choice, summary: v?.summary ?? "keep the current text", p, options: a.probabilities, applied });
  }));
  decisions.sort((a, b) => secs.findIndex((x) => x.name === a.section) - secs.findIndex((x) => x.name === b.section));

  // 5. Assemble the proposal.
  ctx.progress(0.9, "assembling");
  let revised = outline;
  for (const d of decisions.filter((x) => x.applied)) {
    const v = rw.sections.find((s) => s.section === d.section)!.variants.find((x) => x.key === d.chosen)!;
    revised = replaceSection(revised, d.section, v.text);
  }
  const sc: Scorecard = { id: `s${Date.now().toString(36)}`, at: Date.now(), outline_hash: hash, cost, calls, diagnosis: rw.diagnosis, rules, decisions };
  const changed = decisions.filter((d) => d.applied);
  if (changed.length && hashText(revised) !== hash) {
    const missing = bold(outline).filter((l) => !bold(revised).includes(l));
    const p: Proposal = {
      id: `p${Date.now().toString(36)}`, at: Date.now(), status: "proposed", parent: hash, hash: hashText(revised), outline: revised.trim() + "\n",
      changes: changed.map((d) => {
        const s = rw.sections.find((x) => x.section === d.section)!;
        const inSec = rules.filter((r) => r.section === d.section);
        return {
          section: d.section, change: d.summary,
          evidence: `Jev ${pct(d.p)} for this rewrite vs ${pct(d.options.keep ?? 0)} to keep it. ${s.why}${inSec.length ? ` Rules here followed ${inSec.map((r) => pct(r.followed)).join(", ")}.` : ""}`,
        };
      }),
      hypothesis: rw.diagnosis || `Jev picked ${changed.length} rewrite(s)`,
      keep: decisions.filter((d) => !d.applied).map((d) => `${d.section} (keep ${pct(d.options.keep ?? d.p)})`).join(", ") || "Every section the evidence didn't flag.",
      warnings: missing.length ? [`Settings removed: ${missing.join(", ")}`] : [],
      takes: takes.map((t) => t.id), direction: input.direction, model: `${rw.model} + Jev`, cost, scorecard: sc.id,
    };
    saveProposal(p);
    sc.proposal = p.id;
    ctx.log(`Jev picked ${changed.length} rewrite(s): ${changed.map((d) => `${d.section} (${pct(d.p)})`).join(", ")}`);
  } else {
    ctx.log(rw.sections.length ? "Jev kept every section as it is" : "Nothing in the evidence calls for an outline change");
  }
  saveScorecard(sc);
  ctx.progress(1, "coached");
  return { scorecard: sc.id, proposal: sc.proposal ?? null, calls, cost };
}
