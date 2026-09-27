// Renders every effect in the library on a generated test clip, so a broken template fails here and not
// in someone's render. Uses a throwaway workspace with generated assets (a GIF, a WebM with alpha, a PNG,
// a LUT, a sound, a music bed).
//
//   bun scripts/effects-test.ts                  every effect, through ffmpeg into nothing
//   bun scripts/effects-test.ts --only a,b       just these
//   bun scripts/effects-test.ts --frames <dir>   also save a frame from inside each visual effect, and a contact sheet
//   bun scripts/effects-test.ts --workspace <d>  add that workspace's own effects/ and assets/
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const only = arg("--only")?.split(",").map((s) => s.trim());
const framesDir = arg("--frames") ? resolve(arg("--frames")!) : null;
const from = arg("--workspace");
const ws = mkdtempSync(join(tmpdir(), "mrclipper-fx-"));
process.env.MRCLIPPER_WORKSPACE = ws;
process.env.MRCLIPPER_DATA = join(ws, ".state");

const { run } = await import("../src/server/lib");
const { loadCatalog } = await import("../src/server/effects/catalog");
const { listAssets, measureAssets, ensureAssetsDir, ASSETS_DIR } = await import("../src/server/effects/assets");
const { compileEdit } = await import("../src/server/effects/compile");
const { readEditStyle } = await import("../src/server/agents/edit");
type Edit = import("../src/server/agents/edit").Edit;
type EffectDef = import("../src/server/effects/types").EffectDef;

const ff = async (...args: string[]) => {
  const r = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.code !== 0) throw new Error(r.stderr.slice(-600));
};
// --sheets-only: rebuild the contact sheets from frames saved by an earlier --frames run.
if (process.argv.includes("--sheets-only") && framesDir) {
  await sheets(framesDir);
  rmSync(ws, { recursive: true, force: true });
  process.exit(0);
}

