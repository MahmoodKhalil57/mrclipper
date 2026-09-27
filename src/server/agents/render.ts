// Step 4c · Render (code). ffmpeg renders each clip's edit in one run (effects/compile.ts): per-shot
// framing with face tracking, camera moves, transitions, effects, overlays, sounds and music, the take's
// colour and finishing, captions and the hook card. It runs automatically in the workflow; you review the
// finished files afterwards.
//
// render.json remembers what each file was rendered from (a hash of the clip's edit, plus the effects and
// asset files it uses), so only clips whose edit changed (you nudged an edge, Design ran again, you edited an
// effect or replaced a file in assets/) are rendered again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { ROOT } from "../config";
import type { JobContext } from "../jobs";
import { OUTLINE_FILE, readClipData, readText, readTranscript, rel, runDir, type ClipData } from "../library";
import { fmt, measureLoudness, run, type Segment } from "../lib";
import { droppedClips } from "../review";
import { assetsFingerprint, listAssets, measureAssets, type Asset } from "../effects/assets";
import { effectsFingerprint, loadCatalog } from "../effects/catalog";
import { BITRATE_CAP, compileEdit, editDeps } from "../effects/compile";
import { scoreFor } from "../effects/music";
import { rtl } from "../effects/template";
import { framingParts, takeStyle, type EditStyle } from "./edit";
import { probeAspect } from "./framing";
import { hashText } from "./text";
import { trackEdit } from "./track";
import { readVision } from "./vision";

type Clip = ClipData["clips"][number];
export type RenderManifest = { clips: Record<string, { hash: string; mtime: number; at: number }> };

const pad2 = (id: number) => String(id).padStart(2, "0");
const manifestPath = (runId: string) => join(runDir(runId), "render.json");

export function readManifest(runId: string): RenderManifest {
  try {
    return existsSync(manifestPath(runId)) ? JSON.parse(readFileSync(manifestPath(runId), "utf8")) : { clips: {} };
  } catch {
    return { clips: {} };
  }
}

/** What a clip's file depends on: its edges, its edit and the take's style, and the definitions of the
 *  effects and the asset files it uses (edits made before the effects library hash as they always did). */
export function editHash(c: Clip, style: EditStyle | undefined, assets: Asset[] = listAssets(), score?: string) {
  const base = { s: c.start, e: c.end, edit: c.edit ?? null, style: style ?? null };
  const deps = c.edit?.segments?.length && c.edit.enabled !== false ? editDeps(c.edit, loadCatalog(), assets) : null;
  const extra = { ...(deps?.library ? { fx: effectsFingerprint(deps.defs), files: assetsFingerprint(deps.assets) } : {}), ...(score ? { score, mix: MIX_VERSION } : {}) };
  return hashText(JSON.stringify(Object.keys(extra).length ? { ...base, ...extra } : base));
}

/** Bump when the mix changes (levels, cleanup, mastering), so clips with scores are mixed again. */
const MIX_VERSION = 2;

/** Dialogue level: the voice is brought here before mixing, so music and sounds sit against a known level. */
const VOICE_LUFS = -18;

/** The loudness of a clip's voice over the parts it plays, from the source (energy-weighted across parts). */
async function voiceLoudness(video: string, parts: { start: number; end: number }[], signal: AbortSignal): Promise<number | null> {
  let energy = 0, seconds = 0;
  for (const p of parts) {
    const l = await measureLoudness(video, { ss: p.start, t: p.end - p.start, signal }).catch(() => null);
    if (l === null) continue;
    energy += (p.end - p.start) * Math.pow(10, l / 10);
    seconds += p.end - p.start;
  }
  return seconds ? 10 * Math.log10(energy / seconds) : null;
}

/**
 * Mastering: the finished clip brought to the outline's loudness with ONE gain, measured over the whole
 * clip, and a limiter to hold peaks near -2 dB. (A loudness filter that adapts as it goes lifted every
 * pause, and the recording's hiss with it.) The video is copied; only the audio is encoded again.
 */
async function master(ctx: JobContext, file: string, target: number | null | undefined) {
  if (target === null) return null;
  const want = target ?? -14;
  const now = await measureLoudness(file, { signal: ctx.signal });
  if (now === null) return null;
  const gain = Math.max(-12, Math.min(20, want - now));
  if (Math.abs(gain) < 0.3) return { now, gain: 0 };
  const tmp = file.replace(/\.mp4$/, ".mastered.mp4");
  const r = await run([
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", file, "-map", "0:v", "-map", "0:a", "-c:v", "copy",
    "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.794:attack=4:release=80:level=0,aresample=48000`,
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp,
  ], { signal: ctx.signal });
  if (r.code !== 0) {
    ctx.log(`Mastering skipped: ${r.stderr.slice(-200)}`, "warn");
    rmSync(tmp, { force: true });
    return null;
  }
  try {
    rmSync(file, { force: true });
    renameSync(tmp, file);
  } catch (e) {
    ctx.log(`Couldn't replace the clip with its mastered version (is it open somewhere?): ${e instanceof Error ? e.message : e}`, "warn");
    return null;
  }
  return { now, gain };
}

