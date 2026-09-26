// Rubric: the LLM step before the Jev outline coach (Hybrid). Like the Brief before the Planner,
// one LLM call writes the parts of System One that matter for this outline and this evidence:
//   rules     checkable statements Jev rates on every finished clip ("opens on a quiet line")
//   sections  for the few sections the evidence says are hurting clips, 2 rewrites each
// Jev then does the judging: which rules the clips follow, and which rewrite (or none) wins.
// System One mode skips the LLM: one rule per outline section, and no rewrites.
import { MODELS } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter } from "../lib";
import { OUTLINE_FILE, readText } from "../library";
import { bold, clipStr, hashText, saveRubric, selectTakes, takeEvidence, type Rubric, type RubricRule, type RubricVariant } from "./coach";

/** "## " sections of a markdown outline, with their bodies (everything up to the next "## "). */
export function sectionsOf(md: string): { name: string; body: string }[] {
  const text = md.replace(/\r\n/g, "\n");
  const heads = [...text.matchAll(/^## (.+)$/gm)];
  return heads.map((h, i) => ({
    name: h[1].trim(),
    body: text.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index! : text.length).replace(/^\n+|\n+$/g, ""),
  }));
}

export function replaceSection(md: string, name: string, body: string) {
  const text = md.replace(/\r\n/g, "\n");
  const heads = [...text.matchAll(/^## (.+)$/gm)];
  const i = heads.findIndex((h) => h[1].trim() === name);
  if (i === -1) return text;
  const start = heads[i].index!;
  const next = i + 1 < heads.length ? heads[i + 1].index! : -1;
  return text.slice(0, start) + `## ${name}\n\n${body.trim()}\n` + (next === -1 ? "" : "\n" + text.slice(next));
}

const SKIP = /^(settings|previous clip attempts|music)/i;
const KEY = /^[a-z][a-z0-9_]{1,40}$/;

/** System One's rubric: one rule per outline section, no rewrites. */
export function defaultRubric(outline: string): Rubric {
  const rules: RubricRule[] = sectionsOf(outline)
    .filter((s) => !SKIP.test(s.name) && s.body.trim())
    .map((s, i) => ({
      key: `s${i + 1}`, section: s.name, rule: clipStr(s.body.replace(/\s+/g, " "), 120),
      question: `The finished clip follows this part of the outline (${s.name}): "${clipStr(s.body.replace(/\s+/g, " "), 350)}"`,
    }));
  return { source: "default", at: Date.now(), outline_hash: hashText(outline), cost: 0, diagnosis: "", rules, sections: [] };
}

export async function compileRubric(ctx: JobContext, p: { outline: string; evidence: string; direction?: string }): Promise<Rubric> {
  const base = defaultRubric(p.outline);
  const secs = sectionsOf(p.outline);
  const prompt = `You prepare the rubric a scoring model (Jev) uses to judge finished short-form clips against a clip outline, and candidate rewrites for the outline sections that the evidence says are hurting the clips.
Jev reads each finished clip's transcript, a log of its frames and its planned edit, and rates each rule from 0 to 1. Then Jev chooses between the current text of a section and your rewrites.
The goal is an outline the pipeline one-shots: the first take approved with every clip kept and liked.

## Outline
${p.outline}

## Evidence: takes, your verdict on each clip, and what the finished clips say and show
${p.evidence}
${p.direction ? `\n## The editor's direction for this revision\n${p.direction}\n` : ""}
Write:
1. "rules": 6 to 12 checkable rules from the outline that decide whether a clip gets kept. Each:
   {"key": "snake_case", "section": "exact section name", "rule": "short paraphrase", "question": "a statement about ONE finished clip that Jev rates 0-1, e.g. The clip opens on a quiet line, not a punchline."}
   Cover story, tone, editing, captions and framing where the outline has rules for them.
2. "sections": up to 3 sections the evidence suggests are hurting clips (none if nothing is). Each:
   {"section": "exact section name", "why": "one sentence citing the evidence", "variants": [{"key": "a", "summary": "12 words max", "text": "the full new body of the section"}, {"key": "b", ...}]}
   Two genuinely different rewrites per section. Keep every "**Label:** value" line the section has (values may change). The outline is shared across videos: no rules tied to one video.
3. "diagnosis": one sentence on the biggest reason takes aren't one-shot yet.
Takes marked "outline unrecorded" may have used a different outline: weigh them lightly.
Reply with ONLY JSON: {"diagnosis": "...", "rules": [...], "sections": [...]}`;

  let cost = 0;
  try {
    const res = await openrouter({ temperature: 0.4, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
    ctx.addCost(res.usage?.cost);
    cost = res.usage?.cost ?? 0;
    const raw = extractJson(res.content);
    const names = new Set(secs.map((s) => s.name));
    const taken = new Set<string>();
    const rules: RubricRule[] = (Array.isArray(raw.rules) ? raw.rules : [])
      .map((r: any) => ({ key: String(r.key ?? "").toLowerCase(), section: String(r.section ?? ""), rule: String(r.rule ?? "").slice(0, 200), question: String(r.question ?? "").slice(0, 400) }))
      .filter((r: RubricRule) => KEY.test(r.key) && !taken.has(r.key) && r.question && taken.add(r.key))
      .map((r: RubricRule) => ({ ...r, section: names.has(r.section) ? r.section : "" }))
      .slice(0, 12);
    const sections: Rubric["sections"] = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, 3).flatMap((x: any): Rubric["sections"] => {
      const s = secs.find((y) => y.name === String(x.section ?? "").trim());
      if (!s) return [];
      const labels = bold(s.body);
      // A rewrite that drops one of the section's settings would break the Editor; leave it out.
      const variants: RubricVariant[] = (Array.isArray(x.variants) ? x.variants : []).slice(0, 3)
        .map((v: any, i: number) => ({ key: String.fromCharCode(97 + i), summary: String(v.summary ?? "").slice(0, 120), text: String(v.text ?? "").trim() }))
        .filter((v: RubricVariant) => v.text.length > 20 && labels.every((l) => bold(v.text).includes(l)) && v.text !== s.body.trim());
      return variants.length ? [{ section: s.name, why: String(x.why ?? "").slice(0, 300), variants }] : [];
    });
    if (rules.length < 4) throw new Error(`only ${rules.length} usable rules`);
    const r: Rubric = { source: "llm", model: res.model, at: Date.now(), outline_hash: base.outline_hash, cost, diagnosis: String(raw.diagnosis ?? "").slice(0, 400), rules, sections };
    ctx.log(`Rubric: ${rules.length} rules for Jev; rewrites for ${sections.length ? sections.map((s) => `${s.section} (${s.variants.length})`).join(", ") : "no sections"}`);
    return r;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Rubric compile failed (${e instanceof Error ? e.message : e}); using one rule per outline section and no rewrites`, "warn");
    return { ...base, cost };
  }
}

/** The Rubric node on its own: compile from the current outline and evidence, and cache it. */
export async function buildRubric(ctx: JobContext, input: { video?: string; direction?: string }) {
  const outline = readText(OUTLINE_FILE);
  const { takes, outcomes, label } = selectTakes(input);
  ctx.progress(0.1, "LLM writing the rubric");
  const r = await compileRubric(ctx, { outline, evidence: takes.map((t) => takeEvidence(t, outcomes.get(t.id)!, label)).join("\n\n"), direction: input.direction });
  saveRubric(r);
  ctx.progress(1, "rubric ready");
  return { rules: r.rules.length, sections: r.sections.length, source: r.source };
}
