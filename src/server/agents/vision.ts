// Vision transcript: what's on screen, shot by shot.
//
//   1. Shot boundaries from ffmpeg scene-change detection: measured, not guessed.
//   2. Tidy: merge flashes under 0.8s into the previous shot; split shots over 8s so each
//      part gets its own frame (the subject can move, text cards can change).
//   3. One frame from the middle of each shot (480px JPEG, also used as thumbnails in the UI).
//   4. A cheap vision model labels frames in batches: kind, description, on-screen text,
//      where the main subject sits horizontally (for 9:16 crops), number of people.
// Every step is cached under transcripts/<video>/vision/, so re-runs only do what's missing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../config";
import type { JobContext } from "../jobs";
import { rel, transcriptDir } from "../library";
import { extractJson, fmt, openrouter, pool, probeDuration, run, sleep } from "../lib";
import { norm, similarity } from "./align";
import { detectFaces, planFraming, probeAspect, type Framing } from "./framing";

export const SHOT_KINDS = [
  "host_closeup", "host_wide", "broll_footage", "archival_photo", "map", "graphic", "text_card", "animation", "other",
] as const;

export type Shot = {
  id: number; start: number; end: number;
  /** true when this is a continuation of the previous shot (a long shot split for sampling) */
  cont?: boolean;
  frame: string; // project-relative path to the sampled frame
  kind?: string; desc?: string; text?: string; subject_x?: number; people?: number;
  /** Measured with local face detection: how many faces, and the 9:16 layout chosen for this shot. */
  faces?: number;
  framing?: Framing;
};
export type VisionTranscript = {
  model: string; scene_threshold: number; shots: Shot[];
  /** Text burned in across most of the video (a hashtag, logo, watermark), removed from the shots. */
  overlays?: string[];
};

/**
 * Text that shows up on a large share of shots (allowing for OCR spelling variants) is a persistent
 * overlay, not content. Strip it from the shots so it doesn't drown out the text that matters.
 */