/** Per clip: rendered from its current edit, rendered from an older one, or not rendered. Dropped clips don't need a file. */
export function renderStatus(runId: string) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const m = readManifest(runId);
  const dropped = new Set(droppedClips(runId));
  const scriptTime = statSync(join(dir, "clip_script.md")).mtimeMs;
  const assets = listAssets();
  const clips = data.clips.map((c) => {
    const file = join(dir, `clip_${pad2(c.id)}.mp4`);
    const has = existsSync(file);
    const entry = m.clips[c.id];
    // Takes rendered before render.json existed: a file newer than the clip data counts as current.
    const fresh = has && (entry ? entry.hash === editHash(c, data.edit_style, assets, scoreFor(runId, c.id)?.key) && Math.round(statSync(file).mtimeMs) === entry.mtime : statSync(file).mtimeMs >= scriptTime - 2000);
    return { id: c.id, file: has ? rel(file) : null, fresh, dropped: dropped.has(c.id) };
  });
  const needed = clips.filter((c) => !c.dropped);
  return { clips, missing: needed.filter((c) => !c.file).map((c) => c.id), stale: needed.filter((c) => c.file && !c.fresh).map((c) => c.id), total: needed.length };
}

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

function appendHistory(file: string, runId: string, video: string, done: { clip: Clip; out: string }[]) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file)
    ? []
    : ["# Clip history", "", "One entry per rendered take. Fill in **Performance** after posting; the Coach reads this file.", ""];
  const d = new Date();
  const stamp = `${d.toISOString().slice(0, 10)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  lines.push(`## ${stamp}: ${parse(video).name}`, "", `Take: \`clips/${runId}\``, "");
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

export type RenderInput = { run: string; only?: number[]; force?: boolean };

