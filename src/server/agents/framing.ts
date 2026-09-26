// Vertical framing from measured faces. For every shot, faces are detected locally with OpenCV's
// YuNet (tools/faces.py, no cloud), and a 9:16 layout is chosen deterministically:
//
//   crop   everyone who matters fits in a 9:16 window  → crop centred on them
//   split  two people too far apart for one window     → stacked split screen, one person per half
//   fit    a wide group / stage shot                    → whole frame over a blurred copy of itself
//
// The Editor splits segments at shot cuts so the framing can change with every cut.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "../config";
import type { JobContext } from "../jobs";
import { pool, run } from "../lib";

export type Face = [number, number, number, number, number]; // x0 y0 x1 y1 score, normalised
/** Keyframes [seconds from the part's start, in source time; horizontal centre 0..1]. */
export type Track = [number, number][];
export type Framing =
  | { mode: "crop"; cx: number; measured: boolean; track?: Track }
  | { mode: "split"; people: { cx: number; cy: number; size: number; track?: Track }[] }
  | { mode: "fit"; cx?: number; cy?: number; span?: number }; // span = share of source width to show

/** Source width / height. */
export async function probeAspect(video: string): Promise<number> {
  const r = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video]);
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return w && h ? w / h : 16 / 9;
}

const PYTHON = [join(APP_DIR, ".data", "py", "Scripts", "python.exe"), join(APP_DIR, ".data", "py", "bin", "python")].find(existsSync);
const MODEL = join(APP_DIR, ".data", "models", "face_detection_yunet_2023mar.onnx");
export const faceDetectionAvailable = () => !!PYTHON && existsSync(MODEL);

/** Run YuNet (tools/faces.py) on frame files. Null if detection isn't set up or fails. */
export async function runFaceDetector(ctx: JobContext, frames: string[]): Promise<Map<string, Face[]> | null> {
  if (!faceDetectionAvailable() || !frames.length) return null;
  const proc = Bun.spawn([PYTHON!, join(APP_DIR, "tools", "faces.py")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(JSON.stringify({ model: MODEL, frames, min_score: 0.6 }));
  proc.stdin.end();
  const [out, err, code] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text(), await proc.exited];
  if (code !== 0) {
    ctx.log(`Face detection failed: ${err.slice(-300)}`, "warn");
    return null;
  }
  return new Map<string, Face[]>((JSON.parse(out).frames as any[]).map((f) => [f.frame, f.faces]));
}

/** Detect faces at two moments of every shot (30% and 70% through). Cached per shot. */
export async function detectFaces(
  ctx: JobContext, video: string, dir: string, shots: { id: number; start: number; end: number }[],
): Promise<Record<number, Face[]>> {
  const cacheFile = join(dir, "faces.json");
  const cache: Record<number, Face[]> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const todo = shots.filter((s) => !(s.id in cache));
  if (!todo.length) return cache;
  if (!faceDetectionAvailable()) {
    ctx.log("Face detection isn't set up (see README: Vertical framing); crops stay centred", "warn");
    return cache;
  }
  const det = join(dir, "det");
  mkdirSync(det, { recursive: true });
  ctx.log(`Measuring faces in ${todo.length} shots (OpenCV YuNet, local)`);
  const jobs = todo.flatMap((s) => [0.3, 0.7].map((f, k) => ({ id: s.id, t: s.start + (s.end - s.start) * f, path: join(det, `shot_${String(s.id).padStart(4, "0")}_${k}.jpg`) })));
  let done = 0;
  await pool(jobs, 6, async (j) => {
    if (!existsSync(j.path)) {
      await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", j.t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", j.path], { signal: ctx.signal });
    }
    ctx.progress(0.8 * (++done / jobs.length), `face frames ${done}/${jobs.length}`);
  }, ctx.signal);

  const byPath = await runFaceDetector(ctx, jobs.map((j) => j.path));
  if (!byPath) return cache;
  for (const s of todo) {
    // Keep the sample with more faces: someone turning away shouldn't lose them.
    const samples = jobs.filter((j) => j.id === s.id).map((j) => byPath.get(j.path) ?? []);
    cache[s.id] = samples.sort((a, b) => b.length - a.length)[0] ?? [];
  }
  writeFileSync(cacheFile, JSON.stringify(cache), "utf8");
  ctx.progress(1, "faces measured");
  return cache;
}

/**
 * Choose a 9:16 layout for one shot. `aspect` is source width/height (16:9 = 1.78).
 * Only faces at least a fifth of the biggest face's area count, so background extras don't pull the crop.
 */