function stripOverlays(shots: Shot[], share = 0.2): { shots: Shot[]; overlays: string[] } {
  const key = (t: string) => norm(t.replace(/[#_]/g, " ").split(/\s+/).map(norm).join(""));
  const overlays: string[] = [];
  let rest = shots;
  for (let round = 0; round < 3; round++) {
    const counts = new Map<string, { n: number; sample: string }>();
    for (const s of rest) {
      if (!s.text) continue;
      const k = key(s.text);
      if (!k) continue;
      const c = counts.get(k) ?? { n: 0, sample: s.text };
      c.n++;
      counts.set(k, c);
    }
    const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    if (!top) break;
    const [topKey, { sample }] = top;
    const matches = (t: string) => similarity(key(t), topKey) >= 0.7;
    const hits = rest.filter((s) => s.text && matches(s.text)).length;
    if (hits < rest.length * share) break;
    overlays.push(sample);
    rest = rest.map((s) => (s.text && matches(s.text) ? { ...s, text: "" } : s));
  }
  return { shots: rest, overlays };
}

const MIN_SHOT = 0.8;
const MAX_SHOT = 8;
const BATCH = 12;
const SCENE = 0.3;

export const visionDir = (video: string) => join(transcriptDir(video), "vision");
export const visionFile = (video: string) => join(visionDir(video), "vision.json");

export function readVision(video: string): VisionTranscript | null {
  const f = visionFile(video);
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

async function detectCuts(ctx: JobContext, video: string, dir: string): Promise<number[]> {
  const cache = join(dir, "cuts.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  ctx.log(`Detecting shot changes (scene threshold ${SCENE})`);
  const total = await probeDuration(video);
  const cuts: number[] = [];
  const r = await run(
    [
      "ffmpeg", "-hide_banner", "-nostats", "-hwaccel", "auto", "-i", video, "-an",
      "-vf", `scale=320:-2,select='gt(scene,${SCENE})',metadata=print:file=-`, "-f", "null", "-",
    ],
    {
      signal: ctx.signal,
      onStdout: (line) => {
        const m = line.match(/pts_time:([\d.]+)/);
        if (m) {
          cuts.push(Number(m[1]));
          ctx.progress(0.8 * (Number(m[1]) / total), `finding shots ${fmt(Number(m[1]))} / ${fmt(total)}`);
        }
      },
    },
  );
  if (r.code !== 0) throw new Error(`ffmpeg scene detection failed: ${r.stderr.slice(-300)}`);
  writeFileSync(cache, JSON.stringify(cuts));
  return cuts;
}

function shotsFromCuts(cuts: number[], total: number): Omit<Shot, "frame">[] {
  // Merge flashes into the previous shot.
  const bounds = [0];
  for (const c of cuts) if (c - bounds[bounds.length - 1] >= MIN_SHOT && total - c >= MIN_SHOT) bounds.push(c);
  bounds.push(total);
  const out: Omit<Shot, "frame">[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const parts = Math.max(1, Math.ceil((b - a) / MAX_SHOT));
    for (let k = 0; k < parts; k++) {
      out.push({ id: out.length + 1, start: ms(a + ((b - a) * k) / parts), end: ms(a + ((b - a) * (k + 1)) / parts), ...(k ? { cont: true } : {}) });
    }
  }
  return out;
}

async function grabFrames(ctx: JobContext, video: string, shots: Shot[]) {
  let done = 0;
  const missing = shots.filter((s) => !existsSync(s.frame));
  if (!missing.length) return;
  ctx.log(`Grabbing ${missing.length} frames`);
  await pool(missing, 6, async (s) => {
    const t = s.start + (s.end - s.start) / 2;
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "5", s.frame], { signal: ctx.signal });
    ctx.progress(0.8 + 0.05 * (++done / missing.length), `frames ${done}/${missing.length}`);
  }, ctx.signal);
}

const PROMPT = `You are logging shots for a short-form video editor. For each numbered frame return one JSON object with:
- frame: the frame number
- kind: one of ${SHOT_KINDS.join(", ")} ("host" is the presenter talking to camera)
- desc: at most 12 English words describing what is visible
- text: readable on-screen text in its original language, or "". Ignore channel logos, watermarks and a hashtag
  or title that stays in the same corner of every frame; only report text that belongs to this shot.
- subject_x: horizontal centre of the main subject from 0 (left edge) to 1 (right edge)
- people: number of people visible
Reply ONLY with JSON: {"frames":[...]}`;

async function labelBatch(ctx: JobContext, shots: Shot[], cache: string) {
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Record<string, Partial<Shot>>;
  const content: any[] = [{ type: "text", text: PROMPT }];
  shots.forEach((s, i) => {
    content.push({ type: "text", text: `Frame ${i + 1}:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(readFileSync(s.frame)).toString("base64")}` } });
  });
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await openrouter({ temperature: 0, messages: [{ role: "user", content }] }, MODELS.vision, ctx.signal);
      ctx.addCost(res.usage?.cost);
      const frames: any[] = extractJson(res.content).frames ?? [];
      const out: Record<string, Partial<Shot>> = {};
      for (const f of frames) {
        const s = shots[Number(f.frame) - 1];
        if (!s) continue;
        out[s.id] = {
          kind: SHOT_KINDS.includes(f.kind) ? f.kind : "other",
          desc: String(f.desc ?? "").slice(0, 120),
          text: String(f.text ?? "").slice(0, 200),
          subject_x: Math.min(1, Math.max(0, Number(f.subject_x) || 0.5)),
          people: Math.max(0, Math.round(Number(f.people) || 0)),
        };
      }
      if (Object.keys(out).length < shots.length * 0.7) throw new Error(`only ${Object.keys(out).length}/${shots.length} frames labelled`);
      writeFileSync(cache, JSON.stringify(out), "utf8");
      return out;
    } catch (e) {
      if (ctx.signal.aborted || attempt >= 3) throw e;
      ctx.log(`vision batch retry ${attempt}: ${e instanceof Error ? e.message : e}`, "warn");
      await sleep(2000 * attempt, ctx.signal);
    }
  }
}

