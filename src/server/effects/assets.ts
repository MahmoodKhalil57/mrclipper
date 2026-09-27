// Your files for edits, in the workspace's assets/ folder:
//   assets/sfx/        sound effects (wav, mp3, ogg…)            the "sfx" effect
//   assets/music/      music beds                                the "music" effect, ducked under speech
//   assets/overlays/   GIFs, WebM/MOV with alpha, green-screen    "overlay" and "asset_wipe"
//   assets/images/     PNG/JPG stickers, logos, photos           "overlay"
//   assets/luts/       .cube colour LUTs                         "lut"
//   assets/fonts/      .ttf/.otf fonts for captions and text     by name in the outline's caption font
// Name files for what they are ("whoosh_long.wav", "sad_piano_slow.mp3"): the planner reads the names.
// Next to yours, mrClipper ships a library of recorded sound effects (sounds/, CC0), listed as sfx too.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, parse } from "node:path";
import { APP_DIR, DATA_DIR, ROOT } from "../config";
import { measureLoudness, probeMedia } from "../lib";
import { hashText } from "../agents/text";
import type { AssetKind } from "./template";

export const ASSETS_DIR = join(ROOT, "assets");
/** The built-in library of recorded sound effects that ships with mrClipper (CC0; see sounds/CREDITS.md). */
export const BUILTIN_SOUNDS = join(APP_DIR, "sounds");
export const ASSET_FOLDERS: Record<AssetKind, string> = { sfx: "sfx", music: "music", overlay: "overlays", image: "images", lut: "luts", font: "fonts" };
const EXTS: Record<AssetKind, string[]> = {
  sfx: [".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac", ".opus"],
  music: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"],
  overlay: [".gif", ".webm", ".mov", ".mp4", ".png", ".apng", ".webp"],
  image: [".png", ".jpg", ".jpeg", ".webp"],
  lut: [".cube"],
  font: [".ttf", ".otf"],
};

export type Asset = {
  kind: AssetKind; name: string; file: string; size: number; mtime: number; duration?: number; vcodec?: string;
  /** Music: integrated loudness (LUFS), so beds of different files sit at the same level. */
  lufs?: number;
  /** From the built-in sound library, with the description the planner reads. */
  builtin?: boolean; description?: string;
  /** A noise bed (crackle, room tone): offered to the planner only when the outline asks with one of these words. */
  texture?: string[];
};

/** Create assets/ and its folders (with a short readme) so there's somewhere to drop files. */
export function ensureAssetsDir() {
  for (const f of Object.values(ASSET_FOLDERS)) mkdirSync(join(ASSETS_DIR, f), { recursive: true });
  const readme = join(ASSETS_DIR, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      "# Assets for edits",
      "",
      "Drop files here and the Design step can use them. Name them for what they are: the planner reads the names.",
      "",
      "- `sfx/` sound effects (wav, mp3, ogg…). mrClipper also has a built-in library of recorded sounds; a file here with the same name replaces one of those.",
      "- `music/` music beds, ducked under speech (\"sad_piano_slow.mp3\"). With `Music source: generate` in the outline, Lyria makes a score for each clip instead, saved with the take.",
      "- `overlays/` GIFs, WebM or MOV with transparency, green-screen clips: stickers, reactions, transitions",
      "- `images/` PNG or JPG stickers, logos, photos",
      "- `luts/` .cube colour LUTs",
      "- `fonts/` .ttf or .otf fonts; use one by its family name as the outline's caption font",
      "",
    ].join("\n"), "utf8");
  }
}

