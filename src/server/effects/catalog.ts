// The effects library: the built-in effects plus any you (or an LLM) add to the workspace's effects/
// folder as JSON files, one effect per file, in the same shape as builtin.ts. A workspace effect with a
// built-in's name replaces it. Every definition is checked before it's used; a bad one is skipped with a
// note instead of breaking renders.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config";
import { hashText } from "../agents/text";
import { BUILTIN } from "./builtin";
import { checkTemplate, type ParamSpec } from "./template";
import type { EffectDef, Kind } from "./types";

export const EFFECTS_DIR = join(ROOT, "effects");

const KINDS: Kind[] = ["segment", "video", "graphic", "text", "asset", "transition", "sound", "voice", "music"];
/** Effects that go on the edited clip's timeline (not on a part, not between parts). */
export const TIMELINE_KINDS: Kind[] = ["video", "graphic", "text", "asset", "sound", "voice", "music"];

/** Other names editors (and LLMs) use for transitions. */
const ALIASES: Record<string, string> = {
  none: "cut", hard_cut: "cut", jump_cut: "cut", cross_dissolve: "crossfade", fade_to_black: "dip_black", fade_black: "dip_black", dip_to_black: "dip_black",
  white_flash: "flash_cut", flash_white: "fadewhite", glitch: "glitch_cut", whip_pan: "whip", blur_transition: "blur", zoom_in: "zoom",
};

export type Catalog = { effects: EffectDef[]; notes: string[]; hash: string };

/** A definition from a file: the same checks the built-ins pass in tests, minus rendering. */
export function checkDef(raw: any, file = "effect"): { def?: EffectDef; error?: string } {
  const name = String(raw?.name ?? "");
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(name)) return { error: `${file}: "name" must be snake_case` };
  if (!KINDS.includes(raw.kind)) return { error: `${name}: "kind" must be one of ${KINDS.join(", ")}` };
  if (!["whole", "range", "instant"].includes(raw.timing)) return { error: `${name}: "timing" must be whole, range or instant` };
  if (raw.special) return { error: `${name}: workspace effects can't be "special"` };
  const templates = [raw.filter, raw.graphic, raw.sound, ...(raw.ass ?? []), ...Object.values(raw.variants?.filters ?? {})].filter((t) => typeof t === "string") as string[];
  const body = raw.kind === "text" ? raw.ass : raw.kind === "graphic" ? raw.graphic : raw.kind === "sound" ? raw.sound : raw.kind === "transition" ? raw.xfade ?? raw.around : raw.filter ?? raw.variants;
  if (!body) return { error: `${name}: a ${raw.kind} effect needs ${raw.kind === "text" ? '"ass"' : raw.kind === "graphic" ? '"graphic"' : raw.kind === "sound" ? '"sound"' : raw.kind === "transition" ? '"xfade"' : '"filter"'}` };
  for (const t of templates) {
    const bad = checkTemplate(t);
    if (bad) return { error: `${name}: ${bad}` };
  }
  for (const [k, p] of Object.entries<ParamSpec>(raw.params ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(k) || !["number", "color", "enum", "text", "asset"].includes(p?.type)) return { error: `${name}: parameter "${k}" isn't valid` };
    if (p.type === "number" && !(p.min <= p.default && p.default <= p.max)) return { error: `${name}: parameter "${k}" needs min ≤ default ≤ max` };
  }
  return {
    def: {
      name, kind: raw.kind, timing: raw.timing, description: String(raw.description ?? "").slice(0, 300), tags: (raw.tags ?? []).map(String).slice(0, 12),
      ...(raw.params ? { params: raw.params } : {}), ...(Number(raw.duration) > 0 ? { duration: Math.min(10, Number(raw.duration)) } : {}),
      ...(typeof raw.filter === "string" ? { filter: raw.filter } : {}), ...(raw.variants ? { variants: raw.variants } : {}),
      ...(raw.cropOnly ? { cropOnly: true } : {}), ...(typeof raw.graphic === "string" ? { graphic: raw.graphic, static: !!raw.static, x: raw.x, y: raw.y } : {}),
      ...(Array.isArray(raw.ass) ? { ass: raw.ass.map(String) } : {}), ...(typeof raw.xfade === "string" ? { xfade: raw.xfade } : {}),
      ...(Array.isArray(raw.around) ? { around: raw.around.filter((a: any) => typeof a?.fx === "string").map((a: any) => ({ fx: a.fx, ...(a.params ? { params: a.params } : {}) })) } : {}),
      ...(typeof raw.sound === "string" ? { sound: raw.sound } : {}),
      origin: "workspace",
    },
  };
}

let cache: { key: string; cat: Catalog } | null = null;

