// An edit → one ffmpeg run. In order:
//   parts        one input per shot part (fast, frame-accurate seek): speed, 9:16 framing (face-tracked),
//                camera move, the take's grade, looks; freeze frames and reversed parts
//   joins        cuts (concat) and transitions (xfade + acrossfade); effects a transition lays around its join
//   video fx     each over its time range: that stretch is cut out, processed and spliced back, so an effect
//                costs only its own frames and ffmpeg never buffers the clip
//   finishing    the outline's glow; graphics and your overlays; vignette, grain, bars, fades; then captions,
//                the hook card and text effects (one ASS file)
//   audio        voice effects over their ranges, generated sounds and your sound files, music ducked under
//                speech, one mix with a limiter
// A test compile runs the same graph for half a second into nothing: the check Design uses before it keeps
// a plan, so a broken effect is dropped with a note instead of failing the render.
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Segment } from "../lib";
import { framingParts, type Edit, type EditSegment, type EditStyle } from "../agents/edit";
import { framingFilter, type Framing } from "../agents/framing";
import type { VisionTranscript } from "../agents/vision";
import { ASSETS_DIR, ASSET_FOLDERS, findAsset, type Asset } from "./assets";
import { findEffect, TIMELINE_KINDS, type Catalog } from "./catalog";
import { assColor, assText, assTime, fill, ffPath, isRtl, resolveParams, type Values } from "./template";
import { layout, MAX_FREEZE, MAX_REVERSE, MAX_SPEED, MIN_SPEED, spanOf, upgradeUse, wordsOf, type TimelineMap } from "./timeline";
import type { EffectDef, FxUse } from "./types";

const FPS = 30;
/** A ceiling on the video bitrate. Film grain is noise the encoder can't compress, and at the quality setting
 *  alone a strongly grained minute came out at ~50 Mbit/s (400+ MB); platforms re-encode above ~10 anyway. */
export const BITRATE_CAP = ["-maxrate", "12M", "-bufsize", "24M"];
type Part = { start: number; end: number; framing: Framing };

export type CompileInput = {
  edit: Edit; style: EditStyle; video: string; vertical: boolean; aspect?: number;
  vt?: VisionTranscript | null;
  /** Face-tracked framing parts per segment (track.ts). Falls back to the shot-level framing. */
  tracked?: Record<number, Part[]>;
  segs: Segment[]; catalog: Catalog; assets: Asset[];
  /** Where ffmpeg runs (the take's folder): the ASS file and a long filter graph are written here. */
  dir: string;
  /** Base name for the files it writes ("clip_03"), and the output file (relative to dir). */
  name: string; out: string;
  /** Check only: run the graph for half a second (or this many seconds) into nothing. */
  test?: boolean | number;
  /** The music made for this clip (the Music step): it plays under the whole clip, ducked under speech,
   *  instead of any music the plan names. */
  score?: { file: string; volume?: number; duck?: number; lufs?: number; seconds?: number };
  /** Gain on the source's voice (dB) that brings it to dialogue level (-18 LUFS), measured by render.ts, so
   *  music and sounds are mixed against a voice at a known level whatever the recording's own level. */
  voiceGain?: number;
  /** Only these timeline effects (indexes into edit.fx), to find one that breaks. */
  onlyFx?: number[];
};
export type Compiled = {
  args: string[]; duration: number; notes: string[];
  /** Every effect definition and asset the edit used: the render's fingerprint includes them. */
  used: EffectDef[]; assets: Asset[];
  /** Files to write into dir before running (name → contents). */
  files: Record<string, string>;
  map: TimelineMap;
  counts: { parts: number; joins: number; video: number; overlays: number; text: number; sounds: number; voice: number; music: number };
  /** How the clip's score was fitted to its length, for the render log. */
  fit?: string;
};

