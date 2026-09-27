// Creative edits. A clip is an edit: parts of the source in any order, a transition at each join, effects
// on each part (camera moves, looks, speed, freeze frames) and on the clip's timeline (text, graphics,
// your GIFs and sounds, generated sounds, voice treatments, music, video effects over a time range),
// plus a hook title and emphasis words. Design plans it from the effects library (effects/); the
// renderer compiles it into one ffmpeg run (effects/compile.ts). This module holds the edit's shape,
// the outline's editing rules (EditStyle) and the default edit Pick starts every clip with.
import type { Segment } from "../lib";
import { readSetting } from "../library";
import { findEffect, loadCatalog, TIMELINE_KINDS } from "../effects/catalog";
import { gapOf, wordsOf } from "../effects/timeline";
import type { FxUse } from "../effects/types";
import type { VisionTranscript } from "./vision";
import type { Framing } from "./framing";

/** The transitions and camera moves an outline allows when it doesn't list its own. */
export const TRANSITIONS = ["cut", "crossfade", "dip_black", "slide", "zoom", "whip", "flash", "iris", "blur"] as const;
export const ZOOMS = ["none", "punch_in", "slow_push", "ken_burns", "zoom_out", "drift"] as const;
export const LOOKS = ["none", "bw", "sepia"] as const;
/** A transition effect's name ("cut", "crossfade", "glitch_cut", any xfade…). */
export type Transition = string;
/** A camera move: a segment effect that moves the crop ("slow_push", "punch_in"…), or "none". */
export type Zoom = string;
export type Look = string;
/** A join: a transition's name, or one with its own length and settings. */
export type Gap = Transition | { fx: Transition; duration?: number; params?: Record<string, unknown> };

export type EditSegment = {
  start: number; end: number; // source seconds
  role?: "hook" | "setup" | "payoff" | "context";
  zoom?: Zoom;
  speed?: number; // 0.25..4 (slow motion below 1)
  reframe_x?: number; // 0..1 centre of the vertical crop; omitted = centred
  look?: Look; // per-part look (a flashback)
  /** More effects on this part, with settings: a camera move here wins over `zoom`; looks add up. */
  fx?: FxUse[];
  /** Hold the part's last frame for this many seconds (a freeze frame). */
  freeze?: number;
  /** Play the part backwards (parts up to 3 seconds). */
  reverse?: boolean;
};
export type Edit = {
  segments: EditSegment[];
  transitions: Gap[]; // length = segments.length - 1
  title?: string;
  emphasis?: string[];
  enabled?: boolean; // false = cut the plain range instead
  /** Effects on the edited clip's timeline. Times are anchors (see effects/types.ts). */
  fx?: FxUse[];
  /** The plan this edit follows, in words (Design's concept). */
  concept?: { name: string; idea: string };
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
  captions: "karaoke" | "pop" | "box" | "plain" | "none";
  font: string;
  size: number;
  position: "lower third" | "bottom" | "middle";
  wordsPerCaption: number;
  highlight: string; // #RRGGBB
  emphasisColour: string;
  title: boolean;
  titleSeconds: number;
  titlePosition: "top" | "middle";
  // Takes made before the effects library don't have these: read them with the defaults in mind.
  /** Timeline effects the outline allows: any (absent), none ([]), or the ones it names. */
  effects?: string[];
  /** Sounds the outline allows: any (absent), none ([]), or the ones it names. */
  sounds?: string[];
  music?: { on: boolean; file?: string; volume: number; mood: string };
  /** How much the planner does: a few well-placed effects, a normal amount, or a dense, busy edit. */
  intensity?: "subtle" | "moderate" | "heavy";
  /** The clip's loudness, mastered in LUFS (short-form platforms play at about -14), or null to leave it. */
  loudness?: number | null;
};

// ── outline → style ────────────────────────────────────────────────

