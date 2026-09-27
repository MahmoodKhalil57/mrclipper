// Step 4b · Design edits (Jev judges; the LLM only writes options). For every clip of a take:
//   camera move   Jev picks one per part from the outline's allowed zooms, using the brief's "use when…" guide
//   flashback     Jev decides whether a part recalls an earlier moment (rendered in the outline's flashback look)
//   final beat    Jev decides whether the last part is where the moment ends (then the camera pulls back)
//   transition    Jev picks one per gap from the allowed transitions
//   hook card     the LLM writes three options in the clip's language; Jev picks the one that stops a scroller
//   emphasis      the LLM proposes words from the clip; Jev keeps the ones that carry its feeling
// Every choice is saved with its probabilities in design.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, WRITER } from "../config";
import type { JobContext } from "../jobs";
import { decide, noul, type Question } from "../jev";
import { extractJson, openrouter, pool } from "../lib";
import { OUTLINE_FILE, readClipData, readText, readTranscript, runDir, writeClipData } from "../library";
import { readReview, setApproved } from "../review";
import { norm } from "./align";
import { defaultBrief, readBrief, type Brief } from "./brief";
import { readEditStyle, type Edit, type EditStyle, type Transition, type Zoom } from "./edit";
import { clipStr } from "./text";
import { readVision, visualsIn } from "./vision";

const ZOOM_GUIDE: Record<Zoom, string> = {
  none: "Keep the frame still: dialogue that needs no emphasis.",
  punch_in: "A punchline, a key number or a name lands and needs emphasis.",
  slow_push: "An emotional or serious moment builds; draw the viewer in.",
  ken_burns: "A still photo or archive image is on screen.",
  zoom_out: "The final beat: let the moment end, or feel remembered.",
  drift: "A wide shot of several people or the stage; add gentle movement.",
};
const TRANSITION_GUIDE: Record<Transition, string> = {
  cut: "The story continues directly; nothing was skipped that matters.",
  crossfade: "Moving between two related moments, softly.",
  dip_black: "Before the final beat, or a big change of mood.",
  slide: "A playful jump to the next point.",
  zoom: "An energetic jump into the next moment.",
  whip: "A fast, funny jump.",
  flash: "The biggest laugh or reveal, once per clip at most.",
  iris: "Opening into the first moment after a cold open.",
  blur: "Time passes, or drifting into and out of a memory.",
};

export type DesignDecision = { piece: number; zoom: Zoom; p: number; options: Record<string, number>; flashback?: number; varied?: boolean; ending?: boolean; ending_p?: number };
export type DesignFile = {
  at: number; cost: number; guide: "llm" | "standard";
  clips: Record<string, {
    zooms: DesignDecision[];
    transitions: { gap: number; transition: Transition; p: number; options: Record<string, number> }[];
    hook?: { chosen: string; p: number; options: Record<string, number>; texts: Record<string, string> };
    emphasis?: { w: string; p: number; kept: boolean }[];
  }>;
};

