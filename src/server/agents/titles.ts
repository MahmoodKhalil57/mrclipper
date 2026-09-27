// Step 4b · Hook cards (LLM writes, Jev judges). For every clip of a take:
//   hook card    the LLM writes three options in the clip's language; Jev picks the one that stops a scroller
//   emphasis     the LLM proposes words from the clip; Jev keeps the ones that carry its feeling
//   title        the LLM also writes a short working title for you (not shown to viewers)
// One LLM call covers every clip. The picks go into each clip's edit; the options and Jev's odds are saved in
// titles.json. It runs before Design, so the planner knows what the hook card says and where it sits.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, WRITER } from "../config";
import type { JobContext } from "../jobs";
import { decide, noul, type Question } from "../jev";
import { extractJson, openrouter, pool } from "../lib";
import { readClipData, readText, readTranscript, runDir, writeClipData } from "../library";
import { readReview, setApproved } from "../review";
import { norm } from "./align";
import { takeBrief, type Brief } from "./brief";
import { takeStyle } from "./edit";
import { clipStr } from "./text";

export type TitlesFile = {
  at: number; cost: number;
  clips: Record<string, {
    hook?: { chosen: string; p: number; options: Record<string, number>; texts: Record<string, string> };
    emphasis?: { w: string; p: number; kept: boolean }[];
  }>;
};

const titlesFile = (runId: string) => join(runDir(runId), "titles.json");

export function readTitles(runId: string): TitlesFile | null {
  try {
    if (existsSync(titlesFile(runId))) return JSON.parse(readFileSync(titlesFile(runId), "utf8"));
    // Takes designed before this was its own step kept their hook cards in design.json.
    const d = join(runDir(runId), "design.json");
    const old = existsSync(d) ? JSON.parse(readFileSync(d, "utf8")) : null;
    const clips = Object.fromEntries(Object.entries<any>(old?.clips ?? {}).filter(([, c]) => c.hook || c.emphasis).map(([id, c]) => [id, { hook: c.hook, emphasis: c.emphasis }]));
    return Object.keys(clips).length ? { at: old.at, cost: 0, clips } : null;
  } catch {
    return null;
  }
}

/** One LLM call for every clip: a working title, three hook-card options and emphasis candidates. */
async function writeOptions(ctx: JobContext, brief: Brief, clips: { id: number; lines: string[] }[]) {
  const prompt = `You write options for short-form clips; a scoring model picks between them, so make the options genuinely different.
Brief: ${brief.summary}
Hook cards: ${brief.design.titleGuide}

For each clip write:
- "title": a 2-5 word English working title (a label for the editor, not shown to viewers)
- "hooks": 3 different on-screen hook cards, following the hook-card guidance
- "emphasis": up to 5 exact words copied from the clip's transcript that could carry its feeling or point
- "why": one English sentence on why the clip fits the brief

${clips.map((c) => `## Clip ${c.id}\n${clipStr(c.lines.join("\n"), 2500)}`).join("\n\n")}

Reply with ONLY JSON: {"clips": [{"id": 1, "title": "...", "hooks": ["...", "...", "..."], "emphasis": ["..."], "why": "..."}]}`;
  try {
    const res = await openrouter({ temperature: 0.7, ...WRITER, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
    ctx.addCost(res.usage?.cost);
    const out: Record<number, { title?: string; hooks?: string[]; emphasis?: string[]; why?: string }> = {};
    for (const c of extractJson(res.content).clips ?? []) out[Number(c.id)] = c;
    ctx.log(`${res.model} via ${res.provider ?? "OpenRouter"} wrote options for ${Object.keys(out).length} clips; Jev picks next`);
    return out;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Title options failed (${e instanceof Error ? e.message : e}); keeping placeholder titles`, "warn");
    return {};
  }
}