export async function renderTake(ctx: JobContext, input: RenderInput) {
  const dir = runDir(input.run);
  const data = readClipData(join(dir, "clip_script.md"));
  if (!existsSync(data.video)) throw new Error(`Source video not found: ${data.video}`);
  const vertical = data.aspect === "9:16";
  const status = renderStatus(input.run);
  // An explicit `only` wins; otherwise every kept clip whose file is missing or older than its edit.
  const wanted = new Set(input.only?.length ? input.only : input.force ? status.clips.filter((c) => !c.dropped).map((c) => c.id) : [...status.missing, ...status.stale]);
  const clips = data.clips.filter((c) => wanted.has(c.id));
  if (!clips.length) {
    ctx.log("Every kept clip is already rendered from its current edit");
    return { run: input.run, rendered: [], failed: [] };
  }
  ctx.log(`Rendering ${clips.length} clip(s)${vertical ? " as 9:16" : ""}`);
  // The take's frozen settings, plus any added since it was made (loudness…), from the outline it was made with.
  const style: EditStyle = takeStyle(readText(join(dir, "outline.md")) || readText(OUTLINE_FILE), data.edit_style);
  const allSegs = readTranscript(data.video) ?? [];
  const vt = readVision(data.video);
  const aspect = await probeAspect(data.video);
  const catalog = loadCatalog();
  const assets = await measureAssets(listAssets());
  const manifest = readManifest(input.run);
  const firstTime: { clip: Clip; out: string }[] = [];
  const done: number[] = [];
  const failed: number[] = [];

  for (const [i, c] of clips.entries()) {
    const id2 = pad2(c.id);
    const base = i / clips.length;
    const out = join(dir, `clip_${id2}.mp4`);
    let ok = false;

    if (c.edit && c.edit.enabled !== false && c.edit.segments?.length) {
      // Creative edit: parts, transitions, effects, overlays, sounds, captions and a hook card.
      // Follow faces through each shot so people who walk around stay in the 9:16 window.
      const tracked = vertical && style.reframe
        ? await trackEdit(ctx, data.video, join(dir, "track"), c.edit, aspect, (a, b) => framingParts(vt, a, b)).catch((e) => {
            if (ctx.signal.aborted) throw e;
            ctx.log(`Clip ${c.id}: face tracking skipped (${e instanceof Error ? e.message : e})`, "warn");
            return null;
          })
        : null;
      // The voice to dialogue level first, so music and sounds are mixed against a known level.
      const voice = await voiceLoudness(data.video, c.edit.segments, ctx.signal);
      const voiceGain = voice === null ? 0 : Math.max(-8, Math.min(24, VOICE_LUFS - voice));
      const score = scoreFor(input.run, c.id);
      const r0 = compileEdit({
        edit: c.edit, style, video: data.video, vertical, aspect, vt, tracked: tracked?.parts, segs: allSegs,
        catalog, assets, dir, name: `clip_${id2}`, out: `clip_${id2}.mp4`, voiceGain,
        ...(score ? { score: { file: score.file, lufs: score.lufs, seconds: score.seconds } } : {}),
      });
      for (const [name, text] of Object.entries(r0.files)) writeFileSync(join(dir, name), text, "utf8");
      const n = r0.counts;
      const extras = [n.video && `${n.video} video effect${n.video > 1 ? "s" : ""}`, n.overlays && `${n.overlays} overlay${n.overlays > 1 ? "s" : ""}`, n.text && `${n.text} text`, n.sounds && `${n.sounds} sound${n.sounds > 1 ? "s" : ""}`, n.voice && `${n.voice} voice effect${n.voice > 1 ? "s" : ""}`, n.music && "music"].filter(Boolean);
      ctx.log(`Clip ${c.id} "${c.title}": ${n.parts} parts, ${n.joins} transitions${extras.length ? `, ${extras.join(", ")}` : ""}${score ? ` (its own score: ${r0.fit})` : ""}, ${r0.duration.toFixed(1)}s${tracked ? `; crop follows faces in ${tracked.moving} of ${tracked.total} shot parts` : ""}; voice ${voice === null ? "not measured" : `${voice.toFixed(1)} LUFS, ${voiceGain >= 0 ? "+" : ""}${voiceGain.toFixed(1)} dB`}`);
      for (const note of r0.notes) ctx.log(`Clip ${c.id}: ${note}`, "warn");
      const r = await run(r0.args, {
        cwd: dir,
        signal: ctx.signal,
        onStdout: (line) => {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m) ctx.progress(base + Math.min(Number(m[1]) / 1e6 / r0.duration, 1) / clips.length, `rendering clip ${c.id} (${i + 1}/${clips.length})`);
        },
      });
      ok = r.code === 0;
      if (!ok) ctx.log(`ffmpeg failed for clip ${c.id}: ${r.stderr.slice(-400)}`, "error");
    } else {
      // The plain cut: the clip's range, a centred crop and simple captions.
      const start = Math.max(c.start - 0.3, 0);
      const end = c.end + 0.3;
      const dur = end - start;
      const filters: string[] = [];
      if (vertical) filters.push("crop=trunc(ih*9/16/2)*2:ih,scale=1080:1920");
      if (style.captions !== "none") {
        const srt = join(dir, `clip_${id2}.srt`);
        if (writeSrt(allSegs, start, end, srt)) {
          // Segoe UI: Arial Bold on Windows lacks the lam-alef ligature glyph. Relative filename + cwd avoids filter escaping.
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
        "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", ...BITRATE_CAP,
        "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", `clip_${id2}.mp4`,
      ];
      ctx.log(`Clip ${c.id} "${c.title}": plain cut ${fmt(start)} to ${fmt(end)}`);
      const r = await run(cmd, {
        cwd: dir,
        signal: ctx.signal,
        onStdout: (line) => {
          const m = line.match(/^out_time_us=(\d+)/);
          if (m) ctx.progress(base + Math.min(Number(m[1]) / 1e6 / dur, 1) / clips.length, `rendering clip ${c.id} (${i + 1}/${clips.length})`);
        },
      });
      ok = r.code === 0;
      if (!ok) ctx.log(`ffmpeg failed for clip ${c.id}: ${r.stderr.slice(0, 300)}`, "error");
    }

    if (!ok) {
      failed.push(c.id);
      continue;
    }
    if (!manifest.clips[c.id]) firstTime.push({ clip: c, out });
    const m = await master(ctx, out, style.loudness);
    if (m && m.gain) ctx.log(`Clip ${c.id}: mastered from ${m.now.toFixed(1)} to ${(style.loudness ?? -14)} LUFS (${m.gain >= 0 ? "+" : ""}${m.gain.toFixed(1)} dB)`);
    manifest.clips[c.id] = { hash: editHash(c, data.edit_style, assets, scoreFor(input.run, c.id)?.key), mtime: Math.round(statSync(out).mtimeMs), at: Date.now() };
    writeFileSync(manifestPath(input.run), JSON.stringify(manifest, null, 1), "utf8");
    done.push(c.id);
  }

  if (firstTime.length) {
    const hist = join(ROOT, data.history_file || "clips/history.md");
    appendHistory(hist, input.run, data.video, firstTime);
    ctx.log(`Logged ${firstTime.length} new clip(s) to ${rel(hist)}`);
  }
  if (!done.length) throw new Error(`Every clip failed to render: ${failed.join(", ")}`);
  return { run: input.run, rendered: done, failed };
}