const r3 = (n: number) => n.toFixed(3);
const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(0).padStart(2, "0")}`;

/**
 * A score cut to its clip's length the way a music editor would. Lyria takes a requested length loosely
 * (a minute for a 30-second clip), and its tracks end with a composed ending, so trimming at the clip's end
 * would fade out mid-phrase. Instead the score keeps its opening and its ending and the difference comes
 * out of the middle, or, when the score is short, a middle stretch plays twice. Either way it's one
 * `x`-second crossfade at clip time j, placed where someone is talking so the ducked music hides it:
 * the head is [0, j + x/2] of the score and the tail [L - T + j - x/2, L], which add up to T.
 * Null when one join can't do it (a clip over twice its score's length): loop it instead.
 */
export function fitScore(L: number, T: number, words: { t: number; tEnd: number }[], x = 2): { pieces: [number, number][]; join?: number; how: string } | null {
  if (!(L > 0) || !(T > 0)) return null;
  const excess = L - T;
  if (Math.abs(excess) < 0.05) return { pieces: [[0, L]], how: "fits as it is" };
  if (excess > 0 && excess <= x + 1) return { pieces: [[excess, L]], how: `starts ${excess.toFixed(1)}s in, so its ending lands on the last frame` };
  if (T < 4 * x) return excess > 0 ? { pieces: [[0, T]], how: "its opening only (the clip is short)" } : null;
  // The head stops before the composed ending, and a repeat doesn't replay the first seconds.
  const ending = Math.min(8, L / 4);
  const lo = Math.max(0.3 * T, excess < 0 ? -excess + x / 2 + 2 : 0);
  const hi = Math.min(0.7 * T, L - ending - x / 2);
  if (lo > hi) return null;
  const talk = (t: number) => words.reduce((n, w) => n + Math.max(0, Math.min(w.tEnd, t + x / 2 + 0.3) - Math.max(w.t, t - x / 2 - 0.3)), 0);
  let j = (lo + hi) / 2, most = -Infinity;
  for (let t = lo; t <= hi + 1e-6; t += 0.25) {
    const s = talk(t) - Math.abs(t - (lo + hi) / 2) * 0.01; // on a tie, nearer the middle
    if (s > most) (most = s), (j = t);
  }
  const where = `at ${mmss(j)}${talk(j) > x / 2 ? " under speech" : ""}`;
  return {
    pieces: [[0, j + x / 2], [L - T + j - x / 2, L]], join: j,
    how: excess > 0 ? `kept its opening and its ending, ${excess.toFixed(1)}s taken out of the middle ${where}` : `${(-excess).toFixed(1)}s of its middle plays twice, joined ${where}`,
  };
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** Frame-exact seconds, so trims split cleanly between frames. */
const fr = (t: number) => Math.round(t * FPS) / FPS;

function atempo(speed: number) {
  const out: string[] = [];
  let r = speed;
  while (r > 2) (out.push("atempo=2"), (r /= 2));
  while (r < 0.5) (out.push("atempo=0.5"), (r /= 0.5));
  out.push(`atempo=${r.toFixed(4)}`);
  return out.join(",");
}

const GRADES: Record<EditStyle["grade"], string> = {
  none: "",
  subtle: "eq=contrast=1.04:saturation=1.08",
  punchy: "eq=contrast=1.08:saturation=1.18:brightness=0.01",
  warm: "colorbalance=rs=0.05:gs=0.01:bs=-0.06:rm=0.04:bm=-0.05:rh=0.03:bh=-0.03,eq=contrast=1.05:saturation=1.1:gamma=1.02",
  cinematic: "colorbalance=rs=-0.06:bs=0.07:rh=0.07:gh=0.02:bh=-0.07,eq=contrast=1.1:saturation=1.05",
  // Faded film: lifted blacks, softened highlights, less saturation, a touch of warmth.
  // (ffmpeg's curves=preset=vintage casts everything magenta, which read as a broken filter.)
  nostalgic: "curves=all='0/0.07 0.5/0.5 1/0.94',eq=saturation=0.78:gamma=1.02,colorbalance=rs=0.04:gs=0.015:bs=-0.04:rm=0.03:bm=-0.03",
};

const POSITIONS: Record<string, [string, string]> = {
  full: ["0", "0"], center: ["(W-w)/2", "(H-h)/2"], top: ["(W-w)/2", "H*0.06"], bottom: ["(W-w)/2", "H-h-H*0.08"],
  left: ["W*0.04", "(H-h)/2"], right: ["W-w-W*0.04", "(H-h)/2"], top_left: ["W*0.04", "H*0.06"], top_right: ["W-w-W*0.04", "H*0.06"],
  bottom_left: ["W*0.04", "H-h-H*0.08"], bottom_right: ["W-w-W*0.04", "H-h-H*0.08"],
};
const KEYS: Record<string, string> = { green: "colorkey=0x00FF00:0.32:0.12", black: "colorkey=0x000000:0.12:0.08", white: "colorkey=0xFFFFFF:0.12:0.08" };

export function compileEdit(p: CompileInput): Compiled {
  const { edit: e, style, video, vertical, catalog: cat } = p;
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const notes: string[] = [];
  const used: EffectDef[] = [];
  const usedAssets: Asset[] = [];
  const counts = { parts: e.segments.length, joins: 0, video: 0, overlays: 0, text: 0, sounds: 0, voice: 0, music: 0 };
  const map = layout(e, style, cat, p.segs);
  const T = map.duration;
  const inputs: string[] = [];
  let nIn = 0;
  const addInput = (...args: string[]) => (inputs.push(...args), nIn++);
  const f: string[] = [];
  let uid = 0;
  const U = () => String(uid++);
  const assetPath = (kinds: Asset["kind"][], name: string) => {
    const a = findAsset(p.assets, kinds, name);
    if (a && !usedAssets.includes(a)) usedAssets.push(a);
    return a?.file ?? null;
  };
  /** A template's values: its parameters (checked) plus the render context. */
  const valuesFor = (def: EffectDef, use: FxUse | undefined, ctx: Values): Values | null => {
    const { values, notes: n, missing } = resolveParams(def.params, use?.params, assetPath);
    n.forEach((x) => notes.push(`${def.name}: ${x}`));
    if (missing.some((k) => def.params?.[k]?.type === "asset" || (def.params?.[k]?.type === "text" && !def.params[k].default))) return null;
    return { ...ctx, ...values };
  };
  const templateOf = (def: EffectDef, v: Values) => def.variants ? def.variants.filters[String(v[def.variants.param])] ?? Object.values(def.variants.filters)[0] : def.filter ?? "";
  const tryFill = (def: EffectDef, tpl: string, v: Values) => {
    try {
      return fill(tpl, v);
    } catch (err) {
      notes.push(`${def.name}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  };
  const use = (def: EffectDef) => (used.includes(def) ? def : (used.push(def), def));

  /** A filled template between two labels: a chain ("a,b,c") or a graph with [in], [out] and [_local] labels. */
  const place = (tpl: string, inL: string | null, outL: string) => {
    if (tpl.includes("[out]")) {
      const id = U();
      let g = tpl.replace(/\[_(\w+)\]/g, `[_$1_${id}]`).replace(/\[out\]/g, `[${outL}]`);
      if (inL) g = g.replace(/\[in\]/g, `[${inL}]`);
      f.push(g);
    } else f.push(`${inL ? `[${inL}]` : ""}${tpl}[${outL}]`);
  };
  /** Several filled templates in a row: chains joined with commas, graphs placed on their own. */
  const pipe = (from: string, steps: string[], to: string) => {
    let cur = from;
    let buf: string[] = [];
    const flush = (label: string) => {
      f.push(`[${cur}]${buf.length ? buf.join(",") : "null"}[${label}]`);
      cur = label;
      buf = [];
    };
    for (const st of steps.filter(Boolean)) {
      if (!st.includes("[out]")) {
        buf.push(st);
        continue;
      }
      if (buf.length || cur === from) flush(`q${U()}`);
      const next = `q${U()}`;
      place(st, cur, next);
      cur = next;
    }
    flush(to);
  };

  // ── parts ──────────────────────────────────────────────────────────
  const grade = GRADES[style.grade] ?? "";
  // The voice, cleaned of the recording's rumble and steady hiss (old TV and phone recordings hiss, and
  // mastering to -14 LUFS lifts that hiss with everything else). afftdn follows the noise as it goes.
  const cleanup = style.cleanup === "off" ? "" : `,highpass=f=70,afftdn=nr=${style.cleanup === "strong" ? 20 : 10}:nf=-50:tn=1`;
  const voice = p.voiceGain ? `,volume=${p.voiceGain.toFixed(2)}dB` : "";
  const segmentSteps = (s: EditSegment, crop: boolean, frames: number, dur: number): string[] => {
    const ctx: Values = { W, H, fps: FPS, frames, dur };
    const fxDefs = (s.fx ?? []).map((u) => ({ u, def: findEffect(cat, u.fx, ["segment"]) })).filter((x) => {
      if (!x.def) notes.push(`"${x.u.fx}" isn't a part effect; skipped`);
      return !!x.def;
    }) as { u: FxUse; def: EffectDef }[];
    const camera = fxDefs.find((x) => x.def.cropOnly) ?? (s.zoom && s.zoom !== "none" ? { u: { fx: s.zoom } as FxUse, def: findEffect(cat, s.zoom, ["segment"]) } : null);
    const steps: string[] = [];
    // Zooming a split screen or a fitted group trims the people at the sides; only crops move.
    const cam = camera?.def && crop ? (() => {
      const v = valuesFor(use(camera.def!), camera.u, ctx);
      return v && tryFill(camera.def!, templateOf(camera.def!, v), v);
    })() : null;
    steps.push(cam || `scale=${W}:${H}`);
    if (grade) steps.push(grade);
    const looks = fxDefs.filter((x) => !x.def.cropOnly);
    if (s.look && s.look !== "none" && !looks.some((x) => x.def.name === s.look)) {
      const def = findEffect(cat, s.look, ["segment"]);
      if (def) looks.push({ u: { fx: def.name }, def });
    }
    for (const { u, def } of looks) {
      const v = valuesFor(use(def), u, ctx);
      const t = v && tryFill(def, templateOf(def, v), v);
      if (t) steps.push(t);
    }
    return steps;
  };

  e.segments.forEach((s, i) => {
    const speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, s.speed ?? 1));
    const dur = s.end - s.start;
    const outDur = dur / speed;
    const freeze = Math.min(MAX_FREEZE, Math.max(0, s.freeze ?? 0));
    const reverse = !!s.reverse && dur <= MAX_REVERSE;
    if (s.reverse && !reverse) notes.push(`part ${i + 1} is longer than ${MAX_REVERSE}s, so it plays forwards`);
    // Vertical output: split the segment at shot cuts so each shot gets its own measured framing
    // (crop on the faces, split screen, or fit), tracked over time when faces move. Measured faces
    // win over a planner's reframe_x, which only steers shots where nothing was measured.
    const parts: Part[] = !vertical
      ? [{ start: s.start, end: s.end, framing: { mode: "crop", cx: 0.5, measured: false } }]
      : !style.reframe
        ? [{ start: s.start, end: s.end, framing: { mode: "crop", cx: s.reframe_x ?? 0.5, measured: s.reframe_x !== undefined } }]
        : (p.tracked?.[i] ?? framingParts(p.vt ?? null, s.start, s.end)).map((pt) =>
            pt.framing.mode === "crop" && !pt.framing.measured && s.reframe_x !== undefined
              ? { ...pt, framing: { mode: "crop" as const, cx: s.reframe_x, measured: true } }
              : pt,
          );
    const labels = parts.map((pt, k) => {
      const idx = addInput("-ss", r3(pt.start), "-t", r3(pt.end - pt.start), "-i", video);
      const frames = Math.max(1, Math.round(((pt.end - pt.start) / speed) * FPS));
      const frame = vertical ? framingFilter(pt.framing, W, H, `f${i}x${k}`, p.aspect ?? 16 / 9, speed) : "null";
      const steps = segmentSteps(s, !vertical || pt.framing.mode === "crop", frames, (pt.end - pt.start) / speed);
      // settb: xfade needs both inputs on the same timebase, and zoompan/concat change it.
      if (steps.every((st) => !st.includes("[out]"))) {
        f.push(`[${idx}:v]setpts=(PTS-STARTPTS)/${speed},fps=${FPS},${frame},${steps.join(",")},setsar=1,format=yuv420p,settb=1/${FPS}[p${i}x${k}]`);
      } else {
        f.push(`[${idx}:v]setpts=(PTS-STARTPTS)/${speed},fps=${FPS},${frame},format=yuv420p[p${i}x${k}a]`);
        pipe(`p${i}x${k}a`, [...steps, `setsar=1,format=yuv420p,settb=1/${FPS}`], `p${i}x${k}`);
      }
      return `p${i}x${k}`;
    });
    const tail = [reverse && "reverse", freeze > 0 && `tpad=stop_mode=clone:stop_duration=${r3(freeze)}`].filter(Boolean).join(",");
    f.push(labels.length === 1 && !tail
      ? `[${labels[0]}]null[v${i}]`
      : `${labels.map((l) => `[${l}]`).join("")}${labels.length > 1 ? `concat=n=${labels.length}:v=1:a=0,` : ""}${tail ? `${tail},` : ""}settb=1/${FPS}[v${i}]`);
    // Audio comes from one continuous read of the segment, so shot-level splits never click.
    const ai = addInput("-ss", r3(s.start), "-t", r3(dur), "-i", video);
    const full = outDur + freeze;
    f.push(`[${ai}:a]asetpts=PTS-STARTPTS${cleanup}${voice}${speed !== 1 ? `,${atempo(speed)}` : ""},aresample=48000,aformat=channel_layouts=stereo${reverse ? ",areverse" : ""},apad=whole_dur=${r3(full)},atrim=0:${r3(full)}[a${i}]`);
  });

  // ── joins ──────────────────────────────────────────────────────────
  const joinFx: FxUse[] = [];
  let v = "v0", a = "a0";
  for (let i = 1; i < e.segments.length; i++) {
    const j = map.joins[i - 1];
    const nv = `vx${i}`, na = `ax${i}`;
    if (j.def) use(j.def);
    if (j.overlap > 0 && j.def?.xfade) {
      f.push(`[${v}][v${i}]xfade=transition=${j.def.xfade}:duration=${r3(j.overlap)}:offset=${r3(j.start)},format=yuv420p[${nv}]`);
      f.push(`[${a}][a${i}]acrossfade=d=${r3(j.overlap)}[${na}]`);
    } else {
      f.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${nv}c][${na}]`, `[${nv}c]settb=1/${FPS},format=yuv420p[${nv}]`);
    }
    if (j.def && j.def.name !== "cut") counts.joins++;
    // Effects a transition lays around its join, and a file played over the cut.
    const at = j.start;
    const len = j.len || j.def?.duration || style.transitionLength;
    for (const ar of j.def?.around ?? []) {
      const d = findEffect(cat, ar.fx, TIMELINE_KINDS);
      if (!d) continue;
      joinFx.push(d.timing === "instant" ? { fx: d.name, at, duration: len, params: ar.params } : { fx: d.name, from: at, to: at + len, params: ar.params });
    }
    if (j.def?.special === "asset_transition") {
      const file = String(j.params?.file ?? "");
      if (findAsset(p.assets, ["overlay"], file)) joinFx.push({ fx: "overlay", from: Math.max(0, j.t - len / 2), to: j.t + len / 2, params: { file, position: "full", key: j.params?.key ?? "none", once: 1 } });
      else notes.push(`asset_wipe after part ${i}: ${file ? `"${file}" isn't in assets/overlays` : "no file given"}; it's a cut`);
    }
    v = nv;
    a = na;
  }

  // ── timeline effects ───────────────────────────────────────────────
  type Placed = { u: FxUse; def: EffectDef; span: [number, number] };
  const placed: Placed[] = [];
  const own = (e.fx ?? []).map((u, k) => ({ u, k })).filter(({ k }) => !p.onlyFx || p.onlyFx.includes(k));
  for (const { u: u0 } of [...own, ...joinFx.map((u) => ({ u, k: -1 }))]) {
    const u = upgradeUse(u0);
    if (!u) continue;
    if (p.score && findEffect(cat, u.fx, TIMELINE_KINDS)?.kind === "music") {
      notes.push("this clip has its own score, so the plan's music was left out");
      continue;
    }
    const def = findEffect(cat, u.fx, TIMELINE_KINDS);
    if (!def) {
      notes.push(`"${u.fx}" isn't a timeline effect; skipped`);
      continue;
    }
    const span = spanOf(u, def, map);
    if (!span) {
      notes.push(`${def.name}: its time isn't in this clip any more (was an edge nudged?); skipped`);
      continue;
    }
    placed.push({ u, def, span: [fr(span[0]), Math.max(fr(span[0]) + 1 / FPS, fr(span[1]))] });
  }
  const ctxFor = (pl: Placed): Values => {
    const [a0, b0] = pl.span;
    const text = String(pl.u.params?.text ?? "");
    return { W, H, fps: FPS, from: a0, to: b0, dur: b0 - a0, frames: Math.max(1, Math.round((b0 - a0) * FPS)), rtl: isRtl(text) ? 1 : 0 };
  };

  // Video effects: cut the stretch out, process it, splice it back.
  const videoStage = (cur: string, [a0, b0]: [number, number], tpl: string) => {
    const id = U();
    const pre = a0 > 0.5 / FPS, post = b0 < T - 0.5 / FPS;
    const outs = [pre && `b${id}`, `d${id}`, post && `c${id}`].filter(Boolean) as string[];
    f.push(outs.length > 1 ? `[${cur}]split=${outs.length}${outs.map((o) => `[${o}]`).join("")}` : `[${cur}]null[d${id}]`);
    if (pre) f.push(`[b${id}]trim=end=${r3(a0)}[b${id}o]`);
    // format pins the stretch to YUV: without it, a filter that only takes grey (edgedetect) makes ffmpeg
    // negotiate grey back through the splice and the transitions before it, and the clip loses its colour.
    f.push(`[d${id}]trim=start=${r3(a0)}:end=${r3(b0)},setpts=PTS-STARTPTS,format=yuv420p[d${id}i]`);
    place(tpl, `d${id}i`, `d${id}f`);
    f.push(`[d${id}f]scale=${W}:${H},setsar=1,format=yuv420p,settb=1/${FPS}[d${id}o]`);
    if (post) f.push(`[c${id}]trim=start=${r3(b0)},setpts=PTS-STARTPTS[c${id}o]`);
    f.push(`${outs.map((o) => `[${o}o]`).join("")}concat=n=${outs.length}:v=1:a=0,settb=1/${FPS},format=yuv420p[x${id}]`);
    return `x${id}`;
  };
  for (const pl of placed.filter((x) => x.def.kind === "video")) {
    const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
    const tpl = vals && tryFill(pl.def, templateOf(pl.def, vals), vals);
    if (!tpl) continue;
    use(pl.def);
    v = videoStage(v, pl.span, tpl);
    counts.video++;
  }

  // The outline's glow, over everything that's picture. Brightness only: a screen blend on the colour
  // planes of YUV pushes every colour toward magenta and grey.
  if (style.glow !== "none") {
    const op = style.glow === "strong" ? 0.35 : 0.2;
    f.push(`[${v}]format=yuv420p,split[g0][g1]`, `[g1]gblur=sigma=${vertical ? 28 : 22}[g2]`, `[g0][g2]blend=c0_mode=screen:c0_opacity=${op},format=yuv420p[glow]`);
    v = "glow";
  }

  // Graphics and your files, laid over the picture.
  const placeXY = (expr: string | undefined, axis: "x" | "y", a0: number) => {
    const s = String(expr ?? "0").trim();
    const kw: Record<string, string> = axis === "x" ? { left: "0", right: "W-w", center: "(W-w)/2" } : { top: "0", bottom: "H-h", center: "(H-h)/2" };
    return (kw[s] ?? s).replace(/\bt\b/g, `(t-${r3(a0)})`);
  };
  for (const pl of placed.filter((x) => x.def.kind === "graphic" || x.def.kind === "asset")) {
    const [a0, b0] = pl.span;
    const d = b0 - a0;
    const id = U();
    let x = "0", y = "0";
    if (pl.def.kind === "graphic") {
      const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
      const src = vals && tryFill(pl.def, pl.def.graphic ?? "", vals);
      if (!src || !vals) continue;
      use(pl.def);
      place(src, null, `gs${id}`);
      const frames = Math.max(1, Math.round(d * FPS));
      f.push(pl.def.static
        ? `[gs${id}]trim=end_frame=1,loop=loop=${frames - 1}:size=1:start=0,format=rgba,setpts=N/${FPS}/TB+${r3(a0)}/TB[g${id}]`
        : `[gs${id}]trim=duration=${r3(d)},format=rgba,setpts=PTS-STARTPTS+${r3(a0)}/TB[g${id}]`);
      const tx = pl.def.x ? tryFill(pl.def, pl.def.x, vals) : "0";
      const ty = pl.def.y ? tryFill(pl.def, pl.def.y, vals) : "0";
      x = placeXY(tx ?? "0", "x", a0);
      y = placeXY(ty ?? "0", "y", a0);
    } else {
      const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
      if (!vals) continue;
      const asset = p.assets.find((as) => as.file === vals.file);
      if (!asset) continue;
      use(pl.def);
      const ext = asset.file.toLowerCase().split(".").pop()!;
      const still = ["png", "jpg", "jpeg", "webp"].includes(ext) && asset.kind !== "overlay" || ["png", "jpg", "jpeg"].includes(ext);
      const once = !!pl.u.params?.once;
      const k = still ? addInput("-loop", "1", "-framerate", String(FPS), "-i", asset.file)
        : ext === "gif" ? addInput(...(once ? [] : ["-ignore_loop", "0"]), "-i", asset.file)
        : addInput(...(once ? [] : ["-stream_loop", "-1"]), ...(ext === "webm" ? ["-c:v", asset.vcodec === "vp8" ? "libvpx" : "libvpx-vp9"] : []), "-i", asset.file);
      const pos = String(vals.position ?? "center");
      const scale = pos === "full" ? `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}` : `scale=${even(W * Number(vals.scale ?? 0.5))}:-2`;
      const key = KEYS[String(vals.key ?? "none")] ?? "";
      const op = Number(vals.opacity ?? 1);
      f.push(`[${k}:v]trim=duration=${r3(d)},setpts=PTS-STARTPTS,fps=${FPS},${scale},format=rgba${key ? `,${key}` : ""}${op < 1 ? `,colorchannelmixer=aa=${op}` : ""},setpts=PTS+${r3(a0)}/TB[g${id}]`);
      [x, y] = POSITIONS[pos] ?? POSITIONS.center;
    }
    f.push(`[${v}][g${id}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0[o${id}]`);
    v = `o${id}`;
    counts.overlays++;
  }

  // ── captions, the hook card and text effects (one ASS file) ────────
  const textEvents: string[] = [];
  for (const pl of placed.filter((x) => x.def.kind === "text")) {
    const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
    if (!vals) continue;
    const lines = (pl.def.ass ?? []).map((l) => tryFill(pl.def, l, vals));
    if (lines.some((l) => !l)) continue;
    use(pl.def);
    textEvents.push(...(lines as string[]));
    counts.text++;
  }
  const ass = buildAss(e, map, p.segs, style, W, H, textEvents);
  const assName = ass ? `${p.name}.ass` : null;

  // Finishing: vignette, grain, letterbox bars, fades, then captions on top.
  const post: string[] = [];
  if (style.vignette !== "none") post.push(style.vignette === "strong" ? "vignette=PI/4" : "vignette=PI/6");
  if (style.grain !== "none") post.push(`noise=alls=${style.grain === "strong" ? 14 : 7}:allf=t`);
  if (style.letterbox) {
    const bar = Math.round(H * (vertical ? 0.06 : 0.1));
    post.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  const fadeIn = style.fades ? 0.6 : 0, fadeOut = style.fades ? 0.9 : 0;
  if (style.fades) post.push(`fade=t=in:d=${fadeIn}`, `fade=t=out:st=${r3(Math.max(0, T - fadeOut))}:d=${fadeOut}`);
  if (assName) {
    const fonts = join(ASSETS_DIR, ASSET_FOLDERS.font);
    const rel = existsSync(fonts) ? relative(p.dir, fonts).split("\\").join("/") : "";
    post.push(`ass=${assName}${rel ? `:fontsdir='${ffPath(rel)}'` : ""}`);
  }
  // The output's format is fixed: encoders that also take greyscale (x264, PNG) can otherwise be handed a
  // grey picture when an effect uses a greyscale-only filter somewhere in the graph.
  post.push("format=yuv420p");
  f.push(`[${v}]${post.join(",")}[vout]`);

  // ── audio ──────────────────────────────────────────────────────────
  const audioStage = (cur: string, [a0, b0]: [number, number], tpl: string) => {
    const id = U();
    const pre = a0 > 0.01, postA = b0 < T - 0.01;
    const outs = [pre && `ab${id}`, `ad${id}`, postA && `ac${id}`].filter(Boolean) as string[];
    const norm = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
    f.push(outs.length > 1 ? `[${cur}]asplit=${outs.length}${outs.map((o) => `[${o}]`).join("")}` : `[${cur}]anull[ad${id}]`);
    if (pre) f.push(`[ab${id}]atrim=end=${r3(a0)},${norm}[ab${id}o]`);
    f.push(`[ad${id}]atrim=start=${r3(a0)}:end=${r3(b0)},asetpts=PTS-STARTPTS[ad${id}i]`);
    place(tpl, `ad${id}i`, `ad${id}f`);
    f.push(`[ad${id}f]${norm},apad=whole_dur=${r3(b0 - a0)},atrim=0:${r3(b0 - a0)}[ad${id}o]`);
    if (postA) f.push(`[ac${id}]atrim=start=${r3(b0)},asetpts=PTS-STARTPTS,${norm}[ac${id}o]`);
    f.push(`${outs.map((o) => `[${o}o]`).join("")}concat=n=${outs.length}:v=0:a=1[ax${id}]`);
    return `ax${id}`;
  };
  for (const pl of placed.filter((x) => x.def.kind === "voice")) {
    const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
    const tpl = vals && tryFill(pl.def, templateOf(pl.def, vals), vals);
    if (!tpl) continue;
    use(pl.def);
    a = audioStage(a, pl.span, tpl);
    counts.voice++;
  }
  const mix: string[] = [];
  const toStereo = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  for (const pl of placed.filter((x) => x.def.kind === "sound")) {
    const [a0, b0] = pl.span;
    const id = U();
    const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
    if (!vals) continue;
    const delay = `adelay=${Math.round(a0 * 1000)}:all=1`;
    if (pl.def.special === "sfx_file") {
      const k = addInput("-i", String(vals.file));
      const trim = pl.u.duration ? `atrim=duration=${r3(b0 - a0)},` : "";
      f.push(`[${k}:a]${trim}asetpts=PTS-STARTPTS,${toStereo},volume=${Number(vals.gain ?? 0.8)},${delay}[s${id}]`);
    } else if (pl.def.special === "sfx_bed") {
      // A recorded bed looped under the range, faded in and out.
      const d = b0 - a0;
      const fade = Math.min(Number(vals.fade ?? 0.6), d / 3);
      const k = addInput("-stream_loop", "-1", "-i", String(vals.file));
      f.push(`[${k}:a]atrim=duration=${r3(d)},asetpts=PTS-STARTPTS,${toStereo},volume=${Number(vals.gain ?? 0.3)}${fade > 0 ? `,afade=t=in:d=${r3(fade)},afade=t=out:st=${r3(d - fade)}:d=${r3(fade)}` : ""},${delay}[s${id}]`);
    } else {
      const src = tryFill(pl.def, pl.def.sound ?? "", vals);
      if (!src) continue;
      place(src, null, `sr${id}`);
      f.push(`[sr${id}]atrim=duration=${r3(b0 - a0)},${toStereo},${delay}[s${id}]`);
    }
    use(pl.def);
    mix.push(`s${id}`);
    counts.sounds++;
  }
  // Music: the clip's own score under the whole clip, or the beds the plan placed.
  // Every bed is first brought to -16 LUFS, so `volume` means the same thing for every track (a loud master
  // and a quiet one sit at the same level under a voice at -18).
  const level = (lufs?: number) => (lufs === undefined ? 1 : Math.min(4, Math.max(0.1, Math.pow(10, (-16 - lufs) / 20))));
  type Bed = { file: string; volume: number; duck: number; offset: number; fade: number; a0: number; b0: number; def?: EffectDef; fit?: ReturnType<typeof fitScore> };
  const XFADE = 2;
  const fit = p.score?.seconds ? fitScore(p.score.seconds, T, map.words, XFADE) : null;
  const beds: Bed[] = p.score
    ? [{ file: p.score.file, volume: (p.score.volume ?? style.music?.volume ?? 0.18) * level(p.score.lufs), duck: p.score.duck ?? 0.7, offset: 0, fade: 1.5, a0: 0, b0: T, fit }]
    : placed.filter((x) => x.def.kind === "music").flatMap((pl) => {
        const vals = valuesFor(pl.def, pl.u, ctxFor(pl));
        const lufs = p.assets.find((as) => as.file === vals?.file)?.lufs;
        return vals ? [{ file: String(vals.file), volume: Number(vals.volume ?? 0.25) * level(lufs), duck: Number(vals.duck ?? 0.7), offset: Number(vals.offset ?? 0), fade: Number(vals.fade ?? 1.5), a0: pl.span[0], b0: pl.span[1], def: pl.def }] : [];
      });
  if (beds.length) {
    // The voice is split once: one copy is mixed, the others tell each music bed when to duck.
    f.push(`[${a}]asplit=${beds.length + 1}[vmix]${beds.map((_, i) => `[vsc${i}]`).join("")}`);
    a = "vmix";
    beds.forEach((b, i) => {
      const d = b.b0 - b.a0;
      const ratio = 1 + 15 * b.duck;
      if (b.fit) {
        // A fitted score: each piece read straight from the file, crossfaded (equal power, so the join
        // doesn't dip). Its own ending plays out, so only a short fade guards the last frame; a score
        // that starts late fades in.
        const ks = b.fit.pieces.map(([s0, s1]) => addInput("-ss", r3(s0), "-t", r3(s1 - s0), "-i", b.file));
        ks.forEach((k, j) => f.push(`[${k}:a]asetpts=PTS-STARTPTS,${toStereo}[mp${i}_${j}]`));
        let cur = `mp${i}_0`;
        for (let j = 1; j < ks.length; j++) {
          f.push(`[${cur}][mp${i}_${j}]acrossfade=d=${XFADE}:c1=qsin:c2=qsin[mx${i}_${j}]`);
          cur = `mx${i}_${j}`;
        }
        const [first, last] = [b.fit.pieces[0], b.fit.pieces[b.fit.pieces.length - 1]];
        const fin = first[0] > 0.05 ? 1 : 0.3, fout = Math.abs(last[1] - (p.score?.seconds ?? 0)) < 0.05 ? 0.3 : Math.min(1.5, d / 3);
        f.push(`[${cur}]volume=${b.volume.toFixed(4)},afade=t=in:d=${fin},afade=t=out:st=${r3(d - fout)}:d=${fout},apad=whole_dur=${r3(T)}[mu${i}]`);
      } else {
        const fade = Math.min(b.fade, d / 3);
        const k = addInput("-stream_loop", "-1", "-i", b.file);
        f.push(`[${k}:a]atrim=start=${r3(b.offset)}:duration=${r3(d)},asetpts=PTS-STARTPTS,${toStereo},volume=${b.volume.toFixed(4)}` +
          `${fade > 0 ? `,afade=t=in:d=${r3(fade)},afade=t=out:st=${r3(d - fade)}:d=${r3(fade)}` : ""},adelay=${Math.round(b.a0 * 1000)}:all=1,apad=whole_dur=${r3(T)}[mu${i}]`);
      }
      f.push(`[mu${i}][vsc${i}]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(1)}:attack=15:release=450[md${i}]`);
      if (b.def) use(b.def);
      mix.push(`md${i}`);
      counts.music++;
    });
  }
  const aIn = style.fades ? 0.5 : 0.04, aOut = style.fades ? 1.2 : 0.08;
  const fades = `afade=t=in:d=${aIn},afade=t=out:st=${r3(Math.max(0, T - aOut))}:d=${aOut}`;
  // A safety limiter only. Loudness is set after the render (render.ts): one gain for the whole clip,
  // measured, so quiet moments aren't lifted more than loud ones (an adaptive loudnorm here pumped the
  // hiss up in every pause).
  const master = "alimiter=limit=0.95:level=0";
  if (mix.length) f.push(`[${a}]${mix.map((m) => `[${m}]`).join("")}amix=inputs=${mix.length + 1}:duration=first:dropout_transition=0:normalize=0,${master},${fades}[aout]`);
  else f.push(`[${a}]${master},${fades}[aout]`);

  // ── the command ────────────────────────────────────────────────────
  const graph = f.join(";\n");
  const files: Record<string, string> = {};
  if (ass && assName) files[assName] = ass;
  // Windows caps a command line at 32k characters; long graphs (many parts, tracked crops) go in a file.
  const graphArgs = graph.length > 20000 ? ((files[`${p.name}.graph.txt`] = graph), ["-/filter_complex", `${p.name}.graph.txt`]) : ["-filter_complex", graph.replace(/;\n/g, ";")];
  const outArgs = p.test
    ? ["-t", String(typeof p.test === "number" ? p.test : 0.5), "-f", "null", "-"]
    : ["-c:v", "libx264", "-crf", "20", "-preset", "veryfast", ...BITRATE_CAP, "-r", String(FPS), "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", p.out];
  return {
    args: ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", ...inputs, ...graphArgs, "-map", "[vout]", "-map", "[aout]", ...outArgs],
    duration: T, notes: [...new Set(notes)], used, assets: usedAssets, files, map, counts,
    ...(p.score ? { fit: fit ? fit.how : p.score.seconds ? "looped (the clip runs over twice its length)" : "looped and cut to the clip (its length wasn't measured)" } : {}),
  };
}