/** Build (or finish) the vision transcript. Progress is reported on 0..1 of this phase. */
/** Labels submitted by the browser agent in WebMCP mode. They win over model labels. */
const agentLabelsFile = (video: string) => join(visionDir(video), "agent_labels.json");

export function readAgentLabels(video: string): Record<string, Partial<Shot>> {
  try {
    return existsSync(agentLabelsFile(video)) ? JSON.parse(readFileSync(agentLabelsFile(video), "utf8")) : {};
  } catch {
    return {};
  }
}

/** Merge labels from the browser agent into the stored vision transcript. */
export function saveAgentLabels(video: string, labels: (Partial<Shot> & { id: number })[]) {
  const vt = readVision(video);
  if (!vt) throw new Error("No shots yet. Prepare the video first (shot detection runs without any model).");
  const known = new Set(vt.shots.map((s) => s.id));
  const merged = readAgentLabels(video);
  let accepted = 0;
  for (const l of labels) {
    if (!known.has(l.id)) continue;
    merged[l.id] = {
      kind: SHOT_KINDS.includes(l.kind as any) ? l.kind : "other",
      desc: String(l.desc ?? "").slice(0, 120),
      text: String(l.text ?? "").slice(0, 200),
      ...(l.subject_x !== undefined ? { subject_x: Math.min(1, Math.max(0, Number(l.subject_x))) } : {}),
      ...(l.people !== undefined ? { people: Math.max(0, Math.round(Number(l.people))) } : {}),
    };
    accepted++;
  }
  writeFileSync(agentLabelsFile(video), JSON.stringify(merged), "utf8");
  vt.shots = vt.shots.map((s) => ({ ...s, ...merged[s.id] }));
  writeFileSync(visionFile(video), JSON.stringify(vt), "utf8");
  return { accepted, ignored: labels.length - accepted, labelled: vt.shots.filter((s) => s.kind).length, total: vt.shots.length };
}

/**
 * Build (or finish) the vision transcript. Progress is reported on 0..1 of this phase.
 * With `label: false` (WebMCP mode) no model is called: shots and frames are still built, cached
 * model labels are reused, and the browser agent can add labels through label_shots.
 */