const num = (v: string | undefined, d: number) => {
  const m = v?.match(/[\d.]+/);
  return m ? Number(m[0]) : d;
};
const yes = (v: string | undefined, d: boolean) => (v === undefined ? d : /^\s*(yes|on|true)/i.test(v));
const pickList = <T extends string>(v: string | undefined, all: readonly T[], d: readonly T[]): T[] => {
  if (!v) return [...d];
  const found = all.filter((x) => new RegExp(`(^|[^\\w])${x}($|[^\\w])`, "i").test(v));
  return found.length ? found : [...d];
};
/** none / subtle / strong from a setting like "subtle" or "no". */
const level3 = (v: string | undefined): "none" | "subtle" | "strong" =>
  !v || /^\s*(none|off|no)\b/i.test(v) ? "none" : /strong|heavy/i.test(v) ? "strong" : "subtle";
const hex = (v: string | undefined, d: string) => v?.match(/#[0-9a-f]{6}/i)?.[0] ?? d;
/** A list setting over the library: absent or "any" = everything (undefined), "none" = [], else the names it mentions. */
const palette = (v: string | undefined, names: string[]): string[] | undefined => {
  if (!v || /^\s*(any|all|yes|everything)\b/i.test(v)) return undefined;
  if (/^\s*(none|no|off)\b/i.test(v)) return [];
  const found = names.filter((x) => new RegExp(`(^|[^\\w])${x}($|[^\\w])`, "i").test(v));
  return found.length ? found : undefined;
};

export function readEditStyle(outline: string): EditStyle {
  const s = (label: string) => readSetting(outline, label);
  const cat = loadCatalog();
  const names = (kinds: string[]) => cat.effects.filter((e) => kinds.includes(e.kind)).map((e) => e.name);
  const grade = s("Color grade")?.toLowerCase() ?? "punchy";
  const vig = s("Vignette")?.toLowerCase() ?? "subtle";
  const cap = s("Caption style")?.toLowerCase() ?? "karaoke";
  const trSetting = s("Transitions");
  const allTransitions = names(["transition"]);
  const transitions = /^\s*(any|all)\b/i.test(trSetting ?? "")
    ? allTransitions
    : pickList(trSetting?.replace(/[\w-]+/g, (w) => findEffect(cat, w, ["transition"])?.name ?? w), allTransitions, TRANSITIONS);
  const cameraMoves = cat.effects.filter((e) => e.kind === "segment" && e.cropOnly).map((e) => e.name);
  const zoomSetting = s("Zoom effects") ?? s("Camera moves");
  const fb = s("Flashback look") ?? "";
  const flashback = /sepia/i.test(fb) ? "sepia" : /b(lack)?\s*(&|and)?\s*w(hite)?|bw|mono/i.test(fb) ? "bw" : "none";
  const music = s("Background music");
  const musicFile = music?.match(/`([^`]+)`/)?.[1] ?? music?.match(/[\w-]+\.(mp3|wav|ogg|m4a|flac|aac|opus)/i)?.[0];
  const vol = s("Music volume")?.toLowerCase() ?? "";
  const intensity = (s("Effect intensity") ?? s("Editing intensity") ?? "").toLowerCase();
  return {
    maxSegments: Math.max(1, Math.min(12, num(s("Max segments per clip"), 5))),
    pause: num(s("Remove pauses longer than"), 0.35),
    jumpZoom: yes(s("Jump-cut zoom"), true),
    transitions: transitions.includes("cut") ? transitions : ["cut", ...transitions],
    transitionLength: Math.min(1.5, Math.max(0.1, num(s("Transition length"), 0.25))),
    zooms: ["none", ...(/^\s*(any|all)\b/i.test(zoomSetting ?? "") ? cameraMoves : pickList(zoomSetting, cameraMoves, ["punch_in", "slow_push", "ken_burns"]))],
    kenBurnsPhotos: yes(s("Ken Burns on archive photos"), true),
    reframe: !/off|no|centre|center/i.test(s("Reframe for vertical") ?? "follow"),
    grade: /none|off/.test(grade) ? "none" : /warm/.test(grade) ? "warm" : /cinematic|teal/.test(grade) ? "cinematic" : /nostalg|vintage/.test(grade) ? "nostalgic" : /subtle/.test(grade) ? "subtle" : "punchy",
    vignette: /none|off|no/.test(vig) ? "none" : /strong/.test(vig) ? "strong" : "subtle",
    grain: level3(s("Film grain")),
    glow: level3(s("Glow")),
    letterbox: yes(s("Letterbox bars"), false),
    fades: yes(s("Fade in and out"), false),
    flashback,
    looks: ["none", ...(flashback !== "none" ? [flashback] : [])],
    captions: /none|off/.test(cap) ? "none" : /pop|bounce|one word|single word/.test(cap) ? "pop" : /box|background/.test(cap) ? "box" : /karaoke|word/.test(cap) ? "karaoke" : "plain",
    font: s("Caption font")?.replace(/[`*]/g, "").trim() || "Segoe UI",
    size: num(s("Caption size"), 72),
    position: /middle|centre|center/i.test(s("Caption position") ?? "") ? "middle" : /bottom/i.test(s("Caption position") ?? "") ? "bottom" : "lower third",
    wordsPerCaption: Math.max(1, Math.min(8, num(s("Words per caption"), 4))),
    highlight: hex(s("Highlight colour") ?? s("Highlight color"), "#FFC83D"),
    emphasisColour: hex(s("Emphasis colour") ?? s("Emphasis color"), "#FF5A4F"),
    title: yes(s("Hook title"), true),
    titleSeconds: Math.min(6, Math.max(1, num(s("Title duration"), 2.5))),
    titlePosition: /middle|centre|center/i.test(s("Title position") ?? "") ? "middle" : "top",
    effects: palette(s("Effects") ?? s("Visual effects"), names(TIMELINE_KINDS.filter((k) => k !== "sound" && k !== "music"))),
    sounds: palette(s("Sound effects"), names(["sound"])),
    music: {
      on: !!music && !/^\s*(no|none|off)\b/i.test(music),
      ...(musicFile ? { file: musicFile } : {}),
      volume: /high|loud/.test(vol) ? 0.4 : /medium|normal/.test(vol) ? 0.28 : /\d/.test(vol) && num(vol, 0) > 1 ? Math.min(1, num(vol, 20) / 100) : 0.18,
      mood: (s("Music mood") ?? "").slice(0, 200),
    },
    intensity: /subtle|minimal|light|few/.test(intensity) ? "subtle" : /heavy|dense|busy|maximal|lots/.test(intensity) ? "heavy" : "moderate",
    loudness: /^\s*(off|no|none)/i.test(s("Loudness") ?? "") ? null : -Math.min(30, Math.max(8, Math.abs(num(s("Loudness"), 14)))),
  };
}