/** The brief a take was made with (snapshotted in jev.json), else the video's current one. */
export function takeBrief(runId: string, video: string): Brief {
  const f = join(runDir(runId), "jev.json");
  const snap = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).brief : null;
  if (snap?.pick) return snap as Brief;
  return readBrief(video)?.brief ?? defaultBrief(readText(OUTLINE_FILE));
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
    return { out, cost: res.usage?.cost ?? 0 };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Title options failed (${e instanceof Error ? e.message : e}); keeping placeholder titles`, "warn");
    return { out: {}, cost: 0 };
  }
}

export async function designEdits(ctx: JobContext, runId: string) {
  const dir = runDir(runId);
  const script = join(dir, "clip_script.md");
  const data = readClipData(script);
  const style: EditStyle = data.edit_style ?? readEditStyle(readText(OUTLINE_FILE));
  const brief = takeBrief(runId, data.video);
  const summary = brief.summary;
  const segs = readTranscript(data.video) ?? [];
  const vt = readVision(data.video);
  const zooms = style.zooms;
  const transitions = style.transitions;
  const zoomCriteria = Object.fromEntries(zooms.map((z) => [z, brief.design.zoomGuide[z] ?? ZOOM_GUIDE[z]]));
  const trCriteria = Object.fromEntries(transitions.map((t) => [t, brief.design.transitionGuide[t] ?? TRANSITION_GUIDE[t]]));
  const lines = (a: number, b: number) => segs.filter((s) => s.end > a && s.start < b).map((s) => s.text);
  let cost = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));
  const out: DesignFile = { at: Date.now(), cost: 0, guide: brief.source === "llm" ? "llm" : "standard", clips: {} };
  ctx.log(`Designing ${data.clips.length} clip(s) with Jev (${out.guide === "llm" ? "guidance from the brief" : "built-in guidance"})`);

  let done = 0;
  for (const c of data.clips) {
    const e: Edit | undefined = c.edit;
    if (!e?.segments.length) continue;
    const decisions: DesignDecision[] = [];
    const n = e.segments.length;

    // Camera move per part, and whether it's a flashback or the final beat.
    await Promise.all(e.segments.map(async (s, i) => {
      const q: Record<string, Question> = {};
      if (zooms.length > 1) q.zoom = { type: "choice", instructions: "Which camera move suits this part of the clip best?", criteria: zoomCriteria };
      if (zooms.includes("zoom_out") && n > 1 && i === n - 1) q.ending = { type: "noul", instructions: "This part is where the clip's moment ends or fades: the last beat, after which the viewer should be left with the feeling." };
      if (style.flashback !== "none" && i > 0) q.flashback = { type: "noul", instructions: "This part recalls or returns to an earlier moment, like a memory or a flashback." };
      if (!Object.keys(q).length) return;
      const d = await decide({
        brief: summary, position: i === 0 ? "opening" : i === n - 1 ? "final" : "middle",
        part_transcript: clipStr(lines(s.start, s.end).join("\n"), 2500),
        ...(vt ? { shot_log: visualsIn(vt, s.start, s.end, 8) } : {}),
      }, q, ctx.signal);
      addCost(d.cost);
      const z = d.answers.zoom;
      if (z?.type === "choice" && zooms.includes(z.choice as Zoom)) {
        s.zoom = z.choice as Zoom;
        decisions.push({ piece: i + 1, zoom: s.zoom, p: z.probabilities[z.choice] ?? z.confidence, options: z.probabilities });
      }
      const dd = () => decisions.find((x) => x.piece === i + 1);
      if (q.ending) {
        const p = noul(d.answers.ending);
        if (dd()) dd()!.ending_p = p;
        if (p >= 0.6 && s.zoom !== "zoom_out") {
          s.zoom = "zoom_out";
          if (dd()) Object.assign(dd()!, { zoom: "zoom_out", p, ending: true });
        }
      }
      if (q.flashback) {
        const fb = noul(d.answers.flashback);
        if (fb >= 0.6) s.look = style.flashback;
        else delete s.look;
        if (dd()) dd()!.flashback = fb;
      }
    }));

    // Variety: the same move on back-to-back parts reads as one long zoom. Take Jev's runner-up when it's plausible.
    for (let i = 1; i < n; i++) {
      const cur = e.segments[i];
      const d = decisions.find((x) => x.piece === i + 1);
      if (!d || d.ending || cur.zoom !== e.segments[i - 1].zoom) continue;
      const alt = Object.entries(d.options).filter(([k]) => k !== cur.zoom && zooms.includes(k as Zoom)).sort((a, b) => b[1] - a[1])[0];
      if (alt && alt[1] >= 0.15) {
        cur.zoom = d.zoom = alt[0] as Zoom;
        d.p = alt[1];
        d.varied = true;
      }
    }

    // Transition per gap.
    const trs: DesignFile["clips"][string]["transitions"] = [];
    await Promise.all(e.segments.slice(1).map(async (s, i) => {
      if (transitions.length < 2) return;
      const prev = e.segments[i];
      const d = await decide({
        brief: summary,
        before: clipStr(lines(prev.start, prev.end).slice(-2).join(" "), 500),
        after: clipStr(lines(s.start, s.end).slice(0, 2).join(" "), 500),
        skipped_seconds: Math.round(Math.max(0, s.start - prev.end)),
        goes_back_in_time: s.start < prev.start,
        leads_into_final_part: i === n - 2,
      }, { transition: { type: "choice", instructions: "Which transition should join these two parts?", criteria: trCriteria } }, ctx.signal);
      addCost(d.cost);
      const t = d.answers.transition;
      if (t?.type === "choice" && transitions.includes(t.choice as Transition)) {
        e.transitions[i] = t.choice as Transition;
        trs.push({ gap: i + 1, transition: e.transitions[i], p: t.probabilities[t.choice] ?? t.confidence, options: t.probabilities });
      }
    }));
    // A flash is a one-off: keep only the most confident one.
    const flashes = trs.filter((t) => t.transition === "flash").sort((a, b) => b.p - a.p);
    for (const f of flashes.slice(1)) e.transitions[f.gap - 1] = "crossfade" as Transition;

    out.clips[c.id] = { zooms: decisions.sort((a, b) => a.piece - b.piece), transitions: trs.sort((a, b) => a.gap - b.gap) };
    ctx.progress(0.6 * (++done / data.clips.length), `edits ${done}/${data.clips.length}`);
  }

  // Titles: the LLM writes options, Jev picks the hook card and keeps the emphasis words.
  ctx.progress(0.65, "writing title options");
  const clipLines = (c: (typeof data.clips)[number]) => {
    const ranges = c.edit?.segments?.length ? c.edit.segments.map((s) => [s.start, s.end]) : [[c.start, c.end]];
    return ranges.flatMap(([a, b]) => lines(a, b));
  };
  const { out: opts } = await writeOptions({ ...ctx, addCost }, brief, data.clips.map((c) => ({ id: c.id, lines: clipLines(c) })));
  done = 0;
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
    const d = await decide({ brief: summary, hook_card_guidance: brief.design.titleGuide, clip_transcript: clipStr(clipLines(c).join("\n"), 3000) }, q, ctx.signal);
    addCost(d.cost);
    const rec = out.clips[c.id] ?? (out.clips[c.id] = { zooms: [], transitions: [] });
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
    ctx.progress(0.7 + 0.28 * (++done / data.clips.length), `titles ${done}/${data.clips.length}`);
  }, ctx.signal);

  // Changing a reviewed take's edit sends it back to review: you review what will actually be rendered.
  if (readReview(runId).approved) {
    setApproved(runId, false);
    ctx.log("This take was already reviewed; its edits changed, so it's back in review", "warn");
  }
  out.cost = cost;
  writeClipData(script, data);
  writeFileSync(join(dir, "design.json"), JSON.stringify(out, null, 1), "utf8");
  const decisions = Object.values(out.clips).reduce((n, c) => n + c.zooms.length + c.transitions.length + (c.hook ? 1 : 0) + (c.emphasis?.length ?? 0), 0);
  ctx.log(`Design done: ${decisions} Jev decisions ($${cost.toFixed(4)})`);
  ctx.progress(1, "edits designed");
  return { run: runId, clips: Object.keys(out.clips).length, decisions, cost };
}