export function planFraming(faces: Face[], aspect: number): Framing {
  const cropW = (9 / 16) / aspect; // share of the source width a full-height 9:16 crop keeps
  const area = (f: Face) => (f[2] - f[0]) * (f[3] - f[1]);
  const biggest = Math.max(0, ...faces.map(area));
  const main = faces.filter((f) => f[4] >= 0.6 && area(f) >= biggest * 0.2).sort((a, b) => a[0] - b[0]);
  if (!main.length) return { mode: "crop", cx: 0.5, measured: false };
  // One person: always frame them, however close the shot (a close-up face plus shoulders can be
  // wider than the 9:16 window; centring on the face is still right).
  if (main.length === 1) return { mode: "crop", cx: (main[0][0] + main[0][2]) / 2, measured: true };

  const pad = (f: Face) => (f[2] - f[0]) * 0.9; // shoulders either side of the face
  const left = Math.min(...main.map((f) => f[0] - pad(f)));
  const right = Math.max(...main.map((f) => f[2] + pad(f)));
  if (right - left <= cropW) return { mode: "crop", cx: (left + right) / 2, measured: true };

  const size = (f: Face) => f[2] - f[0];
  if (main.length === 2 && main.every((f) => size(f) >= 0.03)) {
    return { mode: "split", people: main.map((f) => ({ cx: (f[0] + f[2]) / 2, cy: (f[1] + f[3]) / 2, size: size(f) })) };
  }
  // Two close together plus background extras: frame the pair if they fit.
  if (main.length > 2) {
    const pairs = main.slice(0, -1).map((f, i) => [f, main[i + 1]] as const).filter(([a, b]) => b[2] + pad(b) - (a[0] - pad(a)) <= cropW);
    const bestPair = pairs.sort((p, q) => area(q[0]) + area(q[1]) - (area(p[0]) + area(p[1])))[0];
    if (bestPair && area(bestPair[0]) + area(bestPair[1]) >= 0.6 * main.reduce((n, f) => n + area(f), 0)) {
      return { mode: "crop", cx: (bestPair[0][0] - pad(bestPair[0]) + bestPair[1][2] + pad(bestPair[1])) / 2, measured: true };
    }
  }
  // A group: show a square window around everyone (bigger than the whole stage), or the full frame
  // if they're spread wider than a square allows.
  const square = 1 / aspect; // a full-height square is this share of the width
  const top = Math.min(...main.map((f) => f[1]));
  const bottom = Math.max(...main.map((f) => f[3]));
  if (right - left <= square) return { mode: "fit", cx: (left + right) / 2, cy: (top + bottom) / 2, span: square };
  return { mode: "fit" };
}

/**
 * ffmpeg video filter for a framing, from the source frame to exactly W×H (9:16).
 * `lbl` makes the internal pad labels unique within the filter graph.
 */
export function framingFilter(fr: Framing, W: number, H: number, lbl: string, aspect = 16 / 9, speed = 1): string {
  if (fr.mode === "crop") {
    const cropW = `trunc(ih*9/16/2)*2`;
    return `crop=w=${cropW}:h=ih:x='max(0,min(iw-ow,iw*${trackExpr(fr.track, fr.cx, speed)}-ow/2))':y=0,scale=${W}:${H}`;
  }
  if (fr.mode === "fit") {
    // Foreground: a full-height square around the group when it fits, else the whole frame.
    const fg = fr.span !== undefined && fr.cx !== undefined
      ? `crop=w=ih:h=ih:x='max(0,min(iw-ow,iw*${fr.cx.toFixed(4)}-ow/2))':y=0,scale=${W}:${W}`
      : `scale=${W}:-2`;
    return `split[${lbl}a][${lbl}b];[${lbl}a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=28,eq=brightness=-0.08:saturation=0.9[${lbl}bg];` +
      `[${lbl}b]${fg}[${lbl}fg];[${lbl}bg][${lbl}fg]overlay=(W-w)/2:(H-h)/2`;
  }
  // split: each half is W×H/2 (9:8); crop a 9:8 window around each face, face in the upper third.
  const halfH = H / 2;
  const [a, b] = fr.people;
  const win = (p: { cx: number; cy: number; size: number; track?: Track }, name: string) => {
    // Medium close-up: the window is ~4.5 face-heights tall. A face `size` wide (share of the source
    // width) is about size*aspect of the source height, since faces are roughly square in pixels.
    const hRatio = Math.min(1, Math.max(0.45, p.size * aspect * 4.5));
    const h = `trunc(ih*${hRatio.toFixed(3)}/2)*2`;
    const w = `trunc(ih*${hRatio.toFixed(3)}*9/8/2)*2`;
    const x = `'max(0,min(iw-ow,iw*${trackExpr(p.track, p.cx, speed)}-ow/2))'`;
    const y = `'max(0,min(ih-oh,ih*${p.cy.toFixed(4)}-oh*0.33))'`;
    return `[${name}]crop=w=${w}:h=${h}:x=${x}:y=${y},scale=${W}:${halfH},setsar=1[${name}o]`;
  };
  return `split[${lbl}t][${lbl}u];${win(a, `${lbl}t`)};${win(b, `${lbl}u`)};[${lbl}to][${lbl}uo]vstack,drawbox=x=0:y=${halfH - 2}:w=${W}:h=4:color=black@0.9:t=fill`;
}

/**
 * A track as an ffmpeg expression of the frame time t (seconds since the part starts, after the
 * speed change): piecewise-linear between keyframes, held flat before the first and after the last.
 */
export function trackExpr(track: Track | undefined, cx: number, speed = 1): string {
  if (!track || track.length < 2) return (track?.[0]?.[1] ?? cx).toFixed(4);
  const k = track.map(([t, x]) => [t / speed, x] as const);
  let expr = k[k.length - 1][1].toFixed(4);
  for (let i = k.length - 2; i >= 0; i--) {
    const [t0, x0] = k[i];
    const [t1, x1] = k[i + 1];
    const seg = t1 > t0 ? `${x0.toFixed(4)}+${(x1 - x0).toFixed(4)}*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)}` : x1.toFixed(4);
    expr = `if(lt(t,${t1.toFixed(3)}),${seg},${expr})`;
  }
  return `(if(lt(t,${k[0][0].toFixed(3)}),${k[0][1].toFixed(4)},${expr}))`;
}