export async function visionTranscript(ctx: JobContext, video: string, opts: { label?: boolean } = {}): Promise<VisionTranscript> {
  const label = opts.label !== false;
  const dir = visionDir(video);
  mkdirSync(join(dir, "frames"), { recursive: true });
  mkdirSync(join(dir, "batches"), { recursive: true });
  const total = await probeDuration(video);
  const cuts = await detectCuts(ctx, video, dir);
  const shots: Shot[] = shotsFromCuts(cuts, total).map((s) => ({ ...s, frame: join(dir, "frames", `shot_${String(s.id).padStart(4, "0")}.jpg`) }));
  ctx.log(`${cuts.length} cuts → ${shots.length} shots to label (flashes merged, long shots sampled every ${MAX_SHOT}s)`);
  await grabFrames(ctx, video, shots);
  // Faces are measured locally (no cloud), so framing works in every engine mode.
  const aspect = await probeAspect(video);
  const faces = await detectFaces({ ...ctx, progress: (_v, stage) => ctx.progress(0.85, stage && `framing: ${stage}`) }, video, dir, shots);

  const batches: Shot[][] = [];
  for (let i = 0; i < shots.length; i += BATCH) batches.push(shots.slice(i, i + BATCH));
  ctx.log(label ? `Labelling frames with ${MODELS.vision} in ${batches.length} batches` : "Skipping model labels (WebMCP mode): reusing cached labels only");
  let done = 0;
  const labels = await pool(batches, 6, async (b) => {
    const key = `batch_${String(b[0].id).padStart(4, "0")}_${b.length}.json`;
    const cache = join(dir, "batches", key);
    if (!label) {
      ctx.progress(0.85 + 0.15 * (++done / batches.length), `shots ${done}/${batches.length}`);
      return existsSync(cache) ? (JSON.parse(readFileSync(cache, "utf8")) as Record<string, Partial<Shot>>) : {};
    }
    const r = await labelBatch(ctx, b, cache).catch((e) => {
      if (ctx.signal.aborted) throw e;
      ctx.log(`frames ${b[0].id}-${b[b.length - 1].id} unlabelled: ${e instanceof Error ? e.message : e}`, "warn");
      return {} as Record<string, Partial<Shot>>;
    });
    ctx.progress(0.85 + 0.15 * (++done / batches.length), `labelling ${done}/${batches.length}`);
    return r;
  }, ctx.signal);
  const byId = Object.assign({}, ...labels, readAgentLabels(video)) as Record<string, Partial<Shot>>;

  const cleaned = stripOverlays(shots.map((s) => {
    const fr = planFraming(faces[s.id] ?? [], aspect);
    return {
      ...s, ...byId[s.id], frame: rel(s.frame),
      faces: faces[s.id]?.length ?? 0, framing: fr,
      // Where faces were measured, their position beats the vision model's guess.
      ...(fr.mode === "crop" && fr.measured ? { subject_x: +fr.cx.toFixed(3) } : {}),
    };
  }));
  const modes = cleaned.shots.reduce((m, s) => ((m[s.framing!.mode] = (m[s.framing!.mode] ?? 0) + 1), m), {} as Record<string, number>);
  ctx.log(`Vertical framing per shot: ${Object.entries(modes).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  if (cleaned.overlays.length) ctx.log(`Ignoring persistent on-screen overlay text: ${cleaned.overlays.map((o) => `"${o}"`).join(", ")}`);
  const vt: VisionTranscript = {
    model: MODELS.vision,
    scene_threshold: SCENE,
    shots: cleaned.shots,
    overlays: cleaned.overlays,
  };
  writeFileSync(visionFile(video), JSON.stringify(vt), "utf8");
  writeFileSync(
    join(dir, "vision.txt"),
    vt.shots.map((s) => `[${fmt(s.start, "srt").replace(",", ".")} - ${fmt(s.end, "srt").replace(",", ".")}] ${s.kind ?? "?"}: ${s.desc ?? ""}${s.text ? ` | text: ${s.text}` : ""}`).join("\n"),
    "utf8",
  );
  const labelled = vt.shots.filter((s) => s.kind).length;
  ctx.log(`Vision transcript: ${vt.shots.length} shots, ${labelled} labelled`);
  return vt;
}

/** Compact visual summary of a time window, for planner prompts and Jev states. */
export function visualsIn(vt: VisionTranscript | null, start: number, end: number, max = 12): string[] {
  if (!vt) return [];
  return vt.shots
    .filter((s) => s.kind && s.end > start && s.start < end && !s.cont)
    .slice(0, max)
    .map((s) => `${s.kind}: ${s.desc}${s.text ? ` [text: ${s.text.slice(0, 60)}]` : ""}`);
}

/** Share of a window's screen time where the main subject would survive a centred 9:16 crop. */
export function verticalSafe(vt: VisionTranscript | null, start: number, end: number): number | null {
  if (!vt) return null;
  // A centred 9:16 crop of a 16:9 frame keeps the middle 31.6% of the width.
  const lo = 0.5 - 0.158, hi = 0.5 + 0.158;
  let safe = 0, total = 0;
  for (const s of vt.shots) {
    if (s.subject_x === undefined || s.end <= start || s.start >= end) continue;
    const d = Math.min(end, s.end) - Math.max(start, s.start);
    total += d;
    if (s.subject_x >= lo && s.subject_x <= hi) safe += d;
  }
  return total ? safe / total : null;
}