/** Every usable file: yours in assets/ by kind, then the built-in recorded sounds. Names are file names without extensions. */
export function listAssets(): Asset[] {
  const out: Asset[] = [];
  for (const [kind, folder] of Object.entries(ASSET_FOLDERS) as [AssetKind, string][]) {
    const dir = join(ASSETS_DIR, folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!EXTS[kind].includes(extname(f).toLowerCase()) || f.includes("'")) continue;
      const file = join(dir, f);
      const st = statSync(file);
      if (st.isFile()) out.push({ kind, name: parse(f).name, file, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
  }
  const known = readIndex();
  for (const a of out) {
    const k = known[`${a.file}|${a.size}|${a.mtime}`];
    if (k) Object.assign(a, k);
  }
  // The built-in recorded sounds, after yours: a file of yours with the same name wins.
  for (const b of builtinSounds()) if (!out.some((a) => a.kind === "sfx" && a.name.toLowerCase() === b.name.toLowerCase())) out.push({ ...b });
  return out;
}

let builtinCache: Asset[] | null = null;
function builtinSounds(): Asset[] {
  if (builtinCache) return builtinCache;
  try {
    const lib = JSON.parse(readFileSync(join(BUILTIN_SOUNDS, "library.json"), "utf8"));
    builtinCache = (lib.sounds ?? []).flatMap((s: any): Asset[] => {
      const file = join(BUILTIN_SOUNDS, `${s.name}.mp3`);
      if (!existsSync(file)) return [];
      return [{ kind: "sfx", name: String(s.name), file, size: statSync(file).size, mtime: 0, duration: Number(s.seconds) || undefined, builtin: true, description: String(s.description ?? ""), ...(Array.isArray(s.texture) ? { texture: s.texture.map(String) } : {}) }];
    });
  } catch {
    builtinCache = [];
  }
  return builtinCache!;
}

/** An asset by name (with or without extension, any case) among some kinds. */
export function findAsset(assets: Asset[], kinds: AssetKind[], name: string): Asset | null {
  const n = parse(String(name).trim().replace(/\\/g, "/").split("/").pop() ?? "").name.toLowerCase();
  return assets.find((a) => kinds.includes(a.kind) && a.name.toLowerCase() === n) ?? null;
}

/** What the assets are, for fingerprints: names, sizes and times (built-in sounds by name and size only,
 *  since a checkout's file times change with every git operation). */
export const assetsFingerprint = (assets: Asset[]) => hashText(JSON.stringify(assets.map((a) => [a.kind, a.name, a.size, a.builtin ? 0 : a.mtime])));

// Durations of sound, music and moving overlays, measured once per file version.
const INDEX = join(DATA_DIR, "assets-index.json");
function readIndex(): Record<string, { duration?: number; vcodec?: string; lufs?: number }> {
  try {
    return existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : {};
  } catch {
    return {};
  }
}

/** Measure durations that aren't known yet (sfx, music, overlays). */
export async function measureAssets(assets: Asset[]) {
  const idx = readIndex();
  let changed = false;
  for (const a of assets) {
    const needsLufs = a.kind === "music" && a.lufs === undefined;
    if ((a.duration !== undefined && !needsLufs) || a.builtin || !["sfx", "music", "overlay"].includes(a.kind) || /\.(png|webp)$/i.test(a.file)) continue;
    const m = await probeMedia(a.file).catch(() => ({ duration: 0, vcodec: undefined }));
    a.duration = +m.duration.toFixed(2);
    if (m.vcodec) a.vcodec = m.vcodec;
    if (a.kind === "music") a.lufs = (await measureLoudness(a.file).catch(() => null)) ?? undefined;
    idx[`${a.file}|${a.size}|${a.mtime}`] = { duration: a.duration, ...(a.vcodec ? { vcodec: a.vcodec } : {}), ...(a.lufs !== undefined ? { lufs: +a.lufs.toFixed(1) } : {}) };
    changed = true;
  }
  if (changed) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(INDEX, JSON.stringify(idx), "utf8");
  }
  return assets;
}

/**
 * What the planner may use. Crackle and room tone are left out unless the outline asks for them ("vinyl
 * crackle", "room tone", not "no crackle"): on a phone speaker a noise bed under speech sounds like static.
 * A plan that names one anyway doesn't find the file, so it's dropped with a note.
 */
export function offeredAssets(assets: Asset[], outline: string): Asset[] {
  const text = outline.toLowerCase();
  const asks = (w: string) => {
    for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + 1)) {
      if (!/\b(no|not|without|avoid|never|don'?t|skip)\b[^.\n]{0,32}$/.test(text.slice(Math.max(0, i - 40), i))) return true;
    }
    return false;
  };
  return assets.filter((a) => !a.texture || [a.name.replace(/_/g, " "), a.name, ...a.texture].some((w) => asks(w.toLowerCase())));
}

/** The files for the planner: yours by folder, then the built-in recorded sounds with what each is for. */
export function assetsText(assets: Asset[]): string {
  const mine = assets.filter((a) => !a.builtin);
  const groups = Object.keys(ASSET_FOLDERS).map((k) => {
    const list = mine.filter((a) => a.kind === k);
    return list.length ? `- ${ASSET_FOLDERS[k as AssetKind]}: ${list.map((a) => `${a.name}${a.duration ? ` (${a.duration.toFixed(1)}s)` : ""}`).join(", ")}` : "";
  }).filter(Boolean);
  const built = assets.filter((a) => a.builtin);
  return [
    groups.length ? `Your files:\n${groups.join("\n")}` : "Your files: none (assets/ is empty).",
    ...(built.length ? [`Recorded sounds, built in (play one with the "sfx" effect and file=<name>):\n${built.map((a) => `- ${a.name} (${a.duration?.toFixed(1) ?? "?"}s): ${a.description}`).join("\n")}`] : []),
  ].join("\n\n");
}