console.log(`Test workspace: ${ws}`);
ensureAssetsDir();
if (from) {
  for (const d of ["effects", "assets"]) if (existsSync(join(from, d))) cpSync(join(from, d), join(ws, d), { recursive: true });
}
const src = join(ws, "source.mp4");
await ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-f", "lavfi", "-i", "sine=f=220:d=12,volume=0.3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src);
const A = (f: string) => join(ASSETS_DIR, f);
await ff("-f", "lavfi", "-i", "testsrc=s=240x240:r=12:d=1.5", "-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse", A("overlays/sparkle.gif"));
await ff("-f", "lavfi", "-i", "color=c=orange@0.6:s=320x320:r=30:d=2,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='255*lt(hypot(X-160,Y-160),150)*(0.4+0.6*sin(T*6)^2)'", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "400k", A("overlays/fire.webm"));
await ff("-f", "lavfi", "-i", "color=c=0x00AAFF:s=300x120:d=1,format=rgba,drawbox=x=10:y=10:w=280:h=100:color=white@0.9:t=6", "-frames:v", "1", A("images/logo.png"));
await ff("-f", "lavfi", "-i", "aevalsrc='0.8*sin(2*PI*60*t)*exp(-5*t)':d=1:s=48000", A("sfx/boom.wav"));
await ff("-f", "lavfi", "-i", "aevalsrc='0.3*sin(2*PI*(262+131*floor(mod(t*2,4)))*t)':d=8:s=48000", "-b:a", "96k", A("music/piano.mp3"));
{
  // A 2-point LUT that warms the picture.
  const n = 2;
  const rows: string[] = ["LUT_3D_SIZE 2"];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${Math.min(1, r * 1.05).toFixed(3)} ${g.toFixed(3)} ${(b * 0.9).toFixed(3)}`);
  writeFileSync(A("luts/warm.cube"), rows.join("\n") + "\n");
}
const assets = await measureAssets(listAssets());
const cat = loadCatalog();
if (cat.notes.length) console.log(cat.notes.join("\n"));

// A transcript: a word every 0.4 s.
const words = Array.from({ length: 29 }, (_, i) => ({ w: i % 5 === 0 ? `كلمة${i}` : `word${i}`, start: +(0.2 + i * 0.4).toFixed(2), end: +(0.5 + i * 0.4).toFixed(2) }));
const segs = [0, 1, 2, 3].map((k) => {
  const ws = words.slice(k * 8, k * 8 + 8);
  return { start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.w).join(" "), words: ws, timing: "aligned" as const };
}).filter((s) => s.words.length);
const style = { ...readEditStyle("- **Caption style:** karaoke\n- **Transitions:** any\n- **Zoom effects:** any\n- **Glow:** subtle\n- **Vignette:** subtle"), transitionLength: 0.4 };

const PARAMS: Record<string, Record<string, unknown>> = {
  lut: { file: "warm" }, overlay: { file: "sparkle", position: "top_right", scale: 0.3 }, sfx: { file: "boom" }, music: { file: "piano" },
  asset_wipe: { file: "fire" }, ambience: { file: "boom" },
};
const needs = (d: EffectDef) => {
  const p: Record<string, unknown> = { ...(PARAMS[d.name] ?? {}) };
  for (const [k, s] of Object.entries(d.params ?? {})) if (s.type === "text" && !(k in p)) p[k] = k === "text" ? "TEST نص" : "x";
  return p;
};
const editFor = (d: EffectDef): Edit => {
  const e: Edit = { segments: [{ start: 0.2, end: 3.8 }, { start: 4.4, end: 7.6 }, { start: 8.2, end: 11.5 }], transitions: ["cut", "crossfade"], title: "Hook card title", emphasis: ["word3"] };
  const params = needs(d);
  if (d.kind === "segment") e.segments[0].fx = [{ fx: d.name, params }];
  else if (d.kind === "transition") e.transitions[0] = Object.keys(params).length ? { fx: d.name, params } : d.name;
  else if (d.timing === "instant") e.fx = [{ fx: d.name, at: 0.3, params }];
  else e.fx = [{ fx: d.name, from: 0.2, to: 2.2, params }];
  return e;
};
// Where to look for the effect in a frame grab.
const frameAt = (d: EffectDef, e: Edit) => d.kind === "transition" ? 3.4 : d.kind === "segment" ? 2.5 : d.timing === "instant" ? 0.3 + Math.min(0.5, (d.duration ?? 0.5) / 2) : 1.2;

const list = cat.effects.filter((d) => !only || only.includes(d.name));
const fails: { name: string; kind: string; err: string }[] = [];
const dir = join(ws, "out");
mkdirSync(dir, { recursive: true });
if (framesDir) mkdirSync(framesDir, { recursive: true });
let n = 0;
const t0 = Date.now();
for (const d of list) {
  const e = editFor(d);
  const name = `${d.kind}_${d.name}`;
  try {
    const c = compileEdit({ edit: e, style, video: src, vertical: true, aspect: 16 / 9, segs, catalog: cat, assets, dir, name, out: `${name}.mp4`, test: 4.5 });
    for (const [f, text] of Object.entries(c.files)) writeFileSync(join(dir, f), text);
    if (c.notes.length) throw new Error(`notes: ${c.notes.join("; ")}`);
    if (!c.used.includes(d) && d.name !== "cut") throw new Error("the effect wasn't used");
    const visual = !["sound", "voice", "music"].includes(d.kind);
    const base = c.args.slice(0, c.args.indexOf("-map"));
    const args = framesDir && visual
      ? [...base, "-map", "[vout]", "-ss", String(frameAt(d, e)), "-frames:v", "1", "-update", "1", join(framesDir, `${name}.png`), "-map", "[aout]", "-t", "4.5", "-f", "null", "-"]
      : c.args;
    const r = await run(args, { cwd: dir });
    if (r.code !== 0) throw new Error(r.stderr.slice(-700));
    n++;
    process.stdout.write(".");
  } catch (err) {
    fails.push({ name: d.name, kind: d.kind, err: err instanceof Error ? err.message : String(err) });
    process.stdout.write("x");
  }
}
console.log(`\n${n}/${list.length} effects render (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
for (const f of fails) console.log(`\n✗ ${f.kind} ${f.name}\n  ${f.err.split("\n").slice(-6).join("\n  ")}`);
if (framesDir) await sheets(framesDir);

/** Contact sheets of the saved frames, 6×3 per page, each labelled with its effect. */
async function sheets(dir: string) {
  const pngs = readdirSync(dir).filter((f) => f.endsWith(".png") && !f.startsWith("sheet"));
  // drawtext needs a font file on Windows, where ffmpeg has no fontconfig setup.
  const font = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"].find(existsSync);
  const fontOpt = font ? `fontfile='${font.replace(/:/g, "\\:")}':` : "";
  for (let page = 0; page * 18 < pngs.length; page++) {
    const chunk = pngs.slice(page * 18, page * 18 + 18);
    const inputs = chunk.flatMap((f) => ["-i", join(dir, f)]);
    const lab = chunk.map((f, i) => `[${i}:v]scale=240:426,drawtext=${fontOpt}text='${f.replace(/\.png$/, "").replace(/'/g, "")}':x=6:y=6:fontsize=15:fontcolor=white:box=1:boxcolor=black@0.65[l${i}]`).join(";");
    const pad = Array.from({ length: 18 - chunk.length }, (_, i) => `color=c=gray:s=240x426:d=1[e${i}]`).join(";");
    const all = [...chunk.map((_, i) => `[l${i}]`), ...Array.from({ length: 18 - chunk.length }, (_, i) => `[e${i}]`)].join("");
    await ff(...inputs, "-filter_complex", `${lab}${pad ? `;${pad}` : ""};${all}xstack=inputs=18:layout=${Array.from({ length: 18 }, (_, i) => `${(i % 6) * 240}_${Math.floor(i / 6) * 426}`).join("|")}`, "-frames:v", "1", join(dir, `sheet_${page + 1}.png`)).catch((e) => console.log(`sheet ${page + 1}: ${e.message}`));
  }
  console.log(`Frames and contact sheets in ${dir}`);
}
if (!process.argv.includes("--keep")) rmSync(ws, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
