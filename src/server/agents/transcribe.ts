import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../config";
import { MISSING_KEY, openrouterKey } from "../key";
import type { JobContext } from "../jobs";
import { rel, transcriptDir } from "../library";
import { fmt, openrouter, pool, probeDuration, run, sleep } from "../lib";
import { alignChunk, splitLong, type TimedSegment, type Word } from "./align";
import { visionTranscript } from "./vision";

export type TranscribeInput = {
  video: string; model?: string; chunk_seconds?: number; workers?: number;
  /** Word timings from a speech-to-text model (default on). false keeps Gemini's estimated times. */
  timing?: boolean;
  /** Vision transcript of what's on screen (default on). */
  vision?: boolean;
};

const PROMPT = (dur: number) => `Transcribe this ${dur}-second audio clip verbatim in its original language (do not translate).
Keep dialect and wording exactly as spoken. Split into short segments of one sentence or phrase each.
"start" is the number of seconds from the beginning of THIS clip (0 to ${dur}) where the segment begins.
Cover the whole clip from start to end. Never repeat a segment. If there is no speech, return an empty list.`;

const SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "transcript",
    strict: true,
    schema: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          items: {
            type: "object",
            properties: { start: { type: "number" }, text: { type: "string" } },
            required: ["start", "text"],
            additionalProperties: false,
          },
        },
      },
      required: ["segments"],
      additionalProperties: false,
    },
  },
};

type ChunkSeg = { start: number; text: string };

/** Return why the model output looks broken, or null if it's usable. */
function validate(segs: ChunkSeg[], dur: number): string | null {
  if (!segs.length) return dur < 5 ? null : "empty";
  const texts = segs.map((s) => s.text.trim());
  if (new Set(texts).size < 0.8 * texts.length) return "repetition loop";
  if (segs.some((s) => s.start < 0 || s.start > dur + 3)) return "timestamp out of range";
  if (Math.max(...texts.map((t) => t.length)) > 600) return "segment too long";
  if (segs.length > 3 && segs[segs.length - 1].start < 0.5 * dur) return "does not cover clip";
  return null;
}

