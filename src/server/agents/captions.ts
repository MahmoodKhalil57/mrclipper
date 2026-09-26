// Deterministic audio transcript for WebMCP mode: YouTube's own captions, fetched with yt-dlp.
// No hosted model is involved. json3 captions carry a start offset per word, so lines get measured
// word timings just like the Gemini+Whisper path.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { ROOT } from "../config";
import type { JobContext } from "../jobs";
import { transcriptDir } from "../library";
import { run } from "../lib";
import type { TimedSegment, Word } from "./align";

const ms = (t: number) => Math.round(t * 1000) / 1000;

/** The YouTube id from a yt-dlp style file name: "Title [czG1UOdf9yU].mp4". */
export const youtubeId = (video: string) => parse(video).name.match(/\[([\w-]{11})\]\s*$/)?.[1] ?? null;

async function fetchCaptions(ctx: JobContext, video: string, lang: string): Promise<string> {
  const dir = transcriptDir(video);
  const existing = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith("captions.") && f.endsWith(".json3")) : undefined;
  if (existing) return join(dir, existing);
  const id = youtubeId(video);
  if (!id) throw new Error("No YouTube id in the file name, so there are no captions to import. Name it like 'Title [VIDEOID].mp4' or use another engine to transcribe.");
  const bundled = join(ROOT, "tools", "yt-dlp.exe");
  ctx.log(`Fetching YouTube captions for ${id} (${lang})`);
  const r = await run(
    [existsSync(bundled) ? bundled : "yt-dlp", "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", `${lang},${lang}-orig`,
      "--sub-format", "json3", "-o", join(dir, "captions"), `https://www.youtube.com/watch?v=${id}`],
    { signal: ctx.signal },
  );
  const got = readdirSync(dir).find((f) => f.startsWith("captions.") && f.endsWith(".json3"));
  if (!got) throw new Error(`YouTube has no ${lang} captions for this video (${(r.stderr || r.stdout).slice(-200)})`);
  return join(dir, got);
}

/** json3 events → timed words → sentence-sized lines (split on pauses and length; captions have no punctuation). */
export function captionsToSegments(json3: any, maxSeconds = 7, maxWords = 14, pause = 0.6): TimedSegment[] {
  const words: Word[] = [];
  for (const e of json3.events ?? []) {
    if (!e.segs) continue;
    const segs = e.segs.filter((s: any) => String(s.utf8 ?? "").trim());
    segs.forEach((s: any, i: number) => {
      const start = (e.tStartMs + (s.tOffsetMs ?? 0)) / 1000;
      const next = segs[i + 1];
      const end = next ? (e.tStartMs + (next.tOffsetMs ?? 0)) / 1000 : (e.tStartMs + (e.dDurationMs ?? 0)) / 1000;
      for (const w of String(s.utf8).trim().split(/\s+/)) words.push({ w, start, end: Math.max(end, start + 0.05) });
    });
  }
  words.sort((a, b) => a.start - b.start);
  // Caption words overlap the next word's start; clamp so each word ends where the next begins.
  words.forEach((w, i) => {
    const n = words[i + 1];
    if (n && w.end > n.start) w.end = Math.max(w.start + 0.05, n.start);
  });

  const out: TimedSegment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      start: ms(cur[0].start), end: ms(cur[cur.length - 1].end), text: cur.map((w) => w.w).join(" "), timing: "aligned",
      words: cur.map((w) => ({ w: w.w, start: ms(w.start), end: ms(w.end) })),
    });
    cur = [];
  };
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last && (w.start - last.end > pause || w.end - cur[0].start > maxSeconds || cur.length >= maxWords)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

export async function transcriptFromCaptions(ctx: JobContext, video: string, lang = process.env.CAPTION_LANG ?? "ar") {
  const file = await fetchCaptions(ctx, video, lang);
  const segs = captionsToSegments(JSON.parse(readFileSync(file, "utf8")));
  if (!segs.length) throw new Error("The captions file had no words");
  writeFileSync(join(transcriptDir(video), "source.json"), JSON.stringify({ audio: "youtube-captions", file: parse(file).base }), "utf8");
  ctx.log(`Built ${segs.length} lines from ${segs.reduce((n, s) => n + (s.words?.length ?? 0), 0)} caption words`);
  return segs;
}
