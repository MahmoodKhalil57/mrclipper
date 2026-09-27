// Creative edits. A clip is an edit decision list (EDL): segments of the source in any order, a
// transition between each pair, per-segment effects, a hook title and emphasis words. Whoever plans
// the clip (LLM, Jev, the browser agent) proposes an EDL; this module validates it against the
// outline's editing rules, fills in deterministic defaults, and turns it into an ffmpeg filter graph
// plus an ASS subtitle file (karaoke captions + title card) that the Editor renders.
import type { Segment } from "../lib";
import { readSetting } from "../library";
import type { VisionTranscript } from "./vision";
import { framingFilter, type Framing } from "./framing";

export const TRANSITIONS = ["cut", "crossfade", "dip_black", "slide", "zoom", "whip", "flash", "iris", "blur"] as const;
export const ZOOMS = ["none", "punch_in", "slow_push", "ken_burns", "zoom_out", "drift"] as const;
export const LOOKS = ["none", "bw", "sepia"] as const;
export type Look = (typeof LOOKS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type Zoom = (typeof ZOOMS)[number];

export type EditSegment = {
  start: number; end: number; // source seconds
  role?: "hook" | "setup" | "payoff" | "context";
  zoom?: Zoom;
  speed?: number; // 0.8..1.5
  reframe_x?: number; // 0..1 centre of the vertical crop; omitted = centred
  look?: Look; // per-segment flashback look
};
export type Edit = {
  segments: EditSegment[];
  transitions: Transition[]; // length = segments.length - 1
  title?: string;
  emphasis?: string[];
  enabled?: boolean; // false = cut the plain range instead
};

export type EditStyle = {
  maxSegments: number;
  pause: number; // remove pauses longer than this (seconds); 0 = off
  jumpZoom: boolean;
  transitions: Transition[];
  transitionLength: number;
  zooms: Zoom[];
  kenBurnsPhotos: boolean;
  reframe: boolean;
  grade: "none" | "subtle" | "punchy" | "warm" | "cinematic" | "nostalgic";
  vignette: "none" | "subtle" | "strong";
  grain: "none" | "subtle" | "strong";
  glow: "none" | "subtle" | "strong";
  letterbox: boolean;
  fades: boolean; // fade in from black at the start, out at the end
  flashback: Look; // look for segments the planner marks as flashbacks
  looks: Look[]; // looks the planner may use per segment
  captions: "karaoke" | "plain" | "none";
  font: string;
  size: number;
  position: "lower third" | "bottom" | "middle";
  wordsPerCaption: number;
  highlight: string; // #RRGGBB
  emphasisColour: string;
  title: boolean;
  titleSeconds: number;
  titlePosition: "top" | "middle";
};

// ── outline → style ────────────────────────────────────────────────

const num = (v: string | undefined, d: number) => {
  const m = v?.match(/[\d.]+/);
  return m ? Number(m[0]) : d;
};
const yes = (v: string | undefined, d: boolean) => (v === undefined ? d : /^\s*(yes|on|true)/i.test(v));
const pickList = <T extends string>(v: string | undefined, all: readonly T[], d: readonly T[]): T[] => {
  if (!v) return [...d];
  const found = all.filter((x) => new RegExp(`\\b${x}\\b`, "i").test(v));
  return found.length ? found : [...d];
};
/** none / subtle / strong from a setting like "subtle" or "no". */
const level3 = (v: string | undefined): "none" | "subtle" | "strong" =>
  !v || /^\s*(none|off|no)\b/i.test(v) ? "none" : /strong|heavy/i.test(v) ? "strong" : "subtle";
const hex = (v: string | undefined, d: string) => v?.match(/#[0-9a-f]{6}/i)?.[0] ?? d;

export function readEditStyle(outline: string): EditStyle {
  const s = (label: string) => readSetting(outline, label);
  const grade = s("Color grade")?.toLowerCase() ?? "punchy";
  const vig = s("Vignette")?.toLowerCase() ?? "subtle";
  const cap = s("Caption style")?.toLowerCase() ?? "karaoke";
  const transitions = pickList(s("Transitions"), TRANSITIONS, TRANSITIONS);
  return {
    maxSegments: Math.max(1, Math.min(12, num(s("Max segments per clip"), 5))),
    pause: num(s("Remove pauses longer than"), 0.35),
    jumpZoom: yes(s("Jump-cut zoom"), true),
    transitions: transitions.includes("cut") ? transitions : ["cut", ...transitions],
    transitionLength: Math.min(1, Math.max(0.1, num(s("Transition length"), 0.25))),
    zooms: ["none", ...pickList(s("Zoom effects"), ZOOMS.slice(1), ["punch_in", "slow_push", "ken_burns"])],
    kenBurnsPhotos: yes(s("Ken Burns on archive photos"), true),
    reframe: !/off|no|centre|center/i.test(s("Reframe for vertical") ?? "follow"),
    grade: /none|off/.test(grade) ? "none" : /warm/.test(grade) ? "warm" : /cinematic|teal/.test(grade) ? "cinematic" : /nostalg|vintage/.test(grade) ? "nostalgic" : /subtle/.test(grade) ? "subtle" : "punchy",
    vignette: /none|off|no/.test(vig) ? "none" : /strong/.test(vig) ? "strong" : "subtle",
    grain: level3(s("Film grain")),
    glow: level3(s("Glow")),
    letterbox: yes(s("Letterbox bars"), false),
    fades: yes(s("Fade in and out"), false),
    flashback: /sepia/i.test(s("Flashback look") ?? "") ? "sepia" : /b(lack)?\s*(&|and)?\s*w(hite)?|bw|mono/i.test(s("Flashback look") ?? "") ? "bw" : "none",
    looks: ["none", ...(/sepia/i.test(s("Flashback look") ?? "") ? ["sepia" as const] : []), ...(/b(lack)?\s*(&|and)?\s*w(hite)?|bw|mono/i.test(s("Flashback look") ?? "") ? ["bw" as const] : [])],
    captions: /none|off/.test(cap) ? "none" : /karaoke|word/.test(cap) ? "karaoke" : "plain",
    font: s("Caption font")?.replace(/[`*]/g, "").trim() || "Segoe UI",
    size: num(s("Caption size"), 72),
    position: /middle|centre|center/i.test(s("Caption position") ?? "") ? "middle" : /bottom/i.test(s("Caption position") ?? "") ? "bottom" : "lower third",
    wordsPerCaption: Math.max(1, Math.min(8, num(s("Words per caption"), 4))),
    highlight: hex(s("Highlight colour") ?? s("Highlight color"), "#FFC83D"),
    emphasisColour: hex(s("Emphasis colour") ?? s("Emphasis color"), "#FF5A4F"),
    title: yes(s("Hook title"), true),
    titleSeconds: Math.min(6, Math.max(1, num(s("Title duration"), 2.5))),
    titlePosition: /middle|centre|center/i.test(s("Title position") ?? "") ? "middle" : "top",
  };
}

// ── helpers over the transcript ───────────────────────────────────

type W = { w: string; start: number; end: number };
const wordsOf = (segs: Segment[]): W[] =>
  segs.flatMap((s) => s.words?.length ? s.words : [{ w: s.text, start: s.start, end: s.end }]).sort((a, b) => a.start - b.start);

/** Snap a source range to whole words so no segment starts or ends mid-word. */
function snapToWords(words: W[], start: number, end: number): [number, number] | null {
  const inside = words.filter((w) => w.end > start + 0.05 && w.start < end - 0.05);
  if (!inside.length) return null;
  return [inside[0].start, inside[inside.length - 1].end];
}

const dominantKind = (vt: VisionTranscript | null, a: number, b: number) => {
  if (!vt) return undefined;
  const tally = new Map<string, number>();
  for (const s of vt.shots) {
    const d = Math.min(b, s.end) - Math.max(a, s.start);
    if (d > 0 && s.kind) tally.set(s.kind, (tally.get(s.kind) ?? 0) + d);
  }
  return [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
};

const subjectX = (vt: VisionTranscript | null, a: number, b: number) => {
  if (!vt) return undefined;
  const xs = vt.shots.filter((s) => s.subject_x !== undefined && s.end > a && s.start < b).map((s) => s.subject_x!);
  if (!xs.length) return undefined;
  xs.sort((x, y) => x - y);
  return xs[xs.length >> 1];
};

export const editDuration = (e: Edit, style: Pick<EditStyle, "transitionLength">) =>
  e.segments.reduce((n, s) => n + (s.end - s.start) / (s.speed ?? 1), 0) -
  e.transitions.filter((t) => t !== "cut").length * style.transitionLength;

// ── validation + defaults ─────────────────────────────────────────

/**
 * Make any proposed EDL safe to render: snap to words, clamp effects to what the outline allows,
 * enforce the segment cap, and fill reframing from the vision transcript. Returns null if nothing usable.
 */
export function normalizeEdit(raw: any, segs: Segment[], style: EditStyle, vt: VisionTranscript | null): { edit: Edit; notes: string[] } | null {
  if (!raw || !Array.isArray(raw.segments) || !raw.segments.length) return null;
  const words = wordsOf(segs);
  const notes: string[] = [];
  const out: EditSegment[] = [];
  for (const r of raw.segments.slice(0, style.maxSegments)) {
    const snapped = snapToWords(words, Number(r.start), Number(r.end));
    if (!snapped || snapped[1] - snapped[0] < 0.6) {
      notes.push(`dropped a segment at ${Number(r.start).toFixed(1)}s (no whole words in it)`);
      continue;
    }
    const zoom: Zoom = style.zooms.includes(r.zoom) ? r.zoom : "none";
    if (r.zoom && r.zoom !== zoom) notes.push(`zoom "${r.zoom}" isn't allowed by the outline; using none`);
    const speed = Math.min(1.5, Math.max(0.8, Number(r.speed) || 1));
    out.push({
      start: snapped[0], end: snapped[1],
      role: ["hook", "setup", "payoff", "context"].includes(r.role) ? r.role : undefined,
      zoom, ...(speed !== 1 ? { speed } : {}),
      ...(style.looks.includes(r.look) && r.look !== "none" ? { look: r.look } : r.flashback && style.flashback !== "none" ? { look: style.flashback } : {}),
      // Only an explicit crop centre is stored; otherwise the renderer frames each shot from measured faces.
      ...(style.reframe && r.reframe_x !== undefined ? { reframe_x: Math.min(1, Math.max(0, Number(r.reframe_x))) } : {}),
    });
  }
  if (raw.segments.length > style.maxSegments) notes.push(`kept the first ${style.maxSegments} segments (outline limit)`);
  if (!out.length) return null;
  const transitions: Transition[] = out.slice(1).map((_, i) => {
    const t = raw.transitions?.[i];
    return style.transitions.includes(t) ? t : "cut";
  });
  return {
    edit: {
      segments: out,
      transitions,
      ...(style.title && raw.title ? { title: String(raw.title).slice(0, 80) } : {}),
      emphasis: Array.isArray(raw.emphasis) ? raw.emphasis.map(String).filter(Boolean).slice(0, 8) : [],
    },
    notes,
  };
}

/**
 * The default edit when a planner only gives a range: tighten it by cutting pauses, alternate
 * jump-cut framing, Ken Burns on archive photos, reframe to the subject. Deterministic.
 * minLen: the outline's shortest clip length, which wins over cutting pauses.
 */
export function autoEdit(start: number, end: number, segs: Segment[], style: EditStyle, vt: VisionTranscript | null, title?: string, minLen = 0): Edit {
  const words = wordsOf(segs).filter((w) => w.end > start && w.start < end);
  let pieces: [number, number][] = [];
  for (const w of words) {
    const last = pieces[pieces.length - 1];
    if (last && (style.pause <= 0 || w.start - last[1] <= style.pause)) last[1] = Math.max(last[1], w.end);
    else pieces.push([w.start, w.end]);
  }
  if (!pieces.length) pieces = [[start, end]];
  // The outline's clip length wins over cutting pauses: put the shortest pauses back until it's long enough.
  const edited = () => pieces.reduce((n, [a, b]) => n + b - a, 0);
  while (pieces.length > 1 && edited() < minLen) {
    let k = 0;
    for (let i = 1; i < pieces.length - 1; i++) if (pieces[i + 1][0] - pieces[i][1] < pieces[k + 1][0] - pieces[k][1]) k = i;
    pieces.splice(k, 2, [pieces[k][0], pieces[k + 1][1]]);
  }
  // A sliver (a word or two between long pauses) flashes by, and its transition can be longer than it is:
  // merge it into a neighbour across a short pause, else drop it.
  const sliver = Math.max(1, style.transitionLength * 1.5);
  for (let i = 0; i < pieces.length && pieces.length > 1; ) {
    const [a, b] = pieces[i];
    if (b - a >= sliver) {
      i++;
      continue;
    }
    const before = i > 0 ? a - pieces[i - 1][1] : Infinity;
    const after = i < pieces.length - 1 ? pieces[i + 1][0] - b : Infinity;
    if (Math.min(before, after) <= 3) {
      if (before <= after) pieces[i - 1][1] = b;
      else pieces[i + 1][0] = a;
    }
    pieces.splice(i, 1);
  }
  // Only with jump-cut zoom on: fast talkers leave few pauses, so also cut long pieces at line
  // boundaries, which gives the alternating framing something to alternate on. Otherwise continuous
  // speech stays continuous (framing still changes at every shot cut, handled by the renderer).
  const lineEnds = style.jumpZoom ? segs.map((s) => s.end).filter((t) => t > start && t < end) : [];
  pieces = pieces.flatMap(([a, b]) => {
    const out: [number, number][] = [];
    let from = a;
    for (const t of lineEnds) {
      if (t <= from + 2.5 || t >= b - 1.5) continue;
      if (t - from >= 3.5) {
        out.push([from, t]);
        from = t;
      }
    }
    out.push([from, b]);
    return out;
  });
  // Too many micro-cuts reads as glitchy: merge across the smallest gaps until within ~3x the segment cap.
  while (pieces.length > style.maxSegments * 3) {
    let k = 0;
    for (let i = 1; i < pieces.length - 1; i++) if (pieces[i + 1][0] - pieces[i][1] < pieces[k + 1][0] - pieces[k][1]) k = i;
    pieces.splice(k, 2, [pieces[k][0], pieces[k + 1][1]]);
  }
  // Camera moves from what the outline allows, placed where an editor would put them.
  const can = (z: Zoom) => style.zooms.includes(z);
  // The slow push goes on the longest piece that isn't the final one (that one gets the pull-back).
  const pool = pieces.length > 1 ? pieces.slice(0, -1) : pieces;
  const longest = pool.reduce((k, p, i) => (p[1] - p[0] > pool[k][1] - pool[k][0] ? i : k), 0);
  const wide = (a: number, b: number) => {
    const shots = (vt?.shots ?? []).filter((s) => s.end > a && s.start < b);
    return shots.length > 0 && shots.filter((s) => (s.faces ?? 0) >= 3 || s.framing?.mode === "fit").length >= shots.length / 2;
  };
  const segments: EditSegment[] = pieces.map(([a, b], i) => {
    const last = i === pieces.length - 1 && pieces.length > 1;
    const zoom: Zoom =
      style.kenBurnsPhotos && dominantKind(vt, a, b) === "archival_photo" && can("ken_burns") ? "ken_burns"
        : style.jumpZoom && i % 2 === 1 && can("punch_in") ? "punch_in"
        : last && can("zoom_out") ? "zoom_out"
        : wide(a, b) && can("drift") ? "drift"
        : i === longest && can("slow_push") ? "slow_push"
        : "none";
    return { start: a, end: b, zoom };
  });
  // Transitions: a cut where speech was merely tightened; a soft transition where the story jumps
  // (a real stretch of the video was skipped); a dip to black before the final beat if allowed.
  const soft = (["crossfade", "blur", "dip_black", "slide", "iris", "zoom", "whip", "flash"] as const).find((t) => style.transitions.includes(t));
  const transitions: Transition[] = segments.slice(1).map((s, i) => {
    const gap = s.start - segments[i].end;
    if (i === segments.length - 2 && segments.length >= 3 && style.transitions.includes("dip_black")) return "dip_black";
    return gap > 1.5 && soft ? soft : "cut";
  });
  return { segments, transitions, ...(style.title && title ? { title: title.slice(0, 80) } : {}), emphasis: [] };
}

/** Human-readable summary for clip_script.md and logs. */
export function describeEdit(e: Edit): string[] {
  return e.segments.map((s, i) => {
    const bits = [`${s.start.toFixed(2)}–${s.end.toFixed(2)}s`];
    if (s.role) bits.push(s.role);
    if (s.zoom && s.zoom !== "none") bits.push(s.zoom.replace("_", " "));
    if (s.speed && s.speed !== 1) bits.push(`${s.speed}×`);
    const t = i < e.transitions.length ? ` → ${e.transitions[i]}` : "";
    return `${i + 1}. ${bits.join(", ")}${t}`;
  });
}

// ── rendering ─────────────────────────────────────────────────────

const XFADE: Record<Exclude<Transition, "cut">, string> = {
  crossfade: "fade", dip_black: "fadeblack", slide: "slideleft", zoom: "zoomin", whip: "hlslice",
  flash: "fadewhite", iris: "circleopen", blur: "hblur",
};

/** Where each segment starts on the output timeline (transitions overlap neighbours). */
export function outputStarts(e: Edit, L: number): number[] {
  const starts: number[] = [];
  let t = 0;
  e.segments.forEach((s, i) => {
    starts.push(t);
    t += (s.end - s.start) / (s.speed ?? 1);
    if (i < e.transitions.length && e.transitions[i] !== "cut") t -= L;
  });
  return starts;
}

/**
 * ffmpeg arguments for an EDL: one input per segment (fast, frame-accurate seek), per-segment
 * speed/reframe/zoom/grade, then transitions chained with xfade/acrossfade or concat.
 */
/**
 * A segment split at the vision transcript's shot cuts, each part carrying that shot's framing.
 * Slivers under half a second merge into a neighbour; neighbours with the same framing merge too.
 */
export function framingParts(vt: VisionTranscript | null, start: number, end: number) {
  const centre: Framing = { mode: "crop", cx: 0.5, measured: false };
  const shots = (vt?.shots ?? []).filter((s) => s.end > start && s.start < end);
  let parts = shots.length
    ? shots.map((s) => ({ start: Math.max(start, s.start), end: Math.min(end, s.end), framing: s.framing ?? centre }))
    : [{ start, end, framing: centre }];
  parts[0].start = start;
  parts[parts.length - 1].end = end;
  const same = (a: Framing, b: Framing) =>
    a.mode === b.mode && (a.mode !== "crop" || Math.abs(a.cx - (b as any).cx) < 0.03) &&
    (a.mode !== "split" || a.people.every((p, i) => Math.abs(p.cx - (b as any).people[i].cx) < 0.03));
  const merged: typeof parts = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if (last && (p.end - p.start < 0.5 || same(last.framing, p.framing))) last.end = p.end;
    else if (last && last.end - last.start < 0.5) merged[merged.length - 1] = { ...p, start: last.start };
    else merged.push({ ...p });
  }
  return merged;
}

export function buildRender(
  e: Edit, style: EditStyle, video: string, vertical: boolean, assFile: string | null, out: string,
  vt: VisionTranscript | null = null, aspect = 16 / 9,
  /** Face-tracked framing parts per segment (track.ts). Falls back to the shot-level framing. */
  tracked?: Record<number, { start: number; end: number; framing: Framing }[]>,
) {
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const L = style.transitionLength;
  const inputs: string[] = [];
  const f: string[] = [];
  const GRADES: Record<EditStyle["grade"], string> = {
    none: "",
    subtle: ",eq=contrast=1.04:saturation=1.08",
    punchy: ",eq=contrast=1.08:saturation=1.18:brightness=0.01",
    warm: ",colorbalance=rs=0.05:gs=0.01:bs=-0.06:rm=0.04:bm=-0.05:rh=0.03:bh=-0.03,eq=contrast=1.05:saturation=1.1:gamma=1.02",
    cinematic: ",colorbalance=rs=-0.06:bs=0.07:rh=0.07:gh=0.02:bh=-0.07,eq=contrast=1.1:saturation=1.05",
    // Faded film: lifted blacks, softened highlights, less saturation, a touch of warmth.
    // (ffmpeg's curves=preset=vintage casts everything magenta, which read as a broken filter.)
    nostalgic: ",curves=all='0/0.07 0.5/0.5 1/0.94',eq=saturation=0.78:gamma=1.02,colorbalance=rs=0.04:gs=0.015:bs=-0.04:rm=0.03:bm=-0.03",
  };
  const grade = GRADES[style.grade] ?? "";
  const LOOK: Record<Look, string> = {
    none: "",
    bw: ",hue=s=0,eq=contrast=1.1",
    sepia: ",colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
  };
  const vig = style.vignette === "strong" ? ",vignette=PI/4" : style.vignette === "subtle" ? ",vignette=PI/6" : "";

  let nInputs = 0;
  const addInput = (start: number, dur: number) => {
    inputs.push("-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", video);
    return nInputs++;
  };
  const zoomFor = (z: Zoom | undefined, frames: number): string => {
    switch (z) {
      case "punch_in":
        return `scale=${Math.round(W * 1.12 / 2) * 2}:${Math.round(H * 1.12 / 2) * 2},crop=${W}:${H}`;
      case "slow_push":
        return `scale=${W * 2}:${H * 2},zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30`;
      case "ken_burns":
        return `scale=${W * 2}:${H * 2},zoompan=z='1.04+0.14*on/${frames}':x='(iw-iw/zoom)*(0.2+0.6*on/${frames})':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=30`;
      case "zoom_out":
        return `scale=${W * 2}:${H * 2},zoompan=z='max(1.14-0.14*on/${frames},1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30`;
      case "drift":
        return `scale=${W * 2}:${H * 2},zoompan=z='1.08':x='(iw-iw/zoom)*(0.35+0.3*on/${frames})':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=30`;
      default:
        return `scale=${W}:${H}`;
    }
  };

  e.segments.forEach((s, i) => {
    const dur = s.end - s.start;
    const speed = s.speed ?? 1;
    const outDur = dur / speed;
    // Vertical output: split the segment at shot cuts so each shot gets its own measured framing
    // (crop on the faces, split screen, or fit), tracked over time when faces move. Measured faces
    // win over a planner's reframe_x, which only steers shots where nothing was measured.
    const parts: { start: number; end: number; framing: Framing }[] = !vertical
      ? [{ start: s.start, end: s.end, framing: { mode: "crop", cx: 0.5, measured: false } }]
      : !style.reframe
        ? [{ start: s.start, end: s.end, framing: { mode: "crop", cx: s.reframe_x ?? 0.5, measured: s.reframe_x !== undefined } }]
        : (tracked?.[i] ?? framingParts(vt, s.start, s.end)).map((p) =>
            p.framing.mode === "crop" && !p.framing.measured && s.reframe_x !== undefined
              ? { ...p, framing: { mode: "crop" as const, cx: s.reframe_x, measured: true } }
              : p,
          );
    const labels = parts.map((pt, k) => {
      const idx = addInput(pt.start, pt.end - pt.start);
      const frames = Math.max(1, Math.round(((pt.end - pt.start) / speed) * 30));
      const frame = vertical ? framingFilter(pt.framing, W, H, `f${i}x${k}`, aspect, speed) : "null";
      // Zooming a split screen or a fitted group trims the people at the sides; only crops move.
      const zoom = !vertical || pt.framing.mode === "crop" ? zoomFor(s.zoom, frames) : `scale=${W}:${H}`;
      // settb: xfade needs both inputs on the same timebase, and zoompan/concat change it.
      f.push(`[${idx}:v]setpts=(PTS-STARTPTS)/${speed},fps=30,${frame},${zoom}${grade}${LOOK[s.look ?? "none"]},setsar=1,format=yuv420p,settb=1/30[p${i}x${k}]`);
      return `p${i}x${k}`;
    });
    f.push(labels.length === 1 ? `[${labels[0]}]null[v${i}]` : `${labels.map((l) => `[${l}]`).join("")}concat=n=${labels.length}:v=1:a=0,settb=1/30[v${i}]`);
    // Audio comes from one continuous read of the segment, so shot-level splits never click.
    const ai = addInput(s.start, dur);
    const tempo = speed !== 1 ? `,atempo=${speed.toFixed(3)}` : "";
    f.push(`[${ai}:a]asetpts=PTS-STARTPTS${tempo},aresample=48000,aformat=channel_layouts=stereo,apad=whole_dur=${outDur.toFixed(3)},atrim=0:${outDur.toFixed(3)}[a${i}]`);
  });

  // Chain the segments.
  let v = "v0", a = "a0";
  let t = (e.segments[0].end - e.segments[0].start) / (e.segments[0].speed ?? 1);
  for (let i = 1; i < e.segments.length; i++) {
    const tr = e.transitions[i - 1] ?? "cut";
    const d = (e.segments[i].end - e.segments[i].start) / (e.segments[i].speed ?? 1);
    const nv = `vx${i}`, na = `ax${i}`;
    if (tr === "cut") {
      f.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${nv}c][${na}]`, `[${nv}c]settb=1/30[${nv}]`);
      t += d;
    } else {
      const len = Math.min(L, t * 0.4, d * 0.4);
      f.push(`[${v}][v${i}]xfade=transition=${XFADE[tr]}:duration=${len.toFixed(3)}:offset=${(t - len).toFixed(3)}[${nv}]`);
      f.push(`[${a}][a${i}]acrossfade=d=${len.toFixed(3)}[${na}]`);
      t += d - len;
    }
    v = nv;
    a = na;
  }
  // Finishing: glow (screen-blended blur), vignette, grain, letterbox bars, fades, then captions on top.
  let fin = v;
  if (style.glow !== "none") {
    const op = style.glow === "strong" ? 0.35 : 0.2;
    f.push(`[${fin}]split[g0][g1]`, `[g1]gblur=sigma=${vertical ? 28 : 22}[g2]`, `[g0][g2]blend=all_mode=screen:all_opacity=${op}[glow]`);
    fin = "glow";
  }
  const post: string[] = [];
  if (vig) post.push(vig.slice(1));
  if (style.grain !== "none") post.push(`noise=alls=${style.grain === "strong" ? 14 : 7}:allf=t`);
  if (style.letterbox) {
    const bar = Math.round(H * (vertical ? 0.06 : 0.1));
    post.push(`drawbox=x=0:y=0:w=iw:h=${bar}:color=black:t=fill`, `drawbox=x=0:y=ih-${bar}:w=iw:h=${bar}:color=black:t=fill`);
  }
  const fadeIn = style.fades ? 0.6 : 0, fadeOut = style.fades ? 0.9 : 0;
  if (style.fades) post.push(`fade=t=in:d=${fadeIn}`, `fade=t=out:st=${Math.max(0, t - fadeOut).toFixed(3)}:d=${fadeOut}`);
  if (assFile) post.push(`ass=${assFile}`);
  f.push(`[${fin}]${post.length ? post.join(",") : "null"}[vout]`);
  const aIn = style.fades ? 0.5 : 0.04, aOut = style.fades ? 1.2 : 0.08;
  f.push(`[${a}]afade=t=in:d=${aIn},afade=t=out:st=${Math.max(0, t - aOut).toFixed(3)}:d=${aOut}[aout]`);

  return {
    duration: t,
    args: [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats",
      ...inputs,
      "-filter_complex", f.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-r", "30",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    ],
  };
}

// ── captions + title (ASS) ────────────────────────────────────────

/** #RRGGBB → ASS &HAABBGGRR */
const assColor = (hexColor: string, alpha = 0) =>
  `&H${alpha.toString(16).padStart(2, "0")}${hexColor.slice(5, 7)}${hexColor.slice(3, 5)}${hexColor.slice(1, 3)}`.toUpperCase();

const assTime = (t: number) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
const esc = (s: string) => s.replace(/[{}]/g, "").replace(/\\/g, "");
const bare = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Right-to-left lines need an RTL paragraph direction, or libass lays them out left-to-right and
 * numbers, periods, commas and embedded English land in the wrong place. Wrap lines whose first
 * strong letter is Arabic in RLE…PDF (and styles use Encoding -1, libass's auto base direction).
 */
export function isRtl(text: string): boolean {
  const first = text.match(/\p{L}/u)?.[0] ?? "";
  return /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(first);
}
export const rtl = (text: string) => (isRtl(text) ? `‫${text}‬` : text);

/**
 * Karaoke captions (each word lights up as it's spoken, emphasis words in their own colour and
 * slightly bigger) and the hook title, all on the edited output timeline.
 */
export function buildAss(e: Edit, segs: Segment[], style: EditStyle, vertical: boolean): string {
  const [W, H] = vertical ? [1080, 1920] : [1920, 1080];
  const scale = vertical ? 1 : 0.75;
  const words = wordsOf(segs);
  const starts = outputStarts(e, style.transitionLength);
  const emph = new Set((e.emphasis ?? []).map(bare).filter(Boolean));
  const marginV = style.position === "middle" ? Math.round(H * 0.42) : style.position === "bottom" ? Math.round(H * 0.08) : Math.round(H * 0.24);

  const events: string[] = [];
  // Caption events are collected first, then clamped so each ends when the next begins: only one
  // caption line is ever on screen, even across a transition or a caption's short tail.
  const caps: { a: number; b: number; body: string }[] = [];
  if (style.captions !== "none") {
    e.segments.forEach((s, i) => {
      const speed = s.speed ?? 1;
      // Captions stop where the next segment begins, so two captions never stack during a transition.
      const segEnd = Math.min(starts[i] + (s.end - s.start) / speed, starts[i + 1] ?? Infinity);
      const map = (t: number) => Math.min(segEnd, starts[i] + (t - s.start) / speed);
      const ws = words.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01);
      for (let k = 0; k < ws.length; k += style.wordsPerCaption) {
        const group = ws.slice(k, k + style.wordsPerCaption);
        const a = map(group[0].start);
        const b = Math.min(segEnd, map(group[group.length - 1].end) + 0.08);
        if (b <= a) continue;
        // Direction is decided on the words themselves, not on the override tags.
        const [open, close] = isRtl(group.map((w) => w.w).join(" ")) ? ["‫", "‬"] : ["", ""];
        const lit = assColor(style.highlight);
        // litUpTo = index of the word being said (-1 = none yet). Not-yet-spoken words are dimmed
        // (semi-transparent), spoken ones take the highlight colour, and the current word is also
        // slightly larger, so "which word now" stays readable whatever the highlight colour is.
        const line = (litUpTo: number) =>
          group
            .map((w, j) => {
              const hot = emph.has(bare(w.w));
              const now = j === litUpTo && style.captions === "karaoke";
              const colour = hot ? assColor(style.emphasisColour) : j <= litUpTo ? lit : "&H00FFFFFF";
              const alpha = j > litUpTo && !hot ? "\\1a&H80&\\3a&H90&" : "";
              const size = hot || now ? `\\fscx${hot ? 115 : 110}\\fscy${hot ? 115 : 110}` : "";
              return `{\\1c${colour}${alpha}${size}}${esc(w.w)}{\\r}`;
            })
            .join(" ");
        if (style.captions !== "karaoke") {
          caps.push({ a, b, body: `{\\fad(60,60)}${open}${line(group.length)}${close}` });
          continue;
        }
        // Karaoke without \k: libass sweeps \k/\kf left to right even on RTL lines. Instead, one event
        // per spoken word with identical text and layout, so the highlight follows speech in either direction.
        group.forEach((w, j) => {
          const from = j === 0 ? a : map(w.start);
          const to = j === group.length - 1 ? b : map(group[j + 1].start);
          if (to <= from) return;
          const fade = j === 0 && j === group.length - 1 ? "{\\fad(60,60)}" : j === 0 ? "{\\fad(60,0)}" : j === group.length - 1 ? "{\\fad(0,60)}" : "";
          caps.push({ a: from, b: to, body: `${fade}${open}${line(j)}${close}` });
        });
      }
    });
  }
  caps.sort((x, y) => x.a - y.a);
  caps.forEach((c, k) => {
    const next = caps[k + 1];
    const b = next ? Math.min(c.b, next.a) : c.b;
    if (b - c.a >= 0.02) events.push(`Dialogue: 1,${assTime(c.a)},${assTime(b)},Caption,,0,0,0,,${c.body}`);
  });
  if (style.title && e.title) {
    events.push(
      `Dialogue: 2,${assTime(0)},${assTime(style.titleSeconds)},Title,,0,0,0,,{\\fad(120,260)\\fscx85\\fscy85\\t(0,180,\\fscx100\\fscy100)}${rtl(esc(e.title))}`,
    );
  }

  const font = style.font;
  const cap = Math.round(style.size * scale);
  const titleSize = Math.round(style.size * 1.15 * scale);
  // Karaoke: SecondaryColour is the not-yet-spoken colour, PrimaryColour the spoken one.
  const primary = style.captions === "karaoke" ? assColor(style.highlight) : "&H00FFFFFF";
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
    `Style: Caption,${font},${cap},${primary},&H00FFFFFF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,${Math.round(5 * scale)},${Math.round(2 * scale)},2,60,60,${marginV},-1`,
    `Style: Title,${font},${titleSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,3,${Math.round(18 * scale)},0,${style.titlePosition === "top" ? 8 : 5},70,70,${Math.round(H * 0.12)},-1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
