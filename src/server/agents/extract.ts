import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { ROOT } from "../config";
import type { JobContext } from "../jobs";
import { OUTLINE_FILE, readClipData, readText, readTranscript, rel, runDir, type ClipData } from "../library";
import { buildAss, buildRender, framingParts, readEditStyle, rtl } from "./edit";
import { trackEdit } from "./track";
import { probeAspect } from "./framing";
import { readVision } from "./vision";
import { fmt, run, type Segment } from "../lib";
import { droppedClips } from "../review";

export type ExtractInput = { run: string; only?: number[]; subs?: boolean; vertical?: boolean; pad?: number; log_history?: boolean };

/**
 * Break a segment into short captions. With measured word times each caption spans exactly its words
 * (and a pause of 0.45s+ starts a new caption); otherwise time by share of characters.
 */
function splitCaption(s: Segment, maxWords: number): Segment[] {
  if (s.words?.length) {
    const out: Segment[] = [];
    let cur: NonNullable<Segment["words"]> = [];
    const flush = () => {
      if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.w).join(" ") });
      cur = [];
    };
    for (const w of s.words) {
      const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
      if (cur.length >= maxWords || gap > 0.45) flush();
      cur.push(w);
    }
    flush();
    return out;
  }
  const words = s.text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(" "));
  const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
  let t = s.start;
  return chunks.map((c) => {
    const d = ((s.end - s.start) * c.length) / totalChars;
    const out = { start: t, end: t + d, text: c };
    t += d;
    return out;
  });
}

function writeSrt(segs: Segment[], start: number, end: number, path: string, maxWords = 6): boolean {
  const entries: string[] = [];
  for (const seg of segs) {
    for (const s of splitCaption(seg, maxWords)) {
      if (s.start < end && s.end > start && s.text) {
        const a = Math.max(s.start, start) - start;
        const b = Math.min(s.end, end) - start;
        entries.push(`${entries.length + 1}\n${fmt(a, "srt")} --> ${fmt(b, "srt")}\n${rtl(s.text)}\n`);
      }
    }
  }
  writeFileSync(path, entries.join("\n"), "utf8");
  return entries.length > 0;
}

function appendHistory(file: string, script: string, video: string, done: { clip: ClipData["clips"][number]; out: string }[]) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file)
    ? []
    : ["# Clip history", "", "One entry per extraction run. Fill in **Performance** after posting; the plan agent reads this file.", ""];
  const d = new Date();
  const stamp = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  lines.push(`## ${stamp}: ${parse(video).name}`, "", `Script: \`${rel(script)}\``, "");
  for (const { clip: c, out } of done) {
    lines.push(
      `### Clip ${c.id}: ${c.title}`,
      `- Range: ${fmt(c.start)} to ${fmt(c.end)} (${Math.round(c.end - c.start)}s)`,
      `- File: \`${rel(out)}\``,
      `- Why chosen: ${c.reason ?? ""}`,
      "- Performance: _(views, retention, comments, what worked or didn't)_",
      "",
    );
  }
  appendFileSync(file, lines.join("\n") + "\n", "utf8");
}

