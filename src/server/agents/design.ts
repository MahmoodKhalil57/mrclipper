// Step 4d · Design edits: the LLM writes, code checks, Jev judges. For every clip of a take:
//   concepts     the LLM plans two different edits from the effects library (camera moves, looks, speed and
//                freeze frames per part, transitions, and effects on the timeline: text, graphics, your GIFs,
//                recorded sounds, voice treatments, music), reading the outline, the brief, the style reference,
//                the clip's words and shots, its hook card (Hook cards ran before), and the files it can use
//   checks       code keeps only what the outline allows and what exists, puts every effect on a real moment
//                (a word, a part, a join), and test-runs each plan in ffmpeg; anything broken is dropped with a note
//   pick         Jev picks the plan a professional editor would choose for this clip, with odds
// A clip the Music step scored plays its own score, so its plan adds no music. If the LLM can't plan a clip,
// Jev picks a camera move per part and a transition per join instead. Saved with odds and notes in design.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, WRITER } from "../config";
import type { JobContext } from "../jobs";
import { decide, noul, type Question } from "../jev";
import { extractJson, openrouter, pool, run, type Segment } from "../lib";
import { OUTLINE_FILE, readClipData, readSetting, readText, readTranscript, runDir, writeClipData } from "../library";
import { readReview, setApproved } from "../review";
import { assetsFingerprint, assetsText, listAssets, measureAssets, offeredAssets, type Asset } from "../effects/assets";
import { readMusic, scoreFor } from "../effects/music";
import { catalogText, findEffect, loadCatalog, TIMELINE_KINDS, type Catalog } from "../effects/catalog";
import { compileEdit } from "../effects/compile";
import { checkUse, describeTimeline, gapOf, layout, MAX_FREEZE, MAX_REVERSE, MAX_SPEED, MIN_SPEED, type TimelineMap } from "../effects/timeline";
import type { EffectDef, FxUse } from "../effects/types";
import { takeBrief } from "./brief";
import { takeStyle, type Edit, type EditStyle, type Gap, type Transition, type Zoom } from "./edit";
import { probeAspect } from "./framing";
import { readReference, referenceText } from "./reference";
import { clipStr, hashText } from "./text";
import { readTitles } from "./titles";
import { readVision, visualsIn, type VisionTranscript } from "./vision";

/** Bump when the planner changes, so takes designed before it are designed again. */
export const DESIGN_VERSION = 3;
export { takeBrief };