export async function titleTake(ctx: JobContext, runId: string) {
  const dir = runDir(runId);
  const script = join(dir, "clip_script.md");
  const data = readClipData(script);
  const style = takeStyle(readText(join(dir, "outline.md")), data.edit_style);
  const brief = takeBrief(runId, data.video);
  const segs = readTranscript(data.video) ?? [];
  const lines = (a: number, b: number) => segs.filter((s) => s.end > a && s.start < b).map((s) => s.text);
  const clipLines = (c: (typeof data.clips)[number]) => {
    const ranges = c.edit?.segments?.length ? c.edit.segments.map((s) => [s.start, s.end]) : [[c.start, c.end]];
    return ranges.flatMap(([a, b]) => lines(a, b));
  };
  let cost = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));
  const out: TitlesFile = { at: Date.now(), cost: 0, clips: {} };
  ctx.progress(0.05, "writing options");
  const opts = await writeOptions({ ...ctx, addCost }, brief, data.clips.map((c) => ({ id: c.id, lines: clipLines(c) })));
  let done = 0;
  await pool(data.clips, 6, async (c) => {
    const o = opts[c.id];
    if (!o) return;
    if (o.title) c.title = String(o.title).slice(0, 80);
    if (o.why) c.reason = `${String(o.why).slice(0, 300)} (${c.reason ?? ""})`.slice(0, 900);
    const hooks = (Array.isArray(o.hooks) ? o.hooks : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 3);
    const spoken = new Set(segs.filter((s) => s.end > c.start && s.start < c.end).flatMap((s) => (s.words ?? []).map((w) => norm(w.w))));
    const candidates = [...new Set((Array.isArray(o.emphasis) ? o.emphasis : []).map(String).filter((w) => spoken.has(norm(w))))].slice(0, 5);
    const q: Record<string, Question> = {};
    const hookKeys = Object.fromEntries(hooks.map((h, i) => [String.fromCharCode(97 + i), h]));
    if (style.title && hooks.length > 1) {
      q.hook = { type: "choice", instructions: "Which hook card would make a scrolling viewer stop for this clip, fits the brief, and doesn't give away its payoff?", criteria: hookKeys };
    }
    candidates.forEach((w, i) => (q[`w${i}`] = { type: "noul", instructions: `The word "${w}" carries this clip's feeling or point, so it deserves to stand out in the captions.` }));
    if (!Object.keys(q).length) return;
    const d = await decide({ brief: brief.summary, hook_card_guidance: brief.design.titleGuide, clip_transcript: clipStr(clipLines(c).join("\n"), 3000) }, q, ctx.signal);
    addCost(d.cost);
    const rec = (out.clips[c.id] = {} as TitlesFile["clips"][string]);
    const h = d.answers.hook;
    if (c.edit && style.title) {
      if (h?.type === "choice" && hookKeys[h.choice]) {
        c.edit.title = hookKeys[h.choice].slice(0, 80);
        rec.hook = { chosen: h.choice, p: h.probabilities[h.choice] ?? h.confidence, options: h.probabilities, texts: hookKeys };
      } else if (hooks.length === 1) {
        c.edit.title = hooks[0].slice(0, 80);
      }
    }
    if (c.edit) {
      const scored = candidates.map((w, i) => ({ w, p: noul(d.answers[`w${i}`]) })).sort((a, b) => b.p - a.p);
      const kept = scored.filter((x) => x.p >= 0.55).slice(0, 3);
      c.edit.emphasis = kept.map((x) => x.w);
      rec.emphasis = scored.map((x) => ({ ...x, kept: kept.includes(x) }));
    }
    ctx.progress(0.2 + 0.78 * (++done / data.clips.length), `clips ${done}/${data.clips.length}`);
  }, ctx.signal);

  // New hook cards change what will be rendered, so a reviewed take goes back to review.
  if (readReview(runId).approved) {
    setApproved(runId, false);
    ctx.log("This take was already reviewed; its hook cards changed, so it's back in review", "warn");
  }
  out.cost = cost;
  writeClipData(script, data);
  writeFileSync(titlesFile(runId), JSON.stringify(out, null, 1), "utf8");
  const hooks = Object.values(out.clips).filter((c) => c.hook).length;
  ctx.log(`Hook cards done: ${hooks} picked by Jev, ${Object.values(out.clips).reduce((n, c) => n + (c.emphasis?.filter((w) => w.kept).length ?? 0), 0)} emphasis words ($${cost.toFixed(4)})`);
  ctx.progress(1, "hook cards chosen");
  return { run: runId, hooks, cost };
}
