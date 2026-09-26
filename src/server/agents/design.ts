// Edit design: the step between the Planner and the Editor. For every clip of a take, Jev picks a
// camera move per segment and a transition per gap from the outline's allowed options, and marks
// flashback segments. The "use when…" guidance comes from the Hybrid brief an LLM compiled from the
// outline, or from standard guidance in System One mode. In Hybrid mode an LLM then writes the hook
// title and emphasis words for each clip. Every decision is saved with its probabilities.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext } from "../jobs";
import { decide, noul, type Question } from "../jev";
import { OUTLINE_FILE, readClipData, readText, readTranscript, runDir, writeClipData } from "../library";
import { readReview, setApproved } from "../review";
import { readEditStyle, type Edit, type EditStyle, type Transition, type Zoom } from "./edit";
import { finishClips, type JevBrief } from "./jev-brief";
import { norm } from "./align";
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
  at: number; mode: "hybrid" | "jev"; guide: "llm" | "standard"; cost: number;
  clips: Record<string, { zooms: DesignDecision[]; transitions: { gap: number; transition: Transition; p: number; options: Record<string, number> }[]; titles?: "llm" }>;
};

const clipText = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);

export async function designEdits(ctx: JobContext, runId: string, opts: { hybrid?: boolean } = {}) {
  const dir = runDir(runId);
  const script = join(dir, "clip_script.md");
  const data = readClipData(script);
  const style: EditStyle = data.edit_style ?? readEditStyle(readText(OUTLINE_FILE));
  const jevFile = join(dir, "jev.json");
  const brief: JevBrief | null = existsSync(jevFile) ? JSON.parse(readFileSync(jevFile, "utf8")).brief ?? null : null;
  const summary = brief?.summary ?? "";
  const segs = readTranscript(data.video) ?? [];
  const vt = readVision(data.video);
  const zooms = style.zooms;
  const transitions = style.transitions;
  const zoomCriteria = Object.fromEntries(zooms.map((z) => [z, brief?.zoomGuide?.[z] ?? ZOOM_GUIDE[z]]));
  const trCriteria = Object.fromEntries(transitions.map((t) => [t, brief?.transitionGuide?.[t] ?? TRANSITION_GUIDE[t]]));
  const guide = brief?.source === "llm" ? "llm" : "standard";
  const lines = (a: number, b: number) => segs.filter((s) => s.end > a && s.start < b).map((s) => s.text);
  let cost = 0;
  const out: DesignFile = { at: Date.now(), mode: opts.hybrid ? "hybrid" : "jev", guide, cost: 0, clips: {} };
  ctx.log(`Designing edits for ${data.clips.length} clip(s) with Jev (${guide === "llm" ? "guidance compiled from the outline" : "standard guidance"})`);

  let done = 0;
  for (const c of data.clips) {
    const e: Edit | undefined = c.edit;
    if (!e?.segments.length) continue;
    const decisions: DesignDecision[] = [];
    const n = e.segments.length;

    // Camera move per segment, and (if the outline has a flashback look) whether it's a flashback.
    await Promise.all(e.segments.map(async (s, i) => {
      const q: Record<string, Question> = {};
      if (zooms.length > 1) q.zoom = { type: "choice", instructions: "Which camera move suits this part of the clip best?", criteria: zoomCriteria };
      // The outline's closing move: ask directly whether the last part is where the moment ends.
      if (zooms.includes("zoom_out") && n > 1 && i === n - 1) q.ending = { type: "noul", instructions: "This part is where the clip's moment ends or fades: the last beat, after which the viewer should be left with the feeling." };
      if (style.flashback !== "none" && i > 0) q.flashback = { type: "noul", instructions: "This part recalls or returns to an earlier moment, like a memory or a flashback." };
      if (!Object.keys(q).length) return;
      const d = await decide({
        brief: summary, position: i === 0 ? "opening" : i === n - 1 ? "final" : "middle",
        part_transcript: clipText(lines(s.start, s.end).join("\n"), 2500),
        ...(vt ? { shot_log: visualsIn(vt, s.start, s.end, 8) } : {}),
      }, q, ctx.signal);
      cost += d.cost;
      ctx.addCost(d.cost);
      const z = d.answers.zoom;
      if (z?.type === "choice" && zooms.includes(z.choice as Zoom)) {
        s.zoom = z.choice as Zoom;
        decisions.push({ piece: i + 1, zoom: s.zoom, p: z.probabilities[z.choice] ?? z.confidence, options: z.probabilities });
      }
      if (q.ending) {
        const dd = decisions.find((x) => x.piece === i + 1);
        if (dd) dd.ending_p = noul(d.answers.ending);
      }
      if (q.ending && noul(d.answers.ending) >= 0.6 && s.zoom !== "zoom_out") {
        s.zoom = "zoom_out";
        const dd = decisions.find((x) => x.piece === i + 1);
        if (dd) Object.assign(dd, { zoom: "zoom_out", p: noul(d.answers.ending), ending: true });
      }
      if (q.flashback) {
        const fb = noul(d.answers.flashback);
        if (fb >= 0.6) s.look = style.flashback;
        else delete s.look;
        const dd = decisions.find((x) => x.piece === i + 1);
        if (dd) dd.flashback = fb;
      }
    }));

    // Variety: the same move on back-to-back parts reads as one long zoom. Take Jev's runner-up when it's plausible.
    for (let i = 1; i < n; i++) {
      const cur = e.segments[i];
      const d = decisions.find((x) => x.piece === i + 1);
      if (!d || cur.zoom !== e.segments[i - 1].zoom) continue;
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
        before: clipText(lines(prev.start, prev.end).slice(-2).join(" "), 500),
        after: clipText(lines(s.start, s.end).slice(0, 2).join(" "), 500),
        skipped_seconds: Math.round(Math.max(0, s.start - prev.end)),
        goes_back_in_time: s.start < prev.start,
        leads_into_final_part: i === n - 2,
      }, { transition: { type: "choice", instructions: "Which transition should join these two parts?", criteria: trCriteria } }, ctx.signal);
      cost += d.cost;
      ctx.addCost(d.cost);
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
    ctx.progress(0.8 * (++done / data.clips.length), `designed ${done}/${data.clips.length}`);
  }

  // Hybrid: hook titles and emphasis words from the LLM, for the final clips only.
  if (opts.hybrid) {
    const fin = await finishClips(ctx, brief ?? ({ summary } as JevBrief), data.clips.map((c) => ({ id: c.id, lines: lines(c.start, c.end) })));
    for (const c of data.clips) {
      const f = fin[c.id];
      if (!f) continue;
      if (f.title) c.title = String(f.title).slice(0, 80);
      if (c.edit && style.title && f.hook_title) c.edit.title = String(f.hook_title).slice(0, 80);
      if (c.edit && Array.isArray(f.emphasis)) {
        // Only words that are actually spoken in the clip can be emphasised.
        const spoken = new Set(segs.filter((s) => s.end > c.start && s.start < c.end).flatMap((s) => (s.words ?? []).map((w) => norm(w.w))));
        c.edit.emphasis = f.emphasis.map(String).filter((w: string) => spoken.has(norm(w))).slice(0, 5);
      }
      if (f.why) c.reason = `${String(f.why).slice(0, 300)} (${c.reason ?? ""})`.slice(0, 900);
      if (out.clips[c.id]) out.clips[c.id].titles = "llm";
    }
  }

  // Changing an approved take's edit un-approves it: the human reviews what will actually be cut.
  if (readReview(runId).approved) {
    setApproved(runId, false);
    ctx.log("This take was approved; the edit changed, so it's back in review", "warn");
  }
  out.cost = cost;
  writeClipData(script, data);
  writeFileSync(join(dir, "design.json"), JSON.stringify(out, null, 1), "utf8");
  ctx.log(`Edit design done: ${Object.values(out.clips).reduce((n, c) => n + c.zooms.length + c.transitions.length, 0)} Jev decisions ($${cost.toFixed(4)})`);
  ctx.progress(1, "edits designed");
  return { run: runId, clips: Object.keys(out.clips).length, cost };
}