// ── what an edit depends on ──────────────────────────────────────────

const LEGACY_TRANSITIONS = new Set(["cut", "crossfade", "dip_black", "slide", "zoom", "whip", "flash", "iris", "blur"]);

/** The effect definitions and asset files an edit uses. `library` is false for edits made before the
 *  effects library (plain camera moves and transitions), whose render fingerprints stay as they were. */
export function editDeps(e: Edit, cat: Catalog, assets: Asset[]): { library: boolean; defs: EffectDef[]; assets: Asset[] } {
  const defs: EffectDef[] = [];
  const files: Asset[] = [];
  const add = (d: EffectDef | undefined, params?: Record<string, unknown>) => {
    if (!d) return;
    if (!defs.includes(d)) defs.push(d);
    for (const [k, spec] of Object.entries(d.params ?? {})) {
      if (spec.type !== "asset" || !params?.[k]) continue;
      const a = findAsset(assets, spec.kinds, String(params[k]));
      if (a && !files.includes(a)) files.push(a);
    }
  };
  for (const s of e.segments) {
    add(findEffect(cat, s.zoom, ["segment"]));
    add(findEffect(cat, s.look, ["segment"]));
    for (const u of s.fx ?? []) add(findEffect(cat, u.fx, ["segment"]), u.params);
  }
  for (const g of e.transitions) {
    const gap = typeof g === "string" ? { fx: g } : g;
    const d = findEffect(cat, gap.fx, ["transition"]);
    add(d, gap.params);
    for (const ar of d?.around ?? []) add(findEffect(cat, ar.fx, TIMELINE_KINDS));
    if (d?.special === "asset_transition") add(findEffect(cat, "overlay", ["asset"]), gap.params);
  }
  for (const u0 of e.fx ?? []) {
    const u = upgradeUse(u0);
    if (u) add(findEffect(cat, u.fx, TIMELINE_KINDS), u.params);
  }
  const library = !!e.fx?.length ||
    e.segments.some((s) => s.fx?.length || s.freeze || s.reverse || (s.speed !== undefined && (s.speed < 0.8 || s.speed > 1.5))) ||
    e.transitions.some((g) => typeof g !== "string" || !LEGACY_TRANSITIONS.has(g));
  return { library, defs, assets: files };
}

