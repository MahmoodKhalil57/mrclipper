// The edited clip's timeline: where each part, each join and each spoken word lands in the finished clip,
// and the anchors effects are placed with. Word anchors are stored by source time inside their part
// ("p2@123.45"), so an effect stays on its word when you nudge the clip's edges in Review.
import type { Segment } from "../lib";
import type { Edit, EditStyle, Gap } from "../agents/edit";
import { findEffect, TIMELINE_KINDS, type Catalog } from "./catalog";
import { findAsset, type Asset } from "./assets";
import { resolveParams } from "./template";
import type { Anchor, EffectDef, FxUse } from "./types";

export type TWord = { n: number; w: string; start: number; end: number; t: number; tEnd: number; part: number };
export type TPart = { k: number; t0: number; t1: number; src0: number; src1: number; speed: number; freeze: number; reverse: boolean };
/** A join after part k: `overlap` seconds of crossfade (0 for a cut) ending at `t`; effects around it last `len`. */
export type TJoin = { k: number; name: string; def?: EffectDef; overlap: number; len: number; start: number; t: number; params?: Record<string, unknown> };
export type TimelineMap = { duration: number; parts: TPart[]; joins: TJoin[]; words: TWord[] };

export const MAX_SPEED = 4, MIN_SPEED = 0.25, MAX_FREEZE = 3, MAX_REVERSE = 3;

/** A join as written in an edit: a transition's name, or one with its own length and settings. */
export const gapOf = (g: Gap | undefined): { fx: string; duration?: number; params?: Record<string, unknown> } =>
  !g ? { fx: "cut" } : typeof g === "string" ? { fx: g } : { fx: String(g.fx ?? "cut"), ...(g.duration ? { duration: g.duration } : {}), ...(g.params ? { params: g.params } : {}) };

/** Seconds a part plays for, freeze frame included. */
export const partSeconds = (s: Edit["segments"][number]) => (s.end - s.start) / (s.speed ?? 1) + Math.min(MAX_FREEZE, s.freeze ?? 0);

type W = { w: string; start: number; end: number };
export const wordsOf = (segs: Segment[]): W[] =>
  segs.flatMap((s) => (s.words?.length ? s.words : [{ w: s.text, start: s.start, end: s.end }])).sort((a, b) => a.start - b.start);

/**
 * Lay the edit out on the output timeline. Transition overlaps follow the renderer: a join lasts its
 * own duration, else the outline's transition length, but never more than 40% of either side.
 */
export function layout(e: Edit, style: Pick<EditStyle, "transitionLength">, cat: Catalog, segs: Segment[] = []): TimelineMap {
  const parts: TPart[] = [];
  const joins: TJoin[] = [];
  let t = 0;
  e.segments.forEach((s, i) => {
    const d = partSeconds(s);
    if (i > 0) {
      const g = gapOf(e.transitions[i - 1]);
      const def = findEffect(cat, g.fx, ["transition"]);
      const want = Math.max(0.05, Math.min(3, g.duration ?? def?.duration ?? style.transitionLength));
      const len = Math.min(want, t * 0.4, d * 0.4);
      const overlap = def?.xfade && def.special !== "asset_transition" ? len : 0;
      joins.push({ k: i, name: def?.name ?? "cut", def, overlap, len: def?.name === "cut" || !def ? 0 : len, start: overlap ? t - overlap : t, t, ...(g.params ? { params: g.params } : {}) });
      t -= overlap;
    }
    parts.push({ k: i + 1, t0: t, t1: t + d, src0: s.start, src1: s.end, speed: s.speed ?? 1, freeze: Math.min(MAX_FREEZE, s.freeze ?? 0), reverse: !!s.reverse });
    t += d;
  });
  // Words the viewer hears, in play order (a reversed part says nothing intelligible).
  const all = wordsOf(segs);
  const words: TWord[] = [];
  for (const p of parts) {
    if (p.reverse) continue;
    for (const w of all) {
      if (w.start < p.src0 - 0.01 || w.end > p.src1 + 0.01) continue;
      words.push({ n: words.length + 1, w: w.w, start: w.start, end: w.end, t: p.t0 + (w.start - p.src0) / p.speed, tEnd: p.t0 + (w.end - p.src0) / p.speed, part: p.k });
    }
  }
  return { duration: t, parts, joins, words };
}

// ── anchors ────────────────────────────────────────────────────────────