/** The library as it is now. Cached until a file in effects/ changes. */
export function loadCatalog(): Catalog {
  const files = existsSync(EFFECTS_DIR) ? readdirSync(EFFECTS_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  const key = files.map((f) => `${f}:${statSync(join(EFFECTS_DIR, f)).mtimeMs}`).join("|");
  if (cache && cache.key === key) return cache.cat;
  const notes: string[] = [];
  const mine: EffectDef[] = [];
  for (const f of files) {
    try {
      const { def, error } = checkDef(JSON.parse(readFileSync(join(EFFECTS_DIR, f), "utf8")), f);
      if (error) notes.push(`effects/${f}: ${error}`);
      else mine.push(def!);
    } catch (e) {
      notes.push(`effects/${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const same = (a: EffectDef, b: EffectDef) => a.name === b.name && (a.kind === "transition") === (b.kind === "transition");
  const effects = [...BUILTIN.filter((b) => !mine.some((m) => same(m, b))), ...mine];
  const cat = { effects, notes, hash: hashText(JSON.stringify(mine)) };
  cache = { key, cat };
  return cat;
}

/** The timeline's names for looks and moves that also exist per part (a planner mixes them up). */
const TIMELINE_ALIASES: Record<string, string> = {
  bw: "black_white", black_and_white: "black_white", monochrome: "black_white", sepia: "sepia_tone",
  zoom_out: "pull_back", slow_push: "zoom_in", push_in: "zoom_in", punch_in: "zoom_punch", camera_shake: "shake",
  fade_to_black: "dip", dip_black: "dip", dip_to_black: "dip", fade_black: "dip", fadeblack: "dip", flash_cut: "flash", white_flash: "flash",
  fadewhite: "flash", text: "big_text", title: "banner", heart_beat: "heartbeat", record_crackle: "vinyl", crackle: "vinyl",
};

/** An effect by name among some kinds (a transition's name and a timeline effect's can be the same). */
export function findEffect(cat: Catalog, name: string | undefined, kinds: Kind[]): EffectDef | undefined {
  const n = String(name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const direct = cat.effects.find((e) => e.name === (kinds.includes("transition") ? ALIASES[n] ?? n : n) && kinds.includes(e.kind));
  if (direct || kinds.includes("transition") || kinds.includes("segment")) return direct;
  return TIMELINE_ALIASES[n] ? cat.effects.find((e) => e.name === TIMELINE_ALIASES[n] && kinds.includes(e.kind)) : undefined;
}

/** A fingerprint of the definitions an edit uses: an edit renders again when one of them changes. */
export const effectsFingerprint = (defs: EffectDef[]) =>
  hashText(JSON.stringify([...new Map(defs.map((d) => [`${d.kind}:${d.name}`, d])).values()].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`))));

// ── the library as text, for the planner ─────────────────────────────

const paramText = (k: string, p: ParamSpec) => {
  switch (p.type) {
    case "number": return `${k}=${p.default} (${p.min}-${p.max}${p.doc ? `, ${p.doc}` : ""})`;
    case "color": return `${k}=${p.default}${p.doc ? ` (${p.doc})` : ""}`;
    case "enum": return `${k}=${p.values.join("|")}${p.doc ? ` (${p.doc})` : ""}`;
    case "text": return `${k}="…"${p.doc ? ` (${p.doc})` : ""}`;
    case "asset": return `${k}=<file from assets/${p.kinds.join(" or ")}>`;
  }
};
const line = (e: EffectDef) => {
  const ps = Object.entries(e.params ?? {}).map(([k, p]) => paramText(k, p)).join(", ");
  const when = e.timing === "instant" ? `at${e.duration ? `, ${e.duration}s` : ""}` : e.timing === "range" ? "from-to" : "part";
  return `- ${e.name} [${when}] ${e.description}${ps ? ` Params: ${ps}` : ""}`;
};

/** The library, grouped the way the planner uses it. `allow` filters each group (the outline's lists). */
export function catalogText(cat: Catalog, allow: { camera?: string[]; looks?: string[]; transitions?: string[]; timeline?: (e: EffectDef) => boolean } = {}) {
  const seg = cat.effects.filter((e) => e.kind === "segment");
  const camera = seg.filter((e) => e.cropOnly && (!allow.camera || allow.camera.includes(e.name)));
  const looks = seg.filter((e) => !e.cropOnly && (!allow.looks || allow.looks.includes(e.name)));
  const trs = cat.effects.filter((e) => e.kind === "transition" && (!allow.transitions || allow.transitions.includes(e.name)));
  const plain = trs.filter((e) => e.tags.includes("xfade"));
  const named = trs.filter((e) => !plain.includes(e));
  const tl = (k: Kind) => cat.effects.filter((e) => e.kind === k && (!allow.timeline || allow.timeline(e)));
  const group = (title: string, list: EffectDef[]) => (list.length ? [`### ${title}`, ...list.map(line), ""] : []);
  return [
    ...group("Camera moves (per part: \"camera\")", camera),
    ...group("Looks (per part: \"looks\")", looks),
    ...(trs.length ? ["### Transitions (per join: \"transitions\"; duration in seconds is optional)", ...named.map(line),
      ...(plain.length ? [`- also any of: ${plain.map((e) => e.name).join(", ")}`] : []), ""] : []),
    ...group("Video effects over a time range (\"timeline\")", tl("video")),
    ...group("Graphics laid over the clip (\"timeline\")", tl("graphic")),
    ...group("Text and shapes (\"timeline\"; write text in the clip's language)", tl("text")),
    ...group("Your files laid over the clip (\"timeline\")", tl("asset")),
    ...group("Sounds (\"timeline\")", tl("sound")),
    ...group("The clip's own audio (\"timeline\")", tl("voice")),
    ...group("Music (\"timeline\")", tl("music")),
  ].join("\n");
}
