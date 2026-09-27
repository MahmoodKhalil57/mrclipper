import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, parse, relative, resolve, sep } from "node:path";
import { ROOT, VIDEOS_DIR, VIDEO_EXTS } from "./config";
import { probeDuration, type Segment } from "./lib";
import { readVision } from "./agents/vision";

export const OUTLINE_FILE = join(ROOT, "clip_outline.md");
export const CLIPS_DIR = join(ROOT, "clips");
export const TRANSCRIPTS_DIR = join(ROOT, "transcripts");

export const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
/** A path as stored in the workspace's own files: relative when it's inside the workspace, so the workspace can move. */
const stored = (p: string) => (resolve(ROOT, p).startsWith(ROOT + sep) ? rel(resolve(ROOT, p)) : p);

/** Resolve a user-supplied path inside ROOT, refusing anything that escapes it. */
export function safePath(p: string): string {
  const full = resolve(ROOT, p);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) throw new Error(`Path escapes project: ${p}`);
  return full;
}

export type ClipData = {
  video: string;
  transcript: string;
  aspect: string;
  history_file: string;
  /** The outline's editing settings, snapshotted when the take was planned. The Editor cuts from this. */
  edit_style?: import("./agents/edit").EditStyle;
  clips: { id: number; title: string; start: number; end: number; on_screen_text?: string; reason?: string; edit?: import("./agents/edit").Edit }[];
};

const durationCache = new Map<string, { mtime: number; duration: number }>();

async function cachedDuration(path: string) {
  const mtime = statSync(path).mtimeMs;
  const hit = durationCache.get(path);
  if (hit && hit.mtime === mtime) return hit.duration;
  const duration = await probeDuration(path).catch(() => 0);
  durationCache.set(path, { mtime, duration });
  return duration;
}

/** One entry per file name: transcripts and takes are keyed by the name, so a copy elsewhere is the same video.
 *  New videos go to videos/; older workspaces also keep them at the top level and in downloads/. */
function videoFiles(): string[] {
  const dirs = [VIDEOS_DIR, ROOT, join(ROOT, "downloads")];
  const seen = new Set<string>();
  return dirs.flatMap((d) =>
    existsSync(d)
      ? readdirSync(d).filter((f) => VIDEO_EXTS.has(extname(f).toLowerCase()) && !seen.has(f) && !!seen.add(f)).map((f) => join(d, f))
      : [],
  );
}