export async function extractClips(ctx: JobContext, input: ExtractInput) {
  const dir = runDir(input.run);
  const script = join(dir, "clip_script.md");
  const data = readClipData(script);
  if (!existsSync(data.video)) throw new Error(`Source video not found: ${data.video}`);
  const vertical = input.vertical ?? data.aspect === "9:16";
  const pad = input.pad ?? 0.3;
  const segs = input.subs ? (readTranscript(data.video) ?? []) : [];
  // An explicit `only` wins; otherwise skip the clips the user dropped in review.
  const dropped = input.only?.length ? [] : droppedClips(input.run);
  const clips = data.clips.filter((c) => (input.only?.length ? input.only.includes(c.id) : !dropped.includes(c.id)));
  if (dropped.length) ctx.log(`Skipping clips you dropped: ${dropped.join(", ")}`);
  if (!clips.length) throw new Error(`No clips matched ${JSON.stringify(input.only)}`);

  ctx.log(`Cutting ${clips.length} clip(s)${vertical ? " as 9:16" : ""}${input.subs ? " with captions" : ""}`);
  const done: { clip: (typeof clips)[number]; out: string }[] = [];
  const failed: number[] = [];

  // Cut with the style the take was planned with; takes from before snapshots fall back to the outline.
  const style = data.edit_style ?? readEditStyle(readText(OUTLINE_FILE));
  const allSegs = readTranscript(data.video) ?? [];
  // Shot cuts and measured faces drive the per-shot 9:16 framing.
  const vt = readVision(data.video);
  const aspect = await probeAspect(data.video);

  for (const [i, c] of clips.entries()) {
    const id2 = String(c.id).padStart(2, "0");
    const base = i / clips.length;

    // Creative edit: multi-segment EDL with transitions, effects, karaoke captions and a title card.
    if (c.edit && c.edit.enabled !== false && c.edit.segments?.length) {
      const ass = input.subs !== false || c.edit.title ? `clip_${id2}.ass` : null;
      const styleForClip = input.subs === false ? { ...style, captions: "none" as const } : style;
      if (ass) writeFileSync(join(dir, ass), buildAss(c.edit, allSegs, styleForClip, vertical), "utf8");
      // Follow faces through each shot so people who walk around stay in the 9:16 window.
      const tracked = vertical && styleForClip.reframe
        ? await trackEdit(ctx, data.video, join(dir, "track"), c.edit, aspect, (a, b) => framingParts(vt, a, b)).catch((e) => {
            if (ctx.signal.aborted) throw e;
            ctx.log(`Clip ${c.id}: face tracking skipped (${e instanceof Error ? e.message : e})`, "warn");
            return null;
          })
        : null;
      if (tracked) ctx.log(`Clip ${c.id}: tracked faces in ${tracked.total} shot part(s); the crop follows the subject in ${tracked.moving}`);
      const r0 = buildRender(c.edit, styleForClip, data.video, vertical, ass, `clip_${id2}.mp4`, vt, aspect, tracked?.parts);
      ctx.log(`Clip ${c.id} "${c.title}": ${c.edit.segments.length} segments, ${c.edit.transitions.filter((t) => t !== "cut").length} transitions, ${r0.duration.toFixed(1)}s`);
      const r = await run(r0.args, {
        cwd: dir,
        signal: ctx.signal,
        onStdout: (line) => {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m) ctx.progress(base + Math.min(Number(m[1]) / 1e6 / r0.duration, 1) / clips.length, `editing clip ${c.id} (${i + 1}/${clips.length})`);
        },
      });
      if (r.code !== 0) {
        ctx.log(`ffmpeg failed for clip ${c.id}: ${r.stderr.slice(-400)}`, "error");
        failed.push(c.id);
        continue;
      }
      done.push({ clip: c, out: join(dir, `clip_${id2}.mp4`) });
      continue;
    }

    const start = Math.max(c.start - pad, 0);
    const end = c.end + pad;
    const dur = end - start;
    const out = join(dir, `clip_${id2}.mp4`);
    const filters: string[] = [];
    if (vertical) filters.push("crop=trunc(ih*9/16/2)*2:ih,scale=1080:1920");
    if (input.subs) {
      const srt = join(dir, `clip_${id2}.srt`);
      if (writeSrt(segs, start, end, srt)) {
        // Segoe UI: Arial Bold on Windows lacks the lam-alef ligature glyph.
        // Relative filename + cwd=dir avoids ffmpeg filter escaping of Windows paths.
        filters.push(
          `subtitles=clip_${id2}.srt:force_style='FontName=Segoe UI,FontSize=${vertical ? 16 : 20},Bold=1,` +
            `PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=${vertical ? 70 : 30},Encoding=-1'`,
        );
      }
    }
    const cmd = [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats",
      "-ss", start.toFixed(2), "-i", data.video, "-t", dur.toFixed(2),
      ...(filters.length ? ["-vf", filters.join(",")] : []),
      "-c:v", "libx264", "-crf", "20", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", `clip_${id2}.mp4`,
    ];
    ctx.log(`Clip ${c.id} "${c.title}": ${fmt(start)} to ${fmt(end)}`);
    const r = await run(cmd, {
      cwd: dir,
      signal: ctx.signal,
      onStdout: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m) ctx.progress(base + Math.min(Number(m[1]) / 1e6 / dur, 1) / clips.length, `cutting clip ${c.id} (${i + 1}/${clips.length})`);
      },
    });
    if (r.code !== 0) {
      ctx.log(`ffmpeg failed for clip ${c.id}: ${r.stderr.slice(0, 300)}`, "error");
      failed.push(c.id);
      continue;
    }
    done.push({ clip: c, out });
  }

  if (done.length && input.log_history !== false) {
    const hist = join(ROOT, data.history_file || "clips/history.md");
    appendHistory(hist, script, data.video, done);
    ctx.log(`Logged ${done.length} clip(s) to ${rel(hist)}`);
  }
  if (!done.length) throw new Error("All clips failed");
  return { run: input.run, files: done.map((d) => rel(d.out)), failed };
}