const ZOOM_GUIDE: Record<string, string> = {
  none: "Keep the frame still: dialogue that needs no emphasis.",
  punch_in: "A punchline, a key number or a name lands and needs emphasis.",
  slow_push: "An emotional or serious moment builds; draw the viewer in.",
  ken_burns: "A still photo or archive image is on screen.",
  zoom_out: "The final beat: let the moment end, or feel remembered.",
  drift: "A wide shot of several people or the stage; add gentle movement.",
};
const TRANSITION_GUIDE: Record<string, string> = {
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
export type ConceptRecord = {
  key: string; name: string; idea: string; p: number; chosen: boolean; ok: boolean;
  /** What it does, in lines (parts, joins, timeline), and what code dropped or changed. */
  plan: string[]; notes: string[];
};
export type DesignFile = {
  at: number; cost: number; guide: "llm" | "standard";
  /** What the design was made from, besides the take: the planner's version, your effects/ and assets/, and
   *  the clips' scores (a clip that gets its own score is planned without music). */
  inputs?: { version: number; effects: string; assets: string; scores?: string };
  clips: Record<string, {
    zooms: DesignDecision[];
    transitions: { gap: number; transition: Transition; p: number; options: Record<string, number> }[];
    /** "concepts": the LLM's plans, Jev picked; "moves": Jev picked a move per part (the fallback). */
    mode?: "concepts" | "moves";
    concepts?: ConceptRecord[];
    notes?: string[];
  }>;
};

/** What Design depends on besides its take: when one changes, the take's design is out of date. */
export const designInputs = (runId: string) => ({
  version: DESIGN_VERSION, effects: loadCatalog().hash, assets: assetsFingerprint(listAssets()),
  scores: hashText(JSON.stringify(Object.entries(readMusic(runId)?.clips ?? {}).map(([id, c]) => [id, c.key]).sort())),
});

// ── the planner's prompt ─────────────────────────────────────────────

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

/** The clip as the planner sees it: parts in play order with their shots, and every word numbered. */
function clipText(e: Edit, map: TimelineMap, vt: VisionTranscript | null): string {
  return map.parts.map((p) => {
    const s = e.segments[p.k - 1];
    const words = map.words.filter((w) => w.part === p.k);
    const chunks: string[] = [];
    words.forEach((w, i) => chunks.push(`${i % 8 === 0 ? `[${mmss(w.t)}] ` : ""}w${w.n} ${w.w}`));
    const shots = visualsIn(vt, s.start, s.end, 4);
    return `Part ${p.k} (${mmss(p.t0)}-${mmss(p.t1)}, ${(p.t1 - p.t0).toFixed(1)}s${s.role ? `, ${s.role}` : ""}${s.zoom && s.zoom !== "none" ? `, currently ${s.zoom}` : ""})` +
      `${shots.length ? `\n  on screen: ${shots.join(" | ")}` : ""}\n  ${chunks.join(" ") || "(no words)"}`;
  }).join("\n");
}

const INTENSITY: Record<NonNullable<EditStyle["intensity"]>, string> = {
  subtle: "Restrained: 2-6 timeline effects per clip, each one meaningful. Most of the clip plays clean.",
  moderate: "Balanced: about 5-12 timeline effects per clip, building toward the payoff.",
  heavy: "Dense and energetic: 12-28 timeline effects per clip (hits on beats, text, sounds), but never unreadable.",
};
const CAP: Record<NonNullable<EditStyle["intensity"]>, number> = { subtle: 7, moderate: 14, heavy: 30 };

function rulesText(style: EditStyle, cat: Catalog, assets: Asset[], maxLen: number, scored = false) {
  const intensity = style.intensity ?? "moderate";
  const music = style.music;
  const tracks = assets.filter((a) => a.kind === "music");
  const house = [
    style.grade !== "none" && `${style.grade} colour grade`, style.vignette !== "none" && `${style.vignette} vignette`, style.grain !== "none" && `${style.grain} film grain`,
    style.glow !== "none" && `${style.glow} glow`, style.letterbox && "letterbox bars", style.fades && "fade in and out",
    style.captions !== "none" && `${style.captions} captions (${style.position}, ${style.wordsPerCaption} words)`, style.title && `a hook card at the ${style.titlePosition} for the first ${style.titleSeconds}s`,
  ].filter(Boolean);
  return [
    `- Camera moves you may use per part: ${style.zooms.filter((z) => z !== "none").join(", ") || "none"} (or none).`,
    `- Looks you may use per part: ${style.looks.filter((l) => l !== "none").join(", ") || "none"}.`,
    `- Transitions you may use: ${style.transitions.join(", ")}. Transition length by default: ${style.transitionLength}s.`,
    `- Timeline effects you may use: ${style.effects ? (style.effects.length ? style.effects.join(", ") : "none") : "any in the library"}.`,
    `- Sounds you may use: ${style.sounds ? (style.sounds.length ? style.sounds.join(", ") : "none") : "any in the library"}.`,
    `- Music: ${scored ? "this clip has its own score, made for it; it plays under the whole clip, ducked under speech, so add no music effect"
      : music?.on ? `yes${music.file ? ` (the outline names ${music.file})` : ""}${music.mood ? `, mood: ${music.mood}` : ""}, volume about ${music.volume}` +
        (tracks.length ? `; tracks in assets/music: ${tracks.map((t) => `${t.name}${t.duration ? ` (${t.duration.toFixed(0)}s)` : ""}`).join(", ")}; start each clip at a different offset` : "; but assets/music is empty, so no music") : "no"}.`,
    `- Speed per part: ${MIN_SPEED}-${MAX_SPEED} (below 1 is slow motion). Freeze frame: up to ${MAX_FREEZE}s at a part's end. Reverse: parts up to ${MAX_REVERSE}s.`,
    `- The finished clip must stay under ${maxLen}s, so slow motion and freezes must fit.`,
    `- Amount: ${INTENSITY[intensity]}`,
    `- Already applied to every clip, so don't add them again: ${house.join(", ") || "nothing"}.`,
  ].join("\n");
}

const PLAN_PROMPT = (p: { brief: string; outline: string; reference: string; rules: string; clip: string; library: string; assets: string; title?: string; captions: string }) =>
  `You are a senior short-form video editor. Plan the edit of ONE clip, twice: two genuinely different approaches
(for example one restrained and one bolder, or two different ideas of the moment), both following every rule below.
A scoring model will pick one of them, and the renderer builds it exactly as you write it.

# Who it's for and the feeling
${p.brief}

# The editor's outline (their rules and taste: follow it)
${p.outline}
${p.reference ? `\n# Style reference: copy this, as far as the copy guide says\n${p.reference}\n` : ""}
# Hard rules for this clip
${p.rules}

# The clip, in play order (w = a word the viewer hears, numbered; times are in the finished clip)
${p.clip}${p.title ? `\nHook card on screen at the start: "${p.title}"` : ""}

# Effects library
${p.library}

# Files you can use
${p.assets}

# How a professional edits
- Every effect has a reason tied to a moment: a word, a reaction, a join. Put hits exactly on the word that lands
  (zoom_punch/shake/flash at "w23" with an impact sound), a whoosh under a transition, a riser that ends on a reveal.
- Sounds are recorded files: "sfx" plays one from the built-in sounds or your files on a moment; "ambience" loops one
  quietly under a stretch. Keep noise (hiss, crackle) out from under speech: on a phone it sounds like static.
- Build toward the payoff; leave quiet moments quiet. Don't stack effects on the same moment unless it's the peak.
- Sad or nostalgic: slow motion on a reaction, black and white memories, a muffled or reverb voice on the line that
  hurts, soft dips, low music, heartbeat or silence. Hype or anime: zoom punches, shakes, speed lines, flashes, impact
  and boom sounds, rgb_split on peaks. Comedy: punch-ins, a freeze with a shutter, big_text reactions, a pop. Informational:
  banners, lower thirds, callouts, arrows and circles on what's being explained, a ding on the key fact, a progress bar.
- Text is short, in the clip's own language and dialect, and never covers faces or the captions (${p.captions}).
- Use your files by their exact names. Only use effects, looks, camera moves and transitions the rules allow.

# Reply with ONLY JSON
{"concepts": [
  {"name": "2-4 words", "idea": "one sentence: the approach and why it fits",
   "parts": [{"part": 1, "camera": "none|<camera move>", "camera_params": {}, "looks": [], "speed": 1, "freeze": 0, "reverse": false}],
   "transitions": [{"after": 1, "fx": "<transition>", "duration": 0.4}],
   "timeline": [
     {"fx": "<effect>", "at": "w12", "duration": 0.5, "params": {}},
     {"fx": "<effect>", "from": "w30", "to": "w41.end", "params": {}}
   ]}
]}
Times: "w12" (when word 12 starts), "w12.end", "p2" / "p2.end" (a part's start or end), "cut1" (the join after part 1),
"start", "end", plus offsets like "w12-0.3". Instant effects take "at" (and an optional "duration"); range effects "from" and
"to". Give every part and every join. params only for what differs from the defaults (text and files are required).`;

// ── checking a plan ──────────────────────────────────────────────────

type Plan = { key: string; name: string; idea: string; edit: Edit; notes: string[] };

/** A concept as the LLM wrote it → an edit the renderer can build, keeping only what the rules allow. */
function checkConcept(raw: any, key: string, base: Edit, style: EditStyle, cat: Catalog, assets: Asset[], segs: Segment[], maxLen: number, scored = false): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const notes: string[] = [];
  const e: Edit = JSON.parse(JSON.stringify({ ...base, fx: [] }));
  const n = e.segments.length;
  // Parts: camera, looks, speed, freeze, reverse.
  for (const rp of Array.isArray(raw.parts) ? raw.parts : []) {
    const k = Math.round(Number(rp?.part)) - 1;
    const s = e.segments[k];
    if (!s) continue;
    delete s.fx;
    const cam = typeof rp.camera === "object" && rp.camera ? rp.camera : { fx: rp.camera ?? "none", ...(rp.camera_params ?? {}) };
    const camName = String(cam.fx ?? cam.name ?? "none");
    if (camName === "none" || !camName) s.zoom = "none";
    else {
      const r = checkUse(cam, ["segment"], cat, assets, null);
      if (!r.def?.cropOnly) notes.push(`part ${k + 1}: "${camName}" isn't a camera move`);
      else if (!style.zooms.includes(r.def.name)) notes.push(`part ${k + 1}: the outline doesn't allow the ${r.def.name} camera move`);
      else {
        s.zoom = r.def.name;
        if (r.use?.params) s.fx = [r.use];
      }
    }
    const looks = (Array.isArray(rp.looks) ? rp.looks : rp.look ? [rp.look] : []).map(String).filter((l: string) => l && l !== "none");
    delete s.look;
    for (const l of looks) {
      const def = findEffect(cat, l, ["segment"]);
      if (!def || def.cropOnly) notes.push(`part ${k + 1}: "${l}" isn't a look`);
      else if (!style.looks.includes(def.name)) notes.push(`part ${k + 1}: the outline doesn't allow the ${def.name} look`);
      else if (!s.look) s.look = def.name;
      else (s.fx ??= []).push({ fx: def.name });
    }
    const speed = Number(rp.speed);
    if (Number.isFinite(speed) && speed > 0 && Math.abs(speed - 1) > 0.01) s.speed = +Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)).toFixed(2);
    else delete s.speed;
    const freeze = Number(rp.freeze);
    if (freeze > 0.05) s.freeze = +Math.min(MAX_FREEZE, freeze).toFixed(2);
    else delete s.freeze;
    if (rp.reverse === true) {
      if (s.end - s.start <= MAX_REVERSE) s.reverse = true;
      else notes.push(`part ${k + 1} is too long to reverse`);
    } else delete s.reverse;
  }
  // Joins.
  for (const rt of Array.isArray(raw.transitions) ? raw.transitions : []) {
    const k = Math.round(Number(rt?.after ?? rt?.gap)) - 1;
    if (k < 0 || k >= n - 1) continue;
    const def = findEffect(cat, rt.fx ?? rt.transition, ["transition"]);
    if (!def) {
      notes.push(`join ${k + 1}: "${rt.fx}" isn't a transition`);
      continue;
    }
    if (!style.transitions.includes(def.name)) {
      notes.push(`join ${k + 1}: the outline doesn't allow the ${def.name} transition`);
      continue;
    }
    const r = checkUse({ ...rt, fx: def.name }, ["transition"], cat, assets, null);
    if (!r.use) {
      notes.push(`join ${k + 1}: ${r.note}`);
      continue;
    }
    const d = Number(rt.duration);
    const gap: Gap = r.use.params || d > 0 ? { fx: def.name, ...(d > 0 ? { duration: +Math.min(2, Math.max(0.1, d)).toFixed(2) } : {}), ...(r.use.params ? { params: r.use.params } : {}) } : def.name;
    e.transitions[k] = gap;
  }
  // Too long after slow motion and freezes: take the freezes out, then the slow motion.
  let map = layout(e, style, cat, segs);
  if (map.duration > maxLen) {
    for (const s of e.segments) delete s.freeze;
    map = layout(e, style, cat, segs);
    if (map.duration > maxLen) for (const s of e.segments) if ((s.speed ?? 1) < 1) delete s.speed;
    map = layout(e, style, cat, segs);
    notes.push(`the clip would run over ${maxLen}s, so freezes${map.duration > maxLen ? "" : " and slow motion"} were taken out`);
  }
  // The timeline, placed on this layout.
  const seen = new Set<string>();
  for (const rf of Array.isArray(raw.timeline) ? raw.timeline : []) {
    const r = checkUse(rf, TIMELINE_KINDS, cat, assets, map);
    if (!r.use || !r.def) {
      notes.push(r.note ?? "an effect was skipped");
      continue;
    }
    const d = r.def;
    const allowed = d.kind === "music" ? !!style.music?.on && !scored : d.kind === "sound" ? !style.sounds || style.sounds.includes(d.name) : !style.effects || style.effects.includes(d.name);
    if (!allowed) {
      notes.push(d.kind === "music" ? (scored ? "this clip has its own score, so the plan's music was left out" : "the outline doesn't ask for music") : `the outline doesn't allow ${d.name}`);
      continue;
    }
    const id = JSON.stringify([r.use.fx, r.use.at, r.use.from, r.use.to]);
    if (seen.has(id)) continue;
    seen.add(id);
    e.fx!.push(r.use);
  }
  const cap = CAP[style.intensity ?? "moderate"];
  if (e.fx!.length > cap) {
    notes.push(`kept the first ${cap} of ${e.fx!.length} timeline effects (the outline's effect intensity)`);
    e.fx = e.fx!.slice(0, cap);
  }
  if (!e.fx!.length) delete e.fx;
  return { key, name: String(raw.name ?? `Plan ${key.toUpperCase()}`).slice(0, 40), idea: String(raw.idea ?? "").slice(0, 300), edit: e, notes };
}