async function splitAudio(ctx: JobContext, video: string, dir: string, chunkSeconds: number) {
  mkdirSync(dir, { recursive: true });
  const list = () => readdirSync(dir).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort().map((f) => join(dir, f));
  if (list().length) {
    ctx.log(`Reusing ${list().length} cached audio chunks`);
    return list();
  }
  ctx.progress(0.01, "extracting audio");
  ctx.log(`Extracting audio into ${chunkSeconds}s chunks`);
  const r = await run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", video,
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k",
    "-f", "segment", "-segment_time", String(chunkSeconds), "-reset_timestamps", "1",
    join(dir, "chunk_%03d.mp3"),
  ], { signal: ctx.signal });
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(0, 400)}`);
  return list();
}

async function transcribeChunk(ctx: JobContext, chunk: string, model: string, retries = 4): Promise<ChunkSeg[]> {
  const name = chunk.split(/[\\/]/).pop();
  const cache = chunk.replace(/\.mp3$/, ".json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));

  const dur = await probeDuration(chunk);
  const audio = Buffer.from(await Bun.file(chunk).arrayBuffer()).toString("base64");
  let best: ChunkSeg[] | null = null;
  let lastErr = "";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await openrouter(
        {
          temperature: attempt === 1 ? 0 : 0.3,
          response_format: SCHEMA,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: PROMPT(Math.round(dur)) },
              { type: "input_audio", input_audio: { data: audio, format: "mp3" } },
            ],
          }],
        },
        model,
        ctx.signal,
      );
      ctx.addCost(res.usage?.cost);
      const raw = res.content.trim().replace(/^```json/, "").replace(/```$/, "");
      const segs = (JSON.parse(raw || "{}").segments ?? [])
        .filter((s: any) => String(s.text ?? "").trim())
        .map((s: any) => ({ start: Number(s.start), text: String(s.text).trim() }))
        .sort((a: ChunkSeg, b: ChunkSeg) => a.start - b.start);
      const problem = validate(segs, dur);
      if (!problem) {
        writeFileSync(cache, JSON.stringify(segs, null, 1), "utf8");
        ctx.log(`${name}: ${segs.length} segments`);
        return segs;
      }
      lastErr = problem;
      ctx.log(`${name} attempt ${attempt}: bad output (${problem}), retrying`, "warn");
      if (problem !== "repetition loop") best = segs;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      lastErr = e instanceof Error ? e.message : String(e);
      ctx.log(`${name} attempt ${attempt} failed: ${lastErr}`, "warn");
      await sleep(3000 * attempt, ctx.signal);
    }
  }
  if (best) {
    ctx.log(`${name}: keeping imperfect output (${lastErr})`, "warn");
    return best;
  }
  ctx.log(`${name}: giving up (${lastErr})`, "error");
  return [];
}

/** Word-level timings for one chunk from a speech-to-text model. Cached next to the chunk. */
export async function timeChunk(ctx: JobContext, chunk: string, retries = 3): Promise<Word[]> {
  const cache = chunk.replace(/\.mp3$/, ".words.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8"));
  let last: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    ctx.signal.throwIfAborted();
    try {
      const form = new FormData();
      form.append("file", Bun.file(chunk), chunk.split(/[\\/]/).pop());
      form.append("model", MODELS.timing);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openrouterKey() || (() => { throw new Error(MISSING_KEY); })()}` },
        body: form,
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(300_000)]),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok || !Array.isArray(data.words)) throw new Error(`timing HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      ctx.addCost(data.usage?.cost);
      const words: Word[] = data.words.map((w: any) => ({ w: String(w.word ?? "").trim(), start: Number(w.start), end: Number(w.end) }));
      writeFileSync(cache, JSON.stringify(words), "utf8");
      return words;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      last = e;
      await sleep(2000 * attempt, ctx.signal);
    }
  }
  throw last;
}

const ms = (t: number) => Math.round(t * 1000) / 1000;

function readTranscriptFile(dir: string): unknown[] | null {
  const f = join(dir, "transcript.json");
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

export async function transcribe(ctx: JobContext, video: string, input: TranscribeInput) {
  const model = input.model ?? MODELS.transcribe;
  const chunkSeconds = input.chunk_seconds ?? 120;
  const total = await probeDuration(video);
  const outDir = transcriptDir(video);
  const chunks = await splitAudio(ctx, video, join(outDir, `chunks_${chunkSeconds}s`), chunkSeconds);

  ctx.log(`Transcribing ${chunks.length} chunks with ${model}`);
  let done = 0;
  ctx.progress(0.05, `transcribing 0/${chunks.length}`);
  const results = await pool(chunks, input.workers ?? 6, async (c) => {
    const segs = await transcribeChunk(ctx, c, model);
    done++;
    ctx.progress(0.05 + 0.55 * (done / chunks.length), `transcribing ${done}/${chunks.length}`);
    return segs;
  }, ctx.signal);

  // Timing pass: real word times from speech-to-text, then Gemini's words aligned onto them.
  const timing = input.timing !== false;
  let aligned = 0;
  const perChunk: TimedSegment[][] = [];
  if (timing) {
    ctx.log(`Measuring word timings with ${MODELS.timing}`);
    done = 0;
    const timed = await pool(chunks, input.workers ?? 6, async (c, i) => {
      const words = await timeChunk(ctx, c).catch((e) => {
        if (ctx.signal.aborted) throw e;
        ctx.log(`chunk ${i}: no word timings (${e instanceof Error ? e.message : e}); keeping estimated times`, "warn");
        return [] as Word[];
      });
      ctx.progress(0.6 + 0.15 * (++done / chunks.length), `timing ${done}/${chunks.length}`);
      return words;
    }, ctx.signal);
    results.forEach((chunkSegs, i) => {
      const dur = Math.min(chunkSeconds, total - i * chunkSeconds);
      const a = alignChunk(chunkSegs, timed[i], dur);
      if (a) {
        aligned++;
        perChunk[i] = a.segments.flatMap((s) => splitLong(s));
        ctx.log(`chunk ${i}: ${Math.round(a.matchRate * 100)}% of words aligned`);
      } else if (chunkSegs.length) {
        ctx.log(`chunk ${i}: too few words matched; keeping estimated times`, "warn");
      }
    });
  }

  const segments: TimedSegment[] = [];
  results.forEach((chunkSegs, i) => {
    const offset = i * chunkSeconds;
    const chunkEnd = Math.min(offset + chunkSeconds, total);
    if (perChunk[i]) {
      for (const s of perChunk[i]) {
        // An aligned chunk can still have lines kept as estimates (too slow for their words, e.g. a song).
        segments.push(s.words?.length
          ? {
              start: ms(offset + s.start), end: ms(offset + s.end), text: s.text, timing: "aligned",
              words: s.words.map((w) => ({ w: w.w, start: ms(offset + w.start), end: ms(offset + w.end) })),
            }
          : { start: ms(offset + s.start), end: 0, text: s.text, timing: "estimated" });
      }
    } else {
      for (const s of chunkSegs) segments.push({ start: Math.min(offset + s.start, chunkEnd), end: 0, text: s.text, timing: "estimated" });
    }
  });
  // Estimated segments have no end of their own: run to the next line, capped.
  segments.forEach((s, n) => {
    if (s.timing === "aligned") return;
    const next = n + 1 < segments.length ? segments[n + 1].start : total;
    s.end = ms(Math.max(Math.min(next, s.start + 12), s.start + 1));
    s.start = ms(s.start);
  });

  writeFileSync(join(outDir, "transcript.json"), JSON.stringify(segments), "utf8");
  writeFileSync(join(outDir, "transcript.txt"), segments.map((s) => `[${fmt(s.start, "srt").replace(",", ".")}] ${s.text}`).join("\n"), "utf8");
  writeFileSync(
    join(outDir, "transcript.srt"),
    segments.map((s, n) => `${n + 1}\n${fmt(s.start, "srt")} --> ${fmt(s.end, "srt")}\n${s.text}\n`).join("\n"),
    "utf8",
  );
  const alignedShare = segments.filter((s) => s.timing === "aligned").length / Math.max(1, segments.length);
  ctx.log(`Wrote ${segments.length} segments; ${Math.round(alignedShare * 100)}% have measured word timings (${aligned}/${chunks.length} chunks)`);

  // Vision transcript: what's on screen, shot by shot. A failure here keeps the audio transcript.
  let vision: { shots: number; labelled: number } | { error: string } | undefined;
  if (input.vision !== false) {
    try {
      const vt = await visionTranscript({ ...ctx, progress: (v, stage) => ctx.progress(0.75 + 0.24 * v, stage && `vision: ${stage}`) }, video);
      vision = { shots: vt.shots.length, labelled: vt.shots.filter((s) => s.kind).length };
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      vision = { error: e instanceof Error ? e.message : String(e) };
      ctx.log(`Vision transcript failed: ${vision.error}`, "warn");
    }
  }
  return {
    segments: segments.length,
    timing: { aligned_chunks: aligned, chunks: chunks.length, aligned_share: +alignedShare.toFixed(2) },
    vision,
    duration_s: Math.round(total),
    transcript: rel(join(outDir, "transcript.json")),
    empty_chunks: results.map((r, i) => (r.length ? -1 : i)).filter((i) => i >= 0),
  };
}
