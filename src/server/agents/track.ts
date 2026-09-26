// Face tracking for the vertical crop, at render time. The vision transcript measures faces twice
// per shot (up to 8 s), which is fine for a talking head but not for a stage play, where people walk
// around inside a shot and a fixed crop ends up on an empty set or with someone half out of frame.
// So the Editor samples faces every 0.5 s over exactly the ranges it renders (local YuNet, no cloud)
// and turns them into a moving crop: held steady inside a dead zone, eased when the subject moves,
// and speed-limited so it reads as a camera operator following, not a jittery tracker.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext } from "../jobs";
import { pool, run } from "../lib";
import type { Edit } from "./edit";
import { faceDetectionAvailable, runFaceDetector, type Face, type Framing, type Track } from "./framing";
import type { VisionTranscript } from "./vision";

const STEP = 0.5; // seconds between samples
const DEAD = 0.035; // share of the source width the subject can move before the crop follows
const VMAX = 0.22; // max pan speed, source widths per second
const TOL = 0.012; // keyframe simplification tolerance

type Part = { start: number; end: number; framing: Framing };

const main = (faces: Face[]) => {
  const area = (f: Face) => (f[2] - f[0]) * (f[3] - f[1]);
  const big = Math.max(0, ...faces.map(area));
  return faces.filter((f) => f[4] >= 0.6 && area(f) >= big * 0.2);
};
const centre = (f: Face) => (f[0] + f[2]) / 2;

/** Where the crop wants to be for one sample, or null when no one is visible. */
function cropTarget(faces: Face[], cropW: number, prev: number | null): number | null {
  const m = main(faces);
  if (!m.length) return null;
  if (m.length === 1) return centre(m[0]);
  const pad = (f: Face) => (f[2] - f[0]) * 0.9;
  const left = Math.min(...m.map((f) => f[0] - pad(f)));
  const right = Math.max(...m.map((f) => f[2] + pad(f)));
  if (right - left <= cropW) return (left + right) / 2;
  // Too spread to frame together: stay with whoever the crop is on (continuity), else the biggest face.
  const pick = prev === null
    ? m.sort((a, b) => (b[2] - b[0]) - (a[2] - a[0]))[0]
    : m.sort((a, b) => Math.abs(centre(a) - prev) - Math.abs(centre(b) - prev))[0];
  return centre(pick);
}

/** Fill gaps, median-filter, then follow with a dead zone and a speed limit. Returns keyframes. */
function follow(raw: (number | null)[], start: number): Track | null {
  if (!raw.some((x) => x !== null)) return null;
  const filled = raw.slice();
  let last = filled.find((x) => x !== null)!;
  for (let i = 0; i < filled.length; i++) filled[i] === null ? (filled[i] = last) : (last = filled[i]!);
  const med = filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - 2), i + 3).map(Number).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const pts: Track = [];
  let cur = med[0];
  for (let i = 0; i < med.length; i++) {
    const d = med[i] - cur;
    if (Math.abs(d) > DEAD) cur += Math.sign(d) * Math.min(Math.abs(d) - DEAD * 0.5, VMAX * STEP);
    pts.push([+(i * STEP).toFixed(3), +cur.toFixed(4)]);
  }
  // Drop keyframes a straight line through their neighbours already explains.
  const out: Track = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i + 1];
    const lin = a[1] + ((b[1] - a[1]) * (pts[i][0] - a[0])) / (b[0] - a[0] || 1);
    if (Math.abs(lin - pts[i][1]) > TOL) out.push(pts[i]);
  }
  if (pts.length > 1) out.push(pts[pts.length - 1]);
  void start;
  return out.slice(0, 40);
}

/** Split screen: follow each of the two people separately. */
function followPeople(samples: Face[][], people: { cx: number }[]): (Track | null)[] {
  const raws = people.map(() => [] as (number | null)[]);
  const prev = people.map((p) => p.cx);
  for (const faces of samples) {
    const m = main(faces);
    people.forEach((_, k) => {
      const near = m.map((f) => ({ f, d: Math.abs(centre(f) - prev[k]) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d < 0.15) (raws[k].push(centre(near.f)), (prev[k] = centre(near.f)));
      else raws[k].push(null);
    });
  }
  return raws.map((r) => follow(r, 0));
}

async function sampleFaces(ctx: JobContext, video: string, dir: string, start: number, end: number) {
  const key = `${Math.round(start * 1000)}_${Math.round(end * 1000)}`;
  const d = join(dir, key);
  const cache = join(d, "faces.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Face[][];
  mkdirSync(d, { recursive: true });
  await run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", start.toFixed(3), "-t", (end - start).toFixed(3), "-i", video,
    "-vf", `fps=${1 / STEP},scale=960:-2`, "-q:v", "4", join(d, "s_%04d.jpg"),
  ], { signal: ctx.signal });
  const frames = readdirSync(d).filter((f) => f.startsWith("s_")).sort().map((f) => join(d, f));
  const found = await runFaceDetector(ctx, frames);
  if (!found) return null;
  const out = frames.map((f) => found.get(f) ?? []);
  writeFileSync(cache, JSON.stringify(out), "utf8");
  return out;
}

/**
 * Tracked framing parts for every segment of an edit, keyed by segment index.
 * `partsOf` gives the shot-level parts (framingParts); crop and split parts get tracks.
 */
export async function trackEdit(
  ctx: JobContext, video: string, dir: string, e: Edit, aspect: number,
  partsOf: (start: number, end: number) => Part[],
): Promise<{ parts: Record<number, Part[]>; moving: number; total: number } | null> {
  if (!faceDetectionAvailable()) return null;
  const cropW = (9 / 16) / aspect;
  const all = e.segments.flatMap((s, i) => partsOf(s.start, s.end).map((p) => ({ i, p })));
  const todo = all.filter(({ p }) => (p.framing.mode === "crop" || p.framing.mode === "split") && p.end - p.start >= 1);
  const samples = await pool(todo, 3, async ({ p }) => sampleFaces(ctx, video, dir, p.start, p.end), ctx.signal);
  let moving = 0;
  const tracked = new Map<Part, Part>();
  todo.forEach(({ p }, k) => {
    const s = samples[k];
    if (!s) return;
    if (p.framing.mode === "crop") {
      const raw: (number | null)[] = [];
      let prev: number | null = p.framing.measured ? p.framing.cx : null;
      for (const faces of s) {
        const t = cropTarget(faces, cropW, prev);
        raw.push(t);
        if (t !== null) prev = t;
      }
      const tr = follow(raw, p.start);
      if (!tr) return;
      if (Math.max(...tr.map((x) => x[1])) - Math.min(...tr.map((x) => x[1])) > 0.02) moving++;
      tracked.set(p, { ...p, framing: { mode: "crop", cx: tr[0][1], measured: true, track: tr } });
    } else if (p.framing.mode === "split") {
      const trs = followPeople(s, p.framing.people);
      tracked.set(p, { ...p, framing: { mode: "split", people: p.framing.people.map((q, k2) => (trs[k2] ? { ...q, cx: trs[k2]![0][1], track: trs[k2]! } : q)) } });
      if (trs.some((t) => t && t.length > 2)) moving++;
    }
  });
  const parts: Record<number, Part[]> = {};
  for (const { i, p } of all) (parts[i] ??= []).push(tracked.get(p) ?? p);
  return { parts, moving, total: todo.length };
}