const ANCHOR = /^\s*(start|end|p(\d+)(?:@(\d+(?:\.\d+)?))?(\.end|\.start)?|cut(\d+)|w(\d+)(\.end|\.start)?|(\d+(?:\.\d+)?)s?)\s*(?:([+-])\s*(\d+(?:\.\d+)?)s?)?\s*$/i;
/** "0:12.5" or "1:02" (minutes and seconds on the clip), which planners write too. */
const CLOCK = /^\s*(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/;
const clock = (a: string) => {
  const m = a.match(CLOCK);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Seconds on the output timeline, or null when the anchor doesn't point anywhere in this edit. */
export function resolveAnchor(a: Anchor | undefined, map: TimelineMap): number | null {
  if (a === undefined || a === null || a === "") return null;
  if (typeof a === "number") return Number.isFinite(a) ? a : null;
  const c = clock(String(a));
  if (c !== null) return c;
  const m = String(a).match(ANCHOR);
  if (!m) return null;
  const off = m[9] ? (m[9] === "-" ? -1 : 1) * Number(m[10]) : 0;
  let t: number | null = null;
  const head = m[1].toLowerCase();
  if (head === "start") t = 0;
  else if (head === "end") t = map.duration;
  else if (m[2]) {
    const p = map.parts[Number(m[2]) - 1];
    if (!p) return null;
    if (m[3]) {
      const src = Number(m[3]);
      if (src < p.src0 - 0.05 || src > p.src1 + 0.05) return null; // the word was trimmed away
      t = p.t0 + (Math.min(p.src1, Math.max(p.src0, src)) - p.src0) / p.speed;
    } else t = m[4]?.toLowerCase() === ".end" ? p.t1 : p.t0;
  } else if (m[5]) {
    const j = map.joins[Number(m[5]) - 1];
    if (!j) return null;
    t = j.t - j.overlap / 2;
  } else if (m[6]) {
    const w = map.words[Number(m[6]) - 1];
    if (!w) return null;
    t = m[7]?.toLowerCase() === ".end" ? w.tEnd : w.t;
  } else t = Number(m[8]);
  return t === null ? null : t + off;
}

/** An anchor as stored: word numbers become their part and source time, so they follow their word. */
export function storeAnchor(a: Anchor | undefined, map: TimelineMap): Anchor | undefined {
  if (a === undefined || a === null || a === "") return undefined;
  if (typeof a === "number") return Number.isFinite(a) ? +a.toFixed(3) : undefined;
  const c = clock(String(a));
  if (c !== null) return +c.toFixed(3);
  const m = String(a).match(ANCHOR);
  if (!m) return undefined;
  if (!m[6]) return String(a).replace(/\s+/g, "").replace(/\.start/i, "");
  const w = map.words[Number(m[6]) - 1];
  if (!w) return undefined;
  const off = m[9] ? `${m[9]}${Number(m[10])}` : "";
  return `p${w.part}@${(m[7]?.toLowerCase() === ".end" ? w.end : w.start).toFixed(3)}${off}`;
}

/** When an effect plays: [from, to] in output seconds, clamped to the clip, or null. */
export function spanOf(use: FxUse, def: EffectDef, map: TimelineMap): [number, number] | null {
  const T = map.duration;
  let a: number | null, b: number | null;
  if (def.timing === "instant") {
    a = resolveAnchor(use.at ?? use.from, map);
    const d = Math.max(0.05, Math.min(10, Number(use.duration) || def.duration || 0.5));
    b = a === null ? null : a + d;
  } else {
    a = use.from === undefined ? 0 : resolveAnchor(use.from, map);
    b = use.to === undefined ? T : resolveAnchor(use.to, map);
  }
  if (a === null || b === null) return null;
  a = Math.max(0, a);
  b = Math.min(T, b);
  return b - a >= 0.04 ? [a, b] : null;
}

// ── sounds that used to be synthesized ────────────────────────────────

/** Sounds the library used to synthesize, and the recorded sound each became. Edits made with them still
 *  play (the recorded one), and a planner that names one gets the recorded one too. */
const RECORDED: Record<string, { file: string; bed?: boolean }> = {
  whoosh: { file: "whoosh_fast" }, swoosh: { file: "swoosh" }, reverse_whoosh: { file: "reverse_cymbal" }, impact: { file: "impact" },
  boom: { file: "boom" }, bass_hit: { file: "bass_drop" }, riser: { file: "riser" }, pop: { file: "pop" }, click: { file: "click" },
  shutter: { file: "camera_shutter" }, ding: { file: "ding" }, sparkle: { file: "sparkle" }, glitch_noise: { file: "glitch" },
  heartbeat: { file: "heartbeat" }, typing: { file: "typing", bed: true },
};
/** No stand-in: the drone was a pad (music does that now), and the crackle beds were the static heard under
 *  whole clips, so edits made with them don't get recorded crackle instead. */
const DROPPED = new Set(["sad_drone", "vinyl", "crackle", "record_crackle"]);

/** A use of a sound that's no longer synthesized, as the recorded sound it became: a range of a bed loops
 *  quietly (ambience), anything else plays once (sfx). Null for sounds that have no recorded stand-in. */
export function upgradeUse<T extends { fx?: unknown }>(u: T): T | null {
  const name = String(u?.fx ?? "").trim().toLowerCase();
  if (DROPPED.has(name)) return null;
  const r = RECORDED[name];
  if (!r) return u;
  const x = u as any;
  const range = x.from !== undefined && x.to !== undefined;
  const fx = r.bed && range ? "ambience" : "sfx";
  const params = { ...(x.params ?? {}), file: r.file };
  return { ...x, fx, params, ...(fx === "sfx" && x.at === undefined ? { at: x.from } : {}), ...(fx === "sfx" ? { from: undefined, to: undefined } : {}) };
}

// ── checking what a planner wrote ──────────────────────────────────────

const RESERVED = new Set(["fx", "at", "from", "to", "duration", "params", "why"]);

/** One effect use from a planner or a person → a clean use (known effect, valid params and anchors), or why not. */
export function checkUse(raw: any, kinds: EffectDef["kind"][], cat: Catalog, assets: Asset[], map: TimelineMap | null): { use?: FxUse; def?: EffectDef; note?: string } {
  if (raw && typeof raw === "object" && kinds.includes("sound")) {
    const was = String(raw.fx ?? raw.effect ?? raw.name ?? "");
    raw = upgradeUse({ ...raw, fx: raw.fx ?? raw.effect ?? raw.name });
    if (!raw) return { note: `${was} was a synthesized sound with no recorded stand-in, so it was left out` };
  }
  let name = typeof raw === "string" ? raw : raw?.fx ?? raw?.effect ?? raw?.name;
  let def = findEffect(cat, name, kinds);
  // One of your files named as if it were an effect ("soft_whoosh"): play or show that file.
  if (!def && kinds.includes("sound")) {
    const bare = String(name ?? "").replace(/[_-]?(sfx|sound|music|overlay|gif|file)$/i, "");
    const a = findAsset(assets, ["sfx", "music", "overlay", "image"], bare) ?? findAsset(assets, ["sfx", "music", "overlay", "image"], String(name ?? ""));
    if (a) {
      const as = a.kind === "sfx" ? "sfx" : a.kind === "music" ? "music" : "overlay";
      def = findEffect(cat, as, kinds);
      if (def) (raw = { ...(typeof raw === "object" ? raw : {}), fx: as, file: a.name }), (name = as);
    }
  }
  if (!def) return { note: `"${name}" isn't an effect${kinds.length === 1 ? ` of kind ${kinds[0]}` : ""}` };
  const given: Record<string, unknown> = { ...(raw?.params ?? {}) };
  if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k) && !(k in given) && k !== "effect" && k !== "name") given[k] = v;
  const { values, notes, missing } = resolveParams(def.params, given, (ks, n) => findAsset(assets, ks, n)?.name ?? null);
  const needs = missing.filter((k) => def.params?.[k]?.type === "asset" || (def.params?.[k]?.type === "text" && !def.params[k].default));
  if (needs.length) return { note: `${def.name}: ${notes[0] ?? `needs ${needs.join(", ")}`}` };
  // Keep only what differs from the defaults, so edits stay readable.
  const params = Object.fromEntries(Object.entries(values).filter(([k, v]) => {
    const s = def.params![k];
    return !("default" in s) || s.default !== v;
  }));
  const use: FxUse = { fx: def.name, ...(Object.keys(params).length ? { params } : {}) };
  if (def.kind !== "segment" && def.kind !== "transition") {
    if (!map) return { use, def };
    if (def.timing === "instant") {
      const at = storeAnchor(raw?.at ?? raw?.from, map);
      if (at === undefined) return { note: `${def.name}: "at" ${JSON.stringify(raw?.at ?? raw?.from)} isn't a moment in this clip` };
      use.at = at;
      const d = Number(raw?.duration);
      if (d > 0) use.duration = +Math.min(10, Math.max(0.05, d)).toFixed(2);
    } else {
      // A picture, text or voice effect over the whole clip is rarely meant (a blur over everything): it needs
      // its times. Sounds and music may run the whole clip.
      if (raw?.from === undefined && raw?.to === undefined && !["sound", "music"].includes(def.kind)) return { note: `${def.name}: no "from"/"to" given, so it was left out rather than run over the whole clip` };
      const from = raw?.from === undefined ? undefined : storeAnchor(raw.from, map);
      const to = raw?.to === undefined ? undefined : storeAnchor(raw.to, map);
      if ((raw?.from !== undefined && from === undefined) || (raw?.to !== undefined && to === undefined)) return { note: `${def.name}: "from"/"to" aren't moments in this clip` };
      if (from !== undefined) use.from = from;
      if (to !== undefined) use.to = to;
    }
    const span = spanOf(use, def, map);
    if (!span) return { note: `${def.name}: its time range is empty or outside the clip` };
    if (def.timing === "range" && span[1] - span[0] < 0.2) return { note: `${def.name}: ${(span[1] - span[0]).toFixed(2)}s is too short to notice` };
  }
  return { use, def };
}

