// Your files for edits, in the workspace's assets/ folder:
//   assets/sfx/        sound effects (wav, mp3, ogg…)            the "sfx" effect
//   assets/music/      music beds                                the "music" effect, ducked under speech
//   assets/overlays/   GIFs, WebM/MOV with alpha, green-screen    "overlay" and "asset_wipe"
//   assets/images/     PNG/JPG stickers, logos, photos           "overlay"
//   assets/luts/       .cube colour LUTs                         "lut"
//   assets/fonts/      .ttf/.otf fonts for captions and text     by name in the outline's caption font
// Name files for what they are ("whoosh_long.wav", "sad_piano_slow.mp3"): the planner reads the names.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, parse } from "node:path";
import { DATA_DIR, ROOT } from "../config";
import { probeMedia } from "../lib";
import { hashText } from "../agents/text";
import type { AssetKind } from "./template";

export const ASSETS_DIR = join(ROOT, "assets");
export const ASSET_FOLDERS: Record<AssetKind, string> = { sfx: "sfx", music: "music", overlay: "overlays", image: "images", lut: "luts", font: "fonts" };
const EXTS: Record<AssetKind, string[]> = {
  sfx: [".wav", ".mp3", ".ogg", ".m4a", ".flac", ".aac", ".opus"],
  music: [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac", ".opus"],
  overlay: [".gif", ".webm", ".mov", ".mp4", ".png", ".apng", ".webp"],
  image: [".png", ".jpg", ".jpeg", ".webp"],
  lut: [".cube"],
  font: [".ttf", ".otf"],
};

export type Asset = { kind: AssetKind; name: string; file: string; size: number; mtime: number; duration?: number; vcodec?: string };

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
      "- `sfx/` sound effects (wav, mp3, ogg…)",
      "- `music/` music beds, ducked under speech (\"sad_piano_slow.mp3\")",
      "- `overlays/` GIFs, WebM or MOV with transparency, green-screen clips: stickers, reactions, transitions",
      "- `images/` PNG or JPG stickers, logos, photos",
      "- `luts/` .cube colour LUTs",
      "- `fonts/` .ttf or .otf fonts; use one by its family name as the outline's caption font",
      "",
    ].join("\n"), "utf8");
  }
}

/** Every usable file in assets/, by kind. Names are the file name without its extension. */
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
  return out;
}

/** An asset by name (with or without extension, any case) among some kinds. */
export function findAsset(assets: Asset[], kinds: AssetKind[], name: string): Asset | null {
  const n = parse(String(name).trim().replace(/\\/g, "/").split("/").pop() ?? "").name.toLowerCase();
  return assets.find((a) => kinds.includes(a.kind) && a.name.toLowerCase() === n) ?? null;
}

/** What the assets are, for fingerprints: names, sizes and times. */
export const assetsFingerprint = (assets: Asset[]) => hashText(JSON.stringify(assets.map((a) => [a.kind, a.name, a.size, a.mtime])));

// Durations of sound, music and moving overlays, measured once per file version.
const INDEX = join(DATA_DIR, "assets-index.json");
function readIndex(): Record<string, { duration?: number; vcodec?: string }> {
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
    if (a.duration !== undefined || !["sfx", "music", "overlay"].includes(a.kind) || /\.(png|webp)$/i.test(a.file)) continue;
    const m = await probeMedia(a.file).catch(() => ({ duration: 0, vcodec: undefined }));
    a.duration = +m.duration.toFixed(2);
    if (m.vcodec) a.vcodec = m.vcodec;
    idx[`${a.file}|${a.size}|${a.mtime}`] = { duration: a.duration, ...(a.vcodec ? { vcodec: a.vcodec } : {}) };
    changed = true;
  }
  if (changed) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(INDEX, JSON.stringify(idx), "utf8");
  }
  return assets;
}

/** The assets as text for the planner. */
export function assetsText(assets: Asset[]): string {
  if (!assets.length) return "(none: assets/ is empty, so use generated sounds and graphics only)";
  const groups = Object.keys(ASSET_FOLDERS).map((k) => {
    const list = assets.filter((a) => a.kind === k);
    return list.length ? `- ${ASSET_FOLDERS[k as AssetKind]}: ${list.map((a) => `${a.name}${a.duration ? ` (${a.duration.toFixed(1)}s)` : ""}`).join(", ")}` : "";
  });
  return groups.filter(Boolean).join("\n");
}
