// A take: one pass of Make (pick → design → render → check) over a source video, stored in
// clips/<video>_<stamp>/:
//   clip_script.md   human-readable plan plus the machine-readable clip data (edits included)
//   take.json        what the take was made from (outline, reference and brief versions) and your direction
//   outline.md       the outline it was made with (the coach scores outline versions by their takes)
//   jev.json         the pick decisions and the brief snapshot; design.json, render.json, check.json follow
// A take never changes its inputs: when the outline, reference or brief change, the next Run makes a new take.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import type { JobContext } from "../jobs";
import {
  CLIPS_DIR, OUTLINE_FILE, historyPaths, readClipData, readSetting, readText, readTranscript, rel, runDir, transcriptJson, writeClipData,
  type ClipData,
} from "../library";
import { addNudge } from "../review";
import { fmt, type Segment } from "../lib";
import { snapshotOutline } from "./outlines";
import { describeEdit, readEditStyle, type Edit } from "./edit";

export type TakeInput = { video: string; count?: number; min_len?: number; max_len?: number; notes?: string };
export type TakeInfo = {
  video: string; created: number; notes?: string;
  /** Versions of the inputs the take was made from. */
  inputs: { outline: string; reference: string; brief: string };
};

export type PlannedClip = {
  id: number; title: string; start: number; end: number;
  hook?: string; reason?: string; on_screen_text?: string; edit_notes?: string;
  edit?: Edit;
};

export function readHistory(paths: string[], limit = 20000): string {
  const parts: string[] = [];
  const walk = (p: string): string[] =>
    existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => walk(join(p, f))) : [p];
  for (const f of paths.flatMap(walk)) {
    if (existsSync(f) && /\.(md|txt|json)$/i.test(f)) parts.push(`## ${rel(f)}\n${readText(f).slice(-limit)}`);
  }
  return parts.join("\n\n") || "None yet.";
}

/** Snap clip edges to segment boundaries so no word gets cut. */
export function snap(start: number, end: number, segs: Segment[]): [number, number] {
  const starts = segs.filter((s) => s.start <= start + 0.5);
  const ends = segs.filter((s) => s.end >= end - 0.5);
  const a = starts.length ? starts[starts.length - 1].start : segs[0].start;
  const b = ends.length ? ends[0].end : segs[segs.length - 1].end;
  return [a, Math.max(b, a + 1)];
}

export const linesIn = (segs: Segment[], a: number, b: number) => segs.filter((s) => s.start < b && s.end > a);

/** Everything a take needs from the transcript and the outline's clip settings. */
export function takeContext(video: string, input: Partial<TakeInput> = {}) {
  const segs = readTranscript(video);
  if (!segs?.length) throw new Error(`No transcript for ${parse(video).name}. Transcribe it first.`);
  const outline = readText(OUTLINE_FILE);
  if (!outline) throw new Error(`Missing ${rel(OUTLINE_FILE)}`);
  const count = input.count ?? Number((readSetting(outline, "Number of clips") ?? "5").match(/\d+/)?.[0] ?? 5);
  const lens = (readSetting(outline, "Clip length") ?? "30-90").match(/\d+/g) ?? [];
  const min = input.min_len ?? (lens.length >= 2 ? Number(lens[0]) : 30);
  const max = input.max_len ?? (lens.length >= 2 ? Number(lens[1]) : 90);
  const aspect = (readSetting(outline, "Aspect ratio") ?? "9:16").split(/\s+/)[0];
  const hist = historyPaths(outline);
  const historyFile = hist[0] ? rel(hist[0]) : "clips/history.md";
  const total = segs[segs.length - 1].end;
  return { segs, outline, count, min, max, aspect, hist, historyFile, total };
}