// ── captions + title + text effects (ASS) ────────────────────────────

const esc = (s: string) => s.replace(/[{}]/g, "").replace(/\\/g, "");
const bare = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Captions on the edited timeline (karaoke: each word lights up as it's spoken; pop: words appear as
 * they're spoken, the new one popping; box: karaoke on a box; plain), the hook title, and text effects.
 * Null when there's nothing to show.
 */
export function buildAss(e: Edit, map: TimelineMap, segs: Segment[], style: EditStyle, W: number, H: number, extra: string[] = []): string | null {
  const vertical = H > W;
  const scale = vertical ? 1 : 0.75;
  const words = wordsOf(segs);
  const emph = new Set((e.emphasis ?? []).map(bare).filter(Boolean));
  const marginV = style.position === "middle" ? Math.round(H * 0.42) : style.position === "bottom" ? Math.round(H * 0.08) : Math.round(H * 0.24);
  const mode = style.captions;
  const events: string[] = [];
  // Caption events are collected first, then clamped so each ends when the next begins: only one
  // caption line is ever on screen, even across a transition or a caption's short tail.
  const caps: { a: number; b: number; body: string }[] = [];
  if (mode !== "none") {
    e.segments.forEach((s, i) => {
      const part = map.parts[i];
      if (!part || part.reverse) return;
      const speed = part.speed;
      // Captions stop where the next part begins, so two captions never stack during a transition.
      const segEnd = Math.min(part.t0 + (s.end - s.start) / speed, map.parts[i + 1]?.t0 ?? Infinity);
      const at = (t: number) => Math.min(segEnd, part.t0 + (t - s.start) / speed);
      const ws = words.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01);
      for (let k = 0; k < ws.length; k += style.wordsPerCaption) {
        const group = ws.slice(k, k + style.wordsPerCaption);
        const a = at(group[0].start);
        const b = Math.min(segEnd, at(group[group.length - 1].end) + 0.08);
        if (b <= a) continue;
        // Direction is decided on the words themselves, not on the override tags.
        const [open, close] = isRtl(group.map((w) => w.w).join(" ")) ? ["\u202B", "\u202C"] : ["", ""];
        const lit = assColor(style.highlight);
        // litUpTo = index of the word being said (-1 = none yet). Karaoke dims words not yet spoken and
        // lights spoken ones; the current word is also slightly larger, so "which word now" stays readable
        // whatever the highlight colour. Pop hides words until they're spoken and pops each one in.
        const line = (litUpTo: number) =>
          group
            .map((w, j) => {
              const hot = emph.has(bare(w.w));
              const now = j === litUpTo && mode !== "plain";
              if (mode === "pop") {
                const hide = j > litUpTo ? "\\alpha&HFF&" : "";
                const colour = hot ? assColor(style.emphasisColour) : now ? lit : "&H00FFFFFF";
                const pop = now ? `\\fscx${hot ? 132 : 122}\\fscy${hot ? 132 : 122}\\t(0,110,\\fscx${hot ? 112 : 100}\\fscy${hot ? 112 : 100})` : hot ? "\\fscx112\\fscy112" : "";
                return `{\\1c${colour}${hide}${pop}}${esc(w.w)}{\\r}`;
              }
              const colour = hot ? assColor(style.emphasisColour) : j <= litUpTo ? lit : "&H00FFFFFF";
              const alpha = j > litUpTo && !hot ? "\\1a&H80&\\3a&H90&" : "";
              const size = hot || now ? `\\fscx${hot ? 115 : 110}\\fscy${hot ? 115 : 110}` : "";
              return `{\\1c${colour}${alpha}${size}}${esc(w.w)}{\\r}`;
            })
            .join(" ");
        if (mode === "plain") {
          caps.push({ a, b, body: `{\\fad(60,60)}${open}${line(group.length)}${close}` });
          continue;
        }
        // Karaoke without \k: libass sweeps \k/\kf left to right even on RTL lines. Instead, one event
        // per spoken word with identical text and layout, so the highlight follows speech in either direction.
        group.forEach((w, j) => {
          const from = j === 0 ? a : at(w.start);
          const to = j === group.length - 1 ? b : at(group[j + 1].start);
          if (to <= from) return;
          const fade = j === 0 && j === group.length - 1 ? "{\\fad(60,60)}" : j === 0 ? "{\\fad(60,0)}" : j === group.length - 1 ? "{\\fad(0,60)}" : "";
          caps.push({ a: from, b: to, body: `${fade}${open}${line(j)}${close}` });
        });
      }
    });
  }
  caps.sort((x, y) => x.a - y.a);
  const capStyle = mode === "box" ? "CaptionBox" : "Caption";
  caps.forEach((c, k) => {
    const next = caps[k + 1];
    const b = next ? Math.min(c.b, next.a) : c.b;
    if (b - c.a >= 0.02) events.push(`Dialogue: 1,${assTime(c.a)},${assTime(b)},${capStyle},,0,0,0,,${c.body}`);
  });
  if (style.title && e.title) {
    events.push(`Dialogue: 2,${assTime(0)},${assTime(style.titleSeconds)},Title,,0,0,0,,{\\fad(120,260)\\fscx85\\fscy85\\t(0,180,\\fscx100\\fscy100)}${assText(esc(e.title))}`);
  }
  events.push(...extra);
  if (!events.length) return null;

  const font = style.font;
  const cap = Math.round(style.size * scale);
  const titleSize = Math.round(style.size * 1.15 * scale);
  const sc = (n: number) => Math.round(n * scale);
  // Karaoke: PrimaryColour is the spoken colour.
  const primary = mode === "karaoke" || mode === "box" ? assColor(style.highlight) : "&H00FFFFFF";
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${font},${cap},${primary},&H00FFFFFF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,${sc(5)},${sc(2)},2,60,60,${marginV},-1`,
    `Style: CaptionBox,${font},${cap},${primary},&H00FFFFFF,&H50000000,&H00000000,-1,0,0,0,100,100,0,0,3,${sc(14)},0,2,60,60,${marginV},-1`,
    `Style: Title,${font},${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,3,${sc(18)},0,${style.titlePosition === "top" ? 8 : 5},70,70,${Math.round(H * 0.12)},-1`,
    `Style: Big,${font},${sc(120)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${sc(7)},${sc(3)},5,40,40,40,-1`,
    `Style: Banner,${font},${sc(58)},&H00FFFFFF,&H00FFFFFF,&H002F34E3,&H00000000,-1,0,0,0,100,100,0,0,3,${sc(16)},0,8,50,50,40,-1`,
    `Style: Callout,${font},${sc(50)},&H00111111,&H00FFFFFF,&H00FFFFFF,&H00000000,-1,0,0,0,100,100,0,0,3,${sc(12)},0,5,40,40,40,-1`,
    `Style: Shape,${font},20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,4,0,7,0,0,0,-1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
