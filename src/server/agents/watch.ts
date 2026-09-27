// Clip transcript: the Transcriber, pointed at the finished clips instead of the source.
// It listens to and watches what Render actually produced, so Check (and through it the Coach)
// judges the output (captions, framing, effects, what ended up being said), not the planned ranges.
//
//   audio   Whisper word timings on the rendered clip, compared with the words the plan expected
//   frames  one frame every ~3 s: local face detection (is anyone cut off by the 9:16 edge?) and a
//           cheap vision model's read of framing, captions and visible effects
//
// Saved per clip as clips/<run>/watch/clip_NN/watch.json, and skipped while the clip file is unchanged.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter, pool, probeDuration, run } from "../lib";
import { readClipData, readTranscript, rel, runDir } from "../library";
import { norm, tokenize } from "./align";
import { detectFaces } from "./framing";
import { timeChunk } from "./transcribe";

export type WatchFrame = {
  t: number; frame: string; faces: number; face_cut: boolean;
  desc?: string; framing?: "good" | "cut_off" | "empty" | "split" | "fit"; captions?: string; caption_ok?: boolean; effect?: string;
};
export type ClipWatch = {
  at: number; file: string; mtime: number; duration: number; model?: string;
  audio: { text: string; words: { w: string; start: number; end: number }[]; match: number | null } | null;
  frames: WatchFrame[];
  metrics: { script_match: number | null; faces_ok: number | null; cut_off: number; captions_ok: number | null; framing_ok: number | null };
};

const pad = (id: number) => String(id).padStart(2, "0");
export const watchDir = (run: string, id: number) => join(runDir(run), "watch", `clip_${pad(id)}`);