// ── helpers over the transcript ───────────────────────────────────

const dominantKind = (vt: VisionTranscript | null, a: number, b: number) => {
  if (!vt) return undefined;
  const tally = new Map<string, number>();
  for (const s of vt.shots) {
    const d = Math.min(b, s.end) - Math.max(a, s.start);
    if (d > 0 && s.kind) tally.set(s.kind, (tally.get(s.kind) ?? 0) + d);
  }
  return [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
};

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
  const lines = e.segments.map((s, i) => {
    const bits = [`${s.start.toFixed(2)}–${s.end.toFixed(2)}s`];
    if (s.role) bits.push(s.role);
    const camera = s.fx?.find((f) => findEffect(loadCatalog(), f.fx, ["segment"])?.cropOnly)?.fx ?? s.zoom;
    if (camera && camera !== "none") bits.push(camera.replace(/_/g, " "));
    for (const f of s.fx ?? []) if (f.fx !== camera) bits.push(f.fx.replace(/_/g, " "));
    if (s.look && s.look !== "none" && !s.fx?.some((f) => f.fx === s.look)) bits.push(s.look);
    if (s.speed && s.speed !== 1) bits.push(`${s.speed}×`);
    if (s.freeze) bits.push(`freeze ${s.freeze}s`);
    if (s.reverse) bits.push("reversed");
    const g = i < e.transitions.length ? gapOf(e.transitions[i]) : null;
    const t = g ? ` → ${g.fx}${g.duration ? ` ${g.duration}s` : ""}` : "";
    return `${i + 1}. ${bits.join(", ")}${t}`;
  });
  if (e.fx?.length) lines.push(`${e.fx.length} effect${e.fx.length === 1 ? "" : "s"} on the timeline: ${[...new Set(e.fx.map((f) => f.fx))].join(", ")}`);
  return lines;
}

// ── rendering helpers ─────────────────────────────────────────────

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