/** A plan in lines, for Jev and for you. */
function planLines(e: Edit, map: TimelineMap, cat: Catalog): string[] {
  const parts = e.segments.map((s, i) => {
    const bits = [s.zoom && s.zoom !== "none" ? s.zoom.replace(/_/g, " ") : "still", s.look, ...(s.fx ?? []).filter((f) => f.fx !== s.zoom).map((f) => f.fx),
      s.speed && s.speed !== 1 ? `${s.speed}× speed` : "", s.freeze ? `freeze ${s.freeze}s` : "", s.reverse ? "reversed" : ""].filter(Boolean);
    return `part ${i + 1}: ${bits.join(", ")}`;
  });
  const joins = e.transitions.map((g, i) => `join ${i + 1}: ${gapOf(g).fx}${gapOf(g).duration ? ` ${gapOf(g).duration}s` : ""}`);
  return [...parts, ...joins, ...describeTimeline(e, map, cat)];
}

// ── the design step ──────────────────────────────────────────────────

export async function designEdits(ctx: JobContext, runId: string) {
  const dir = runDir(runId);
  const script = join(dir, "clip_script.md");
  const data = readClipData(script);
  const takeOutline = readText(join(dir, "outline.md")) || readText(OUTLINE_FILE);
  // The take's frozen settings, plus the ones added since it was made (music, effect lists, intensity), read
  // from the outline it was made with.
  const style: EditStyle = takeStyle(takeOutline, data.edit_style);
  const brief = takeBrief(runId, data.video);
  const summary = brief.summary;
  const segs = readTranscript(data.video) ?? [];
  const vt = readVision(data.video);
  const cat = loadCatalog();
  const assets = await measureAssets(listAssets());
  // What the planner is offered and checked against (no noise beds unless the outline asks for them).
  const offered = offeredAssets(assets, takeOutline);
  const reference = referenceText(readReference());
  const lens = (readSetting(takeOutline, "Clip length") ?? "").match(/\d+/g) ?? [];
  const maxLen = (lens.length >= 2 ? Number(lens[1]) : 90) * 1.1 + 3;
  const vertical = data.aspect === "9:16";
  const aspect = await probeAspect(data.video);
  const lines = (a: number, b: number) => segs.filter((s) => s.end > a && s.start < b).map((s) => s.text);
  let cost = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));
  const out: DesignFile = { at: Date.now(), cost: 0, guide: brief.source === "llm" ? "llm" : "standard", clips: {} };
  const clips = data.clips.filter((c) => c.edit?.segments.length);
  ctx.log(`Designing ${clips.length} clip(s): the LLM plans two edits each from ${cat.effects.length} effects${assets.length ? ` and ${assets.length} files in assets/` : ""}, Jev picks`);
  for (const n of cat.notes) ctx.log(n, "warn");
  const testDir = join(dir, "design");
  mkdirSync(testDir, { recursive: true });

  /** Does ffmpeg accept this plan? Half a second of the real graph, into nothing. */
  const accepts = async (e: Edit, name: string, onlyFx?: number[]) => {
    const c = compileEdit({ edit: e, style, video: data.video, vertical, aspect, vt, segs, catalog: cat, assets, dir: testDir, name, out: `${name}.mp4`, test: 0.4, onlyFx });
    for (const [f, text] of Object.entries(c.files)) writeFileSync(join(testDir, f), text, "utf8");
    const r = await run(c.args, { cwd: testDir, signal: ctx.signal });
    return { ok: r.code === 0, err: r.stderr.trim().split(/\r?\n/).slice(-2).join(" ").slice(0, 300), notes: c.notes };
  };

  let done = 0;
  await pool(clips, 3, async (c) => {
    const base = c.edit!;
    const rec: DesignFile["clips"][string] = (out.clips[c.id] = { zooms: [], transitions: [] });
    const map0 = layout(base, style, cat, segs);
    const scored = !!scoreFor(runId, c.id);
    // 1. The LLM writes two plans. One that can't be read is asked for again, once.
    let raws: any[] = [];
    for (let attempt = 0; attempt < 2 && !raws.length; attempt++) try {
      const prompt = PLAN_PROMPT({
        brief: summary, outline: clipStr(takeOutline, 7000), reference, rules: rulesText(style, cat, offered, Math.round(maxLen), scored),
        clip: clipText(base, map0, vt), title: base.title,
        captions: style.captions === "none" ? "there are no captions" : `captions sit ${style.position === "middle" ? "in the middle" : style.position === "bottom" ? "at the bottom" : "in the lower third"}${style.title ? `; the hook card is at the ${style.titlePosition} for the first ${style.titleSeconds}s` : ""}`,
        library: catalogText(cat, {
          camera: style.zooms, looks: style.looks, transitions: style.transitions,
          timeline: (d: EffectDef) => d.kind === "music" ? !!style.music?.on && !scored : d.kind === "sound" ? !style.sounds || style.sounds.includes(d.name) : !style.effects || style.effects.includes(d.name),
        }),
        assets: assetsText(offered),
      });
      const res = await openrouter({ temperature: attempt ? 0.6 : 0.8, ...WRITER, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
      addCost(res.usage?.cost);
      raws = (extractJson(res.content).concepts ?? []).filter((x: unknown) => x && typeof x === "object").slice(0, 3);
      if (!raws.length) throw new Error("no plans in its answer");
      ctx.log(`Clip ${c.id}: ${res.model} wrote ${raws.length} edit plans ($${(res.usage?.cost ?? 0).toFixed(4)})`);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Clip ${c.id}: the LLM's plan couldn't be read (${err instanceof Error ? err.message : err}); ${attempt ? "Jev picks moves instead" : "asking again"}`, "warn");
    }
    // 2. Code checks them, and ffmpeg test-runs each; a broken effect is found and dropped.
    const plans: Plan[] = [];
    for (const [i, raw] of raws.entries()) {
      const pl = checkConcept(raw, String.fromCharCode(97 + i), base, style, cat, offered, segs, maxLen, scored);
      if (!pl) continue;
      const name = `clip_${String(c.id).padStart(2, "0")}_${pl.key}`;
      let t = await accepts(pl.edit, name);
      if (!t.ok && pl.edit.fx?.length) {
        const bad: number[] = [];
        for (let k = 0; k < pl.edit.fx.length; k++) if (!(await accepts({ ...pl.edit }, `${name}_${k}`, [k])).ok) bad.push(k);
        for (const k of bad) pl.notes.push(`${pl.edit.fx[k].fx} didn't render, so it was dropped`);
        pl.edit.fx = pl.edit.fx.filter((_, k) => !bad.includes(k));
        t = await accepts(pl.edit, name);
      }
      if (!t.ok) {
        pl.notes.push(`ffmpeg rejected this plan: ${t.err}`);
        rec.concepts = [...(rec.concepts ?? []), { key: pl.key, name: pl.name, idea: pl.idea, p: 0, chosen: false, ok: false, plan: [], notes: pl.notes }];
        continue;
      }
      pl.notes.push(...t.notes);
      plans.push(pl);
    }
    // 3. Jev picks the plan a professional would choose.
    let chosen: Plan | null = plans[0] ?? null;
    let odds: Record<string, number> = chosen ? { [chosen.key]: 1 } : {};
    if (plans.length > 1) {
      const criteria = Object.fromEntries(plans.map((pl) => [pl.key, clipStr(`${pl.name}: ${pl.idea} | ${planLines(pl.edit, layout(pl.edit, style, cat, segs), cat).join("; ")}`, 1400)]));
      try {
        const d = await decide({
          brief: summary, ...(reference ? { style_reference: clipStr(reference, 2500) } : {}),
          outline_editing_rules: clipStr(rulesText(style, cat, offered, Math.round(maxLen), scored), 1500),
          clip_transcript: clipStr(base.segments.flatMap((s) => lines(s.start, s.end)).join("\n"), 3000),
          ...(vt ? { shot_log: visualsIn(vt, Math.min(...base.segments.map((s) => s.start)), Math.max(...base.segments.map((s) => s.end)), 10) } : {}),
        }, { plan: { type: "choice", instructions: "Which edit plan would a professional short-form editor choose for this clip? It must follow the outline's editing rules and tone, copy the style reference where asked, and serve the moment without distracting from it.", criteria } }, ctx.signal);
        addCost(d.cost);
        const a = d.answers.plan;
        if (a?.type === "choice" && criteria[a.choice]) {
          chosen = plans.find((pl) => pl.key === a.choice)!;
          odds = a.probabilities;
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`Clip ${c.id}: Jev couldn't compare the plans (${err instanceof Error ? err.message : err}); using the first`, "warn");
      }
    }
    if (chosen) {
      rec.mode = "concepts";
      rec.concepts = [
        ...plans.map((pl) => ({ key: pl.key, name: pl.name, idea: pl.idea, p: odds[pl.key] ?? 0, chosen: pl === chosen, ok: true, plan: planLines(pl.edit, layout(pl.edit, style, cat, segs), cat), notes: pl.notes })),
        ...(rec.concepts ?? []),
      ].sort((x, y) => x.key.localeCompare(y.key));
      c.edit = { ...chosen.edit, concept: { name: chosen.name, idea: chosen.idea } };
      ctx.log(`Clip ${c.id}: "${chosen.name}" (Jev ${Math.round((odds[chosen.key] ?? 1) * 100)}%): ${chosen.edit.fx?.length ?? 0} timeline effects${chosen.notes.length ? `; ${chosen.notes.length} note${chosen.notes.length > 1 ? "s" : ""}` : ""}`);
    } else {
      // Moves only, from the picked parts: an earlier design's effects, speeds and freezes don't stay behind.
      rec.mode = "moves";
      const e = c.edit!;
      delete e.fx;
      delete e.concept;
      for (const s of e.segments) for (const k of ["fx", "speed", "freeze", "reverse"] as const) delete s[k];
      await moves(e, rec);
    }
    ctx.progress(0.98 * (++done / clips.length), `edits ${done}/${clips.length}`);
  }, ctx.signal);
  rmSync(testDir, { recursive: true, force: true });

  /** The fallback: Jev picks a camera move per part, flashbacks, the final beat and a transition per join. */
  async function moves(e: Edit, rec: DesignFile["clips"][string]) {
    const zooms = style.zooms.filter((z) => ZOOM_GUIDE[z] || brief.design.zoomGuide[z as keyof typeof brief.design.zoomGuide]);
    const transitions = style.transitions.filter((t) => TRANSITION_GUIDE[t] || brief.design.transitionGuide[t as keyof typeof brief.design.transitionGuide]);
    const zoomCriteria = Object.fromEntries(zooms.map((z) => [z, (brief.design.zoomGuide as Record<string, string>)[z] ?? ZOOM_GUIDE[z]]));
    const trCriteria = Object.fromEntries(transitions.map((t) => [t, (brief.design.transitionGuide as Record<string, string>)[t] ?? TRANSITION_GUIDE[t]]));
    const decisions: DesignDecision[] = [];
    const n = e.segments.length;
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
      if (z?.type === "choice" && zooms.includes(z.choice)) {
        s.zoom = z.choice;
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
      const alt = Object.entries(d.options).filter(([k]) => k !== cur.zoom && zooms.includes(k)).sort((a, b) => b[1] - a[1])[0];
      if (alt && alt[1] >= 0.15) {
        cur.zoom = d.zoom = alt[0];
        d.p = alt[1];
        d.varied = true;
      }
    }
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
      if (t?.type === "choice" && transitions.includes(t.choice)) {
        e.transitions[i] = t.choice;
        trs.push({ gap: i + 1, transition: t.choice, p: t.probabilities[t.choice] ?? t.confidence, options: t.probabilities });
      }
    }));
    // A flash is a one-off: keep only the most confident one.
    const flashes = trs.filter((t) => t.transition === "flash").sort((a, b) => b.p - a.p);
    for (const f of flashes.slice(1)) e.transitions[f.gap - 1] = "crossfade";
    rec.zooms = decisions.sort((a, b) => a.piece - b.piece);
    rec.transitions = trs.sort((a, b) => a.gap - b.gap);
  }

  // Changing a reviewed take's edit sends it back to review: you review what will actually be rendered.
  if (readReview(runId).approved) {
    setApproved(runId, false);
    ctx.log("This take was already reviewed; its edits changed, so it's back in review", "warn");
  }
  out.cost = cost;
  out.inputs = designInputs(runId);
  // Takes designed before Hook cards was its own step keep their hook cards in design.json. They move to
  // titles.json before it's rewritten, so the step stays done and the clips keep the cards they were made with.
  const legacy = existsSync(join(dir, "titles.json")) ? null : readTitles(runId);
  if (legacy) writeFileSync(join(dir, "titles.json"), JSON.stringify(legacy, null, 1), "utf8");
  writeClipData(script, data);
  writeFileSync(join(dir, "design.json"), JSON.stringify(out, null, 1), "utf8");
  const planned = Object.values(out.clips).filter((c) => c.mode === "concepts").length;
  const effects = data.clips.reduce((n, c) => n + (c.edit?.fx?.length ?? 0), 0);
  ctx.log(`Design done: ${planned}/${clips.length} clips from the LLM's plans (Jev picked), ${effects} timeline effects ($${cost.toFixed(4)})`);
  ctx.progress(1, "edits designed");
  return { run: runId, clips: Object.keys(out.clips).length, planned, effects, cost };
}