export function readWatch(run: string, id: number): ClipWatch | null {
  try {
    const f = join(watchDir(run, id), "watch.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

/** A watch is fresh while the rendered clip hasn't been re-cut since. */
export function watchFresh(run: string, id: number) {
  const w = readWatch(run, id);
  const file = join(runDir(run), `clip_${pad(id)}.mp4`);
  return !!w && existsSync(file) && Math.round(statSync(file).mtimeMs) === w.mtime;
}

const PROMPT = `You are checking frames from a finished vertical (9:16) short-form clip before it is posted. For each numbered frame return one JSON object:
- frame: the frame number
- desc: at most 12 English words: what is visible
- framing: "good" (the speaker or subject is well framed), "cut_off" (a face or the main subject is cut by the frame edge), "empty" (no clear subject), "split" (split screen), or "fit" (a smaller picture over a blurred background)
- captions: the caption text burned into the frame, or ""
- caption_ok: true if the captions are readable and don't cover a face ("" captions: true)
- effect: a visible effect or transition, like "zoom", "black and white", "crossfade", "title card", "vignette", or ""
Reply ONLY with JSON: {"frames":[...]}`;

/** Words the plan expected the clip to say: the source transcript under each edit segment, in play order. */
function expectedWords(data: ReturnType<typeof readClipData>, clip: ReturnType<typeof readClipData>["clips"][number]) {
  const segs = readTranscript(data.video) ?? [];
  const ranges = clip.edit?.segments?.length && clip.edit.enabled !== false ? clip.edit.segments.map((s) => [s.start, s.end]) : [[clip.start, clip.end]];
  return ranges.flatMap(([a, b]) =>
    segs.filter((s) => s.end > a && s.start < b).flatMap((s) =>
      s.words?.length ? s.words.filter((w) => w.end > a && w.start < b).map((w) => w.w) : tokenize(s.text),
    ),
  );
}

/** Share of expected words that were heard (multiset match on normalised words). */
function scriptMatch(expected: string[], heard: string[]) {
  if (!expected.length) return null;
  const bag = new Map<string, number>();
  for (const w of heard.map(norm).filter(Boolean)) bag.set(w, (bag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of expected.map(norm).filter(Boolean)) {
    const n = bag.get(w) ?? 0;
    if (n > 0) (hit++, bag.set(w, n - 1));
  }
  return +(hit / expected.length).toFixed(2);
}

async function watchOne(ctx: JobContext, runId: string, data: ReturnType<typeof readClipData>, clip: ReturnType<typeof readClipData>["clips"][number]): Promise<ClipWatch> {
  const file = join(runDir(runId), `clip_${pad(clip.id)}.mp4`);
  const dir = watchDir(runId, clip.id);
  // Only called for a new or re-cut clip: drop the old audio words and face cache.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const duration = await probeDuration(file);
  const cloud = true;

  // Audio: what the finished clip actually says.
  let audio: ClipWatch["audio"] = null;
  if (cloud) {
    const mp3 = join(dir, "audio.mp3");
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { signal: ctx.signal });
    try {
      const heard = await timeChunk(ctx, mp3);
      audio = { text: heard.map((w) => w.w).join(" "), words: heard, match: scriptMatch(expectedWords(data, clip), heard.map((w) => w.w)) };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.log(`Clip ${clip.id}: couldn't transcribe the audio (${e instanceof Error ? e.message : e})`, "warn");
    }
  }

  // Frames: faces measured locally, then one vision call for all of them.
  const n = Math.min(14, Math.max(4, Math.round(duration / 3)));
  const times = Array.from({ length: n }, (_, i) => +(((i + 0.5) * duration) / n).toFixed(2));
  const frames: WatchFrame[] = times.map((t, i) => ({ t, frame: join(dir, `f_${pad(i + 1)}.jpg`), faces: 0, face_cut: false }));
  await pool(frames, 6, async (f) => {
    await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f.t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", f.frame], { signal: ctx.signal });
  }, ctx.signal);
  const faces = await detectFaces({ ...ctx, progress: () => {} }, file, dir, frames.map((f, i) => ({ id: i + 1, start: Math.max(0, f.t - 0.4), end: Math.min(duration, f.t + 0.4) })));
  frames.forEach((f, i) => {
    const fs = faces[i + 1] ?? [];
    f.faces = fs.length;
    f.face_cut = fs.some(([x0, , x1]) => x0 < 0.015 || x1 > 0.985);
  });
  let model: string | undefined;
  if (cloud) {
    const content: any[] = [{ type: "text", text: PROMPT }];
    frames.forEach((f, i) => {
      content.push({ type: "text", text: `Frame ${i + 1} (${f.t.toFixed(1)}s):` });
      content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(readFileSync(f.frame)).toString("base64")}` } });
    });
    try {
      const res = await openrouter({ temperature: 0, messages: [{ role: "user", content }] }, MODELS.vision, ctx.signal);
      ctx.addCost(res.usage?.cost);
      model = res.model;
      for (const x of extractJson(res.content).frames ?? []) {
        const f = frames[Number(x.frame) - 1];
        if (!f) continue;
        f.desc = String(x.desc ?? "").slice(0, 120);
        f.framing = ["good", "cut_off", "empty", "split", "fit"].includes(x.framing) ? x.framing : undefined;
        f.captions = String(x.captions ?? "").slice(0, 160);
        f.caption_ok = x.caption_ok !== false;
        f.effect = String(x.effect ?? "").slice(0, 60);
      }
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      ctx.log(`Clip ${clip.id}: frame check failed (${e instanceof Error ? e.message : e})`, "warn");
    }
  }

  const share = (xs: boolean[]) => (xs.length ? +(xs.filter(Boolean).length / xs.length).toFixed(2) : null);
  const labelled = frames.filter((f) => f.framing);
  const w: ClipWatch = {
    at: Date.now(), file: rel(file), mtime: Math.round(statSync(file).mtimeMs), duration, model,
    audio, frames: frames.map((f) => ({ ...f, frame: rel(f.frame) })),
    metrics: {
      script_match: audio?.match ?? null,
      faces_ok: share(frames.filter((f) => f.faces > 0).map((f) => !f.face_cut)),
      cut_off: frames.filter((f) => f.face_cut || f.framing === "cut_off").length,
      captions_ok: share(labelled.filter((f) => f.captions).map((f) => f.caption_ok !== false)),
      framing_ok: share(labelled.map((f) => f.framing === "good" || f.framing === "split" || f.framing === "fit")),
    },
  };
  writeFileSync(join(dir, "watch.json"), JSON.stringify(w, null, 1), "utf8");
  return w;
}

/** Watch and listen to a take's finished clips (only those not watched since their last cut). */
export async function watchClips(ctx: JobContext, runId: string, opts: { only?: number[]; force?: boolean } = {}) {
  const data = readClipData(join(runDir(runId), "clip_script.md"));
  const cut = data.clips.filter((c) => existsSync(join(runDir(runId), `clip_${pad(c.id)}.mp4`)) && (!opts.only || opts.only.includes(c.id)));
  const todo = cut.filter((c) => opts.force || !watchFresh(runId, c.id));
  if (!cut.length) throw new Error("This take has no finished clips yet. Cut it first.");
  if (!todo.length) {
    ctx.log(`All ${cut.length} finished clip(s) already have a clip transcript`);
    return { run: runId, watched: 0, clips: cut.length };
  }
  ctx.log(`Watching ${todo.length} finished clip(s): Whisper on the audio, faces and a frame check every ~3 s`);
  let done = 0;
  for (const c of todo) {
    ctx.progress(done / todo.length, `watching clip ${c.id}`);
    const w = await watchOne(ctx, runId, data, c);
    ctx.log(
      `Clip ${c.id}: heard ${w.audio ? `${w.audio.words.length} words, ${w.metrics.script_match !== null ? `${Math.round(w.metrics.script_match * 100)}% word overlap with the planned transcript` : "no script to compare"}` : "nothing (no audio pass)"}; ` +
        `${w.frames.length} frames, ${w.metrics.cut_off} with someone cut off${w.metrics.captions_ok !== null ? `, captions ok ${Math.round(w.metrics.captions_ok * 100)}%` : ""}`,
    );
    done++;
  }
  ctx.progress(1, "clips watched");
  return { run: runId, watched: todo.length, clips: cut.length };
}

/** One-paragraph summary of a finished clip for prompts and Jev states. */
export function watchSummary(w: ClipWatch | null): string {
  if (!w) return "";
  const m = w.metrics;
  const issues = w.frames.filter((f) => f.face_cut || f.framing === "cut_off" || f.framing === "empty" || f.caption_ok === false)
    .map((f) => `${f.t.toFixed(0)}s ${f.face_cut || f.framing === "cut_off" ? "someone cut off" : f.framing === "empty" ? "no clear subject" : "captions hard to read"}`);
  const effects = [...new Set(w.frames.map((f) => f.effect).filter(Boolean))];
  return [
    w.audio ? `heard: "${w.audio.text.slice(0, 400)}${w.audio.text.length > 400 ? "…" : ""}"` : "",
    // Two different transcribers on Arabic dialect rarely agree word for word; only a very low overlap means lost audio.
    m.script_match !== null && m.script_match < 0.3 ? `only ${Math.round(m.script_match * 100)}% word overlap with the planned transcript: audio may be missing or cut` : "",
    `${w.frames.length} frames checked${issues.length ? `, issues: ${issues.slice(0, 5).join("; ")}` : ", no framing or caption issues"}`,
    effects.length ? `visible effects: ${effects.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
}
