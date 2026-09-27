// What an effect is. Every effect has a name, a place in the edit, a description the planner reads
// (what it does and when an editor would use it), typed parameters, and a way to render:
//
//   segment    a filter on one part of the source, in source order (camera moves, looks)
//   video      a filter on the edited clip over a time range (shake, glitch, grades, glow…)
//   graphic    a generated picture (lavfi) laid over the clip (colour flashes, glowing borders, bars…)
//   text       ASS subtitle events: animated text and vector shapes (impact text, callouts, arrows…)
//   asset      one of your files from assets/ laid over the clip (GIFs, WebMs with alpha, PNGs)
//   transition how two parts join (every ffmpeg xfade transition, flashes, asset wipes)
//   sound      a generated sound mixed in (whoosh, impact, riser, pop…), or one of your sound files
//   voice      a filter on the clip's own audio over a range (reverb, muffled, telephone, pitch…)
//   music      a music bed from assets/music, ducked under speech
//
// Templates (see template.ts) are data. The few effects that need code (your files: overlays, sound
// files, music, asset transitions) are marked `special` and rendered by compile.ts.
import type { ParamSpec } from "./template";

export type Kind = "segment" | "video" | "graphic" | "text" | "asset" | "transition" | "sound" | "voice" | "music";
/** whole: all of one part; range: from–to; instant: at a moment, for `duration` seconds. */
export type Timing = "whole" | "range" | "instant";

export type EffectDef = {
  name: string;
  kind: Kind;
  timing: Timing;
  description: string;
  tags: string[];
  params?: Record<string, ParamSpec>;
  /** Default length of an instant effect or a transition (seconds). A transition without one uses the outline's transition length. */
  duration?: number;
  /** segment, video, voice: the filter chain. Written as `a,b,c`, or as a graph with [in], [out] and [_local] labels. */
  filter?: string;
  /** The filter to use per value of an enum parameter (e.g. a grade's style). */
  variants?: { param: string; filters: Record<string, string> };
  /** segment: only on shots framed as a crop (a camera move on a split screen trims the people at the sides). */
  cropOnly?: boolean;
  /** graphic: a lavfi source graph making an RGBA picture for `dur` seconds (or a graph ending in [out]);
   *  `static` renders one frame and holds it (much faster for pictures that don't change). */
  graphic?: string;
  static?: boolean;
  /** graphic: where it goes, as overlay expressions (W/H = clip size, w/h = graphic size, t = seconds since
   *  it began) or top/bottom/left/right/center. Default 0,0. */
  x?: string;
  y?: string;
  /** text: ASS Dialogue lines (Layer, Start, End, Style, … Text) with placeholders. */
  ass?: string[];
  /** transition: the ffmpeg xfade transition to use, and effects laid around the cut (centred on it). */
  xfade?: string;
  around?: { fx: string; params?: Record<string, unknown> }[];
  /** sound: a lavfi audio source graph making the sound, `dur` seconds long (or a graph ending in [out]). */
  sound?: string;
  special?: "asset" | "music" | "sfx_file" | "sfx_bed" | "asset_transition";
  /** Where the definition came from: built in, or a file in the workspace's effects/ folder. */
  origin?: "builtin" | "workspace";
};

/** A time on the edited clip. Stored forms: seconds; "start", "end"; "p2" / "p2.end" (a part's start or end);
 *  "cut1" (the join after part 1); "p2@123.45" (source second 123.45 inside part 2, i.e. a spoken word);
 *  each optionally followed by an offset like "+0.3" or "-1". The planner writes "w12" / "w12.end" (the
 *  12th word the viewer hears), which become "p…@…" so they stay on their word when an edge is nudged. */
export type Anchor = number | string;
/** An effect as an edit uses it. Instant effects use `at` (+ `duration`); range effects `from`/`to`. */
export type FxUse = { fx: string; at?: Anchor; from?: Anchor; to?: Anchor; duration?: number; params?: Record<string, unknown> };