function script(p: { video: string; model: string; aspect: string; historyFile: string; clips: PlannedClip[]; segs: Segment[]; runId: string }): string {
  const out = [
    `# Clip script: ${parse(p.video).name}`,
    "",
    `- **Source video:** \`${rel(p.video)}\``,
    `- **Transcript:** \`${rel(transcriptJson(p.video))}\``,
    `- **Outline:** \`${rel(OUTLINE_FILE)}\``,
    `- **Picked by:** ${p.model} on ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    `- **Target aspect ratio:** ${p.aspect}`,
    "",
    "## How this take is made",
    "",
    "1. Pick (done): Jev chose these clips. Design then picks camera moves, transitions and hook cards.",
    "2. Render: mrClipper renders every clip next to this script as `clip_01.mp4`, `clip_02.mp4`, … Or run",
    "   ```",
    `   python extract_clips.py "clips/${p.runId}/clip_script.md"`,
    "   ```",
    "3. Check: every finished clip is heard, watched and rated on the brief's rules.",
    "4. Review: you keep or drop each clip, nudge its edges and comment. To change a boundary by hand, edit",
    "   `start`/`end` in the **Clip data** block at the bottom; the next render redoes only that clip.",
    `5. Every render is logged to \`${p.historyFile}\`. After posting, add performance notes there.`,
    "",
  ];
  for (const c of p.clips) {
    const dur = c.end - c.start;
    out.push(
      `## Clip ${c.id}: ${c.title}`,
      "",
      "| Start | End | Duration |",
      "|---|---|---|",
      `| ${fmt(c.start, "tenths")} | ${fmt(c.end, "tenths")} | ${dur.toFixed(1)}s |`,
      "",
      `- **Hook:** ${c.hook ?? ""}`,
      `- **Why it fits:** ${c.reason ?? ""}`,
      `- **On-screen text:** ${c.on_screen_text ?? ""}`,
      `- **Edit notes:** ${c.edit_notes ?? ""}`,
      ...(c.edit
        ? ["", `**Edit (${c.edit.segments.length} segments):**`, "", ...describeEdit(c.edit).map((l) => `- ${l}`)]
        : []),
      "",
      "**Transcript:**",
      "",
      ...linesIn(p.segs, c.start, c.end).map((s) => `> \`${fmt(s.start, "tenths")}\` ${s.text}  `),
      "",
    );
  }
  const data: ClipData = {
    // Relative to the workspace, so a workspace can be moved or copied.
    video: rel(p.video),
    transcript: rel(transcriptJson(p.video)),
    aspect: p.aspect,
    history_file: p.historyFile,
    // The outline's editing rules are frozen into the take, so later outline edits change the next take, not this one.
    edit_style: readEditStyle(readText(OUTLINE_FILE)),
    clips: p.clips.map(({ id, title, start, end, on_screen_text, reason, edit }) => ({ id, title, start, end, on_screen_text, reason, ...(edit ? { edit } : {}) })),
  };
  out.push(
    "## Clip data",
    "",
    "Machine-readable copy read by the renderer and `extract_clips.py`. Edit times here to adjust a cut.",
    "",
    "<!-- clip-data -->",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
  );
  return out.join("\n");
}

/** Write a new take (clip script, take.json, outline snapshot, sidecars) and return the job result. */
export function writeTake(
  ctx: JobContext,
  video: string,
  p: { model: string; aspect: string; historyFile: string; clips: PlannedClip[]; segs: Segment[]; info: Omit<TakeInfo, "video" | "created"> },
  sidecars: Record<string, unknown> = {},
) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("")}`;
  const runId = `${parse(video).name}_${stamp}`;
  const dir = join(CLIPS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clip_script.md"), script({ video, runId, ...p }), "utf8");
  const info: TakeInfo = { video: rel(video), created: Date.now(), ...p.info };
  writeFileSync(join(dir, "take.json"), JSON.stringify(info, null, 2), "utf8");
  for (const [name, data] of Object.entries(sidecars)) writeFileSync(join(dir, name), JSON.stringify(data, null, 2), "utf8");
  snapshotOutline(dir);
  ctx.log(`Wrote take ${runId} with ${p.clips.length} clips`);
  return {
    run: runId,
    clips: p.clips.map((c) => ({ id: c.id, title: c.title, start: fmt(c.start, "tenths"), end: fmt(c.end, "tenths"), seconds: +(c.end - c.start).toFixed(1) })),
  };
}

export function readTakeInfo(runId: string): TakeInfo | null {
  try {
    const f = join(CLIPS_DIR, runId, "take.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

/**
 * Move a clip's in/out point (seconds in the source). With an edit, "in" is the first part that plays
 * and "out" the last one. A nudge is a correction, so it counts against the outline's one-shot score;
 * the next Render redoes only this clip.
 */
export function adjustClipEdges(runId: string, clipId: number, patch: { start?: number; end?: number; title?: string; edit_enabled?: boolean }) {
  const script = join(runDir(runId), "clip_script.md");
  const data = readClipData(script);
  const clip = data.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`No clip ${clipId}`);
  const e = clip.edit;
  if (e && patch.edit_enabled !== undefined) e.enabled = patch.edit_enabled !== false;
  const moved = patch.start != null || patch.end != null;
  if (e?.segments.length && e.enabled !== false && moved) {
    const first = e.segments[0];
    const last = e.segments[e.segments.length - 1];
    if (patch.start != null) first.start = Math.max(0, Number(patch.start));
    if (patch.end != null) last.end = Number(patch.end);
    if (first.end <= first.start + 0.5 || last.end <= last.start + 0.5) throw new Error("That would leave a part shorter than half a second");
    clip.start = Math.min(...e.segments.map((s) => s.start));
    clip.end = Math.max(...e.segments.map((s) => s.end));
  } else {
    if (patch.start != null) clip.start = Math.max(0, Number(patch.start));
    if (patch.end != null) clip.end = Number(patch.end);
  }
  if (patch.title) clip.title = String(patch.title);
  if (clip.end <= clip.start + 1) throw new Error("A clip needs at least a second between start and end");
  writeClipData(script, data);
  if (moved) addNudge(runId, clipId);
  return { id: clipId, start: clip.start, end: clip.end };
}