/** Accepts a file name, a relative path, a stem, or a unique substring (e.g. the YouTube id). */
export function resolveVideo(ref: string): string {
  const direct = resolve(ROOT, ref);
  if (existsSync(direct) && VIDEO_EXTS.has(extname(direct).toLowerCase())) return direct;
  const files = videoFiles();
  const exact = files.find((f) => basename(f) === ref || parse(f).name === ref);
  if (exact) return exact;
  const matches = files.filter((f) => basename(f).toLowerCase().includes(ref.toLowerCase()));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} videos; be more specific`);
  throw new Error(`No video matching "${ref}". Known: ${files.map((f) => basename(f)).join(", ") || "none"}`);
}

export const transcriptDir = (video: string) => join(TRANSCRIPTS_DIR, parse(video).name);
export const transcriptJson = (video: string) => join(transcriptDir(video), "transcript.json");

export function readTranscript(video: string): Segment[] | null {
  const f = transcriptJson(video);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

export async function listVideos() {
  return Promise.all(
    videoFiles().map(async (path) => {
      const segs = readTranscript(path);
      return {
        name: basename(path),
        stem: parse(path).name,
        path: rel(path),
        size: statSync(path).size,
        duration: await cachedDuration(path),
        transcript: segs
          ? {
              segments: segs.length,
              path: rel(transcriptJson(path)),
              // Share of lines with measured word timings (vs. the transcriber's estimates).
              aligned: +(segs.filter((s) => s.timing === "aligned").length / segs.length).toFixed(2),
            }
          : null,
        vision: (() => {
          const vt = readVision(path);
          return vt ? { shots: vt.shots.length, labelled: vt.shots.filter((s) => s.kind).length, model: vt.model } : null;
        })(),
        runs: listRuns().filter((r) => r.videoStem === parse(path).name).map((r) => r.id),
      };
    }),
  );
}

/** A take's source video. It's stored relative to the workspace (older takes stored it absolute); if it isn't
 *  there any more (the workspace or the video moved), it's found by its file name. */
function takeVideo(p: string): string {
  const full = resolve(ROOT, p);
  if (existsSync(full)) return full;
  try {
    return resolveVideo(basename(p));
  } catch {
    return full;
  }
}

export function readClipData(scriptPath: string): ClipData {
  const text = readFileSync(scriptPath, "utf8");
  const m = text.match(/<!-- clip-data -->\s*```json\s*([\s\S]*?)```/);
  if (!m) throw new Error(`No clip-data JSON block in ${rel(scriptPath)}`);
  const data: ClipData = JSON.parse(m[1]);
  return { ...data, video: takeVideo(data.video) };
}

/** Rewrite only the machine-readable block, leaving the human-readable sections alone. */
export function writeClipData(scriptPath: string, data: ClipData) {
  const text = readFileSync(scriptPath, "utf8");
  const next = text.replace(
    /(<!-- clip-data -->\s*```json\s*)[\s\S]*?(```)/,
    (_, a, b) => `${a}${JSON.stringify({ ...data, video: stored(data.video) }, null, 2)}\n${b}`,
  );
  writeFileSync(scriptPath, next, "utf8");
}

export function runDir(runId: string) {
  const dir = safePath(join("clips", runId));
  if (!existsSync(join(dir, "clip_script.md"))) throw new Error(`No clip run "${runId}"`);
  return dir;
}

export function listRuns() {
  if (!existsSync(CLIPS_DIR)) return [];
  return readdirSync(CLIPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CLIPS_DIR, d.name, "clip_script.md")))
    .map((d) => {
      const dir = join(CLIPS_DIR, d.name);
      const script = join(dir, "clip_script.md");
      let data: ClipData | null = null;
      try {
        data = readClipData(script);
      } catch {}
      const stamp = d.name.match(/_(\d{8})_(\d{6})$/);
      return {
        id: d.name,
        videoStem: data ? parse(data.video).name : d.name.replace(/_\d{8}_\d{6}$/, ""),
        created: stamp
          ? `${stamp[1].slice(0, 4)}-${stamp[1].slice(4, 6)}-${stamp[1].slice(6)} ${stamp[2].slice(0, 2)}:${stamp[2].slice(2, 4)}`
          : new Date(statSync(script).mtimeMs).toISOString().slice(0, 16).replace("T", " "),
        script: rel(script),
        aspect: data?.aspect,
        // Sidecars from the workflow steps: jev.json (Pick), design.json (Design), check.json (Check), take.json.
        engine: readJsonFile(join(dir, "engine.json"))?.engine ?? "classic",
        jev: readJsonFile(join(dir, "jev.json")),
        check: readJsonFile(join(dir, "check.json")),
        info: readJsonFile(join(dir, "take.json")),
        design: readJsonFile(join(dir, "design.json")),
        clips: (data?.clips ?? []).map((c) => {
          const file = join(dir, `clip_${String(c.id).padStart(2, "0")}.mp4`);
          const has = existsSync(file);
          // Clip transcript of the finished file (watch.ts); stale once the clip is re-cut.
          const watch = has ? readJsonFile(join(dir, "watch", `clip_${String(c.id).padStart(2, "0")}`, "watch.json")) : null;
          return { ...c, file: has ? rel(file) : null, watch: watch && { ...watch, audio: watch.audio && { text: watch.audio.text, match: watch.audio.match }, fresh: watch.mtime === Math.round(statSync(file).mtimeMs) } };
        }),
      };
    })
    .sort((a, b) => b.created.localeCompare(a.created));
}

function readJsonFile(p: string): any {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  } catch {
    return null;
  }
}

export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

export function readSetting(outline: string, label: string): string | undefined {
  const m = outline.match(new RegExp(`\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*\\s*(.+)`));
  return m?.[1].trim();
}

/** Files named in backticks under "## Previous clip attempts" that look like history (md/txt/json or dirs). */
export function historyPaths(outline: string): string[] {
  const m = outline.match(/^## Previous clip attempts\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)]
    .map((x) => join(ROOT, x[1]))
    .filter((p) => /\.(md|txt|json)$/i.test(p) || (existsSync(p) && statSync(p).isDirectory()));
}