/** Timeline effects by name, for the kinds that go on the clip's timeline. */
export const timelineKinds = TIMELINE_KINDS;

// ── the timeline for the canvas ────────────────────────────────────────

export type TimelineView = {
  duration: number;
  parts: { t0: number; t1: number }[];
  joins: { t: number; overlap: number; name: string }[];
  fx: { fx: string; kind: EffectDef["kind"]; t0: number; t1: number; label?: string }[];
};

/** Where everything in an edit plays, for drawing it. Stored anchors don't need the transcript. */
export function timelineView(e: Edit, style: Pick<EditStyle, "transitionLength">, cat: Catalog): TimelineView {
  const map = layout(e, style, cat);
  const fx: TimelineView["fx"] = [];
  for (const u0 of e.fx ?? []) {
    const u = upgradeUse(u0);
    const def = u ? findEffect(cat, u.fx, TIMELINE_KINDS) : undefined;
    const span = u && def ? spanOf(u, def, map) : null;
    if (!u || !def || !span) continue;
    const p = u.params ?? {};
    const label = typeof p.text === "string" ? p.text : typeof p.file === "string" ? p.file : typeof p.style === "string" ? p.style : undefined;
    fx.push({ fx: def.name, kind: def.kind, t0: +span[0].toFixed(2), t1: +span[1].toFixed(2), ...(label ? { label } : {}) });
  }
  return {
    duration: +map.duration.toFixed(2),
    parts: map.parts.map((p) => ({ t0: +p.t0.toFixed(2), t1: +p.t1.toFixed(2) })),
    joins: map.joins.map((j) => ({ t: +j.t.toFixed(2), overlap: +j.overlap.toFixed(2), name: j.name })),
    fx,
  };
}

// ── describing an edit ─────────────────────────────────────────────────

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
const paramsText = (p?: Record<string, unknown>) => (p && Object.keys(p).length ? ` (${Object.entries(p).map(([k, v]) => `${k} ${typeof v === "string" ? `"${v}"` : v}`).join(", ")})` : "");

/** The timeline effects as short lines ("0:04.2 zoom_punch", "0:10.0-0:14.5 riser"), in time order. */
export function describeTimeline(e: Edit, map: TimelineMap, cat: Catalog): string[] {
  return (e.fx ?? [])
    .map((u0) => {
      const u = upgradeUse(u0);
      if (!u) return null;
      const def = findEffect(cat, u.fx, TIMELINE_KINDS);
      const span = def ? spanOf(u, def, map) : null;
      return span ? { t: span[0], line: `${def!.timing === "instant" ? mmss(span[0]) : `${mmss(span[0])}-${mmss(span[1])}`} ${u.fx}${paramsText(u.params)}` } : null;
    })
    .filter((x): x is { t: number; line: string } => !!x)
    .sort((a, b) => a.t - b.t)
    .map((x) => x.line);
}
