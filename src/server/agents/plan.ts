import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { MODELS } from "../config";
import type { JobContext } from "../jobs";
import {
  CLIPS_DIR, OUTLINE_FILE, historyPaths, readSetting, readText, readTranscript, rel, transcriptJson,
  type ClipData,
} from "../library";
import { extractJson, fmt, openrouter, sleep, type Segment } from "../lib";
import { feedbackDigest } from "../review";
import { readVision, type VisionTranscript } from "./vision";
import { snapshotOutline } from "./coach";
import { autoEdit, describeEdit, editDuration, normalizeEdit, readEditStyle, type Edit, type EditStyle } from "./edit";

/** One line per shot for the planner prompt; continuation samples of long shots are folded in. */
function visionLines(vt: VisionTranscript | null): string {
  if (!vt) return "";
  const lines: string[] = [];
  for (const s of vt.shots) {
    if (!s.kind) continue;
    const prev = lines.length ? vt.shots.find((x) => x.id === s.id - 1) : undefined;
    if (s.cont && prev?.kind === s.kind && prev.desc === s.desc) continue;
    lines.push(`[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.kind}: ${s.desc}${s.text ? ` | text: ${s.text.slice(0, 80)}` : ""} (x ${s.subject_x?.toFixed(2)})`);
  }
  return lines.join("\n");
}

export type PlanInput = { video: string; count?: number; min_len?: number; max_len?: number; notes?: string; models?: string[] };

export type PlannedClip = {
  id: number; title: string; start: number; end: number;
  hook?: string; reason?: string; on_screen_text?: string; edit_notes?: string;
  edit?: Edit;
};

const PROMPT = (p: {
  outline: string; history: string; feedback: string; total: number; transcript: string; vision?: string;
  count: number; min: number; max: number; notes?: string;
}) => `You are a short-form video editor. Choose the best clips from this video's audio and vision transcripts.

# Clip outline (audience, tone, rules)
${p.outline}

# Previous clip attempts
${p.history}

# The editor's own feedback (comments, kept and dropped clips). Follow it closely.
${p.feedback || "None yet."}
${p.notes ? `\n# Extra direction for this run\n${p.notes}\n` : ""}
# Transcript
Each line is [start_seconds-end_seconds] text. The video is ${p.total.toFixed(0)} seconds long.
${p.transcript}
${p.vision ? `
# Vision transcript
What is on screen, shot by shot: [start_seconds-end_seconds] kind: description (x = where the main subject sits, 0 left to 1 right).
${p.vision}
` : ""}
# Task
Pick exactly ${p.count} clips, each ${p.min}-${p.max} seconds long, that best fit the audience and tone.${p.vision ? `
- Use both transcripts. Prefer moments where the picture carries the story (the host reacting, archival photos, maps,
  footage) and whose main subject stays near the centre (x 0.35-0.65) so a 9:16 crop keeps it. Avoid clips that depend
  on a wide text card or graphic that would be cut off or unreadable on a phone. Mention the key visuals in edit_notes.` : ""}
- start must be the start time of the segment the clip opens on; end must be the end time of the closing segment.
- Clips must not overlap. Don't repeat a moment already used in previous attempts for this video
  unless the history notes say it performed well and should be tried differently.
- Use what worked and avoid what failed in the previous attempts.
- Edit each clip like a short-form editor, following the outline's Story structure, Editing style, Visual effects,
  Captions style and Title card sections. Give each clip an "edit": up to the outline's max segments, taken from
  transcript line boundaries (start of a line to end of a line), in the order they should play. A cold open may
  put the payoff or hook first. The segments' total length (not start-to-end) must be ${p.min}-${p.max} seconds.
  transitions has one entry per gap between segments; zoom and transitions only use the outline's allowed values.
  title is the hook card in the video's language; emphasis lists 2-5 exact words from the transcript.
  A segment may set "flashback": true (rendered in the outline's Flashback look) when it recalls an earlier moment.

Reply with ONLY a JSON object, no prose, in this shape:
{"clips": [{
  "title": "short English working title",
  "start": 123.4,
  "end": 180.2,
  "hook": "why the first 3 seconds grab attention",
  "reason": "why this clip fits the audience and tone",
  "on_screen_text": "short caption/title to overlay, in the video's language",
  "edit_notes": "trims, pacing, anything the editor should watch for",
  "edit": {
    "segments": [
      {"start": 150.2, "end": 158.9, "role": "hook", "zoom": "punch_in"},
      {"start": 123.4, "end": 141.0, "role": "setup", "zoom": "none"},
      {"start": 160.1, "end": 180.2, "role": "payoff", "zoom": "slow_push", "speed": 1.0}
    ],
    "transitions": ["dip_black", "cut"],
    "title": "hook card text in the video's language",
    "emphasis": ["exact", "words"]
  }
}]}`;

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

function render(p: {
  video: string; model: string; aspect: string; historyFile: string;
  clips: PlannedClip[]; segs: Segment[]; runId: string;
}): string {
  const out = [
    `# Clip script: ${parse(p.video).name}`,
    "",
    `- **Source video:** \`${p.video}\``,
    `- **Transcript:** \`${rel(transcriptJson(p.video))}\``,
    `- **Outline:** \`${rel(OUTLINE_FILE)}\``,
    `- **Planned by:** ${p.model} on ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    `- **Target aspect ratio:** ${p.aspect}`,
    "",
    "## Instructions for the extracting agent",
    "",
    "1. Read each clip section below. Times are `HH:MM:SS.s` from the start of the source video.",
    `2. To extract everything, call the extract agent's \`extract_clips\` tool with run \`${p.runId}\`,`,
    "   or from the project root run:",
    "   ```",
    `   python extract_clips.py "clips/${p.runId}/clip_script.md"`,
    "   ```",
    "   Options: `only` / `--only 1,3` for specific clips, `subs` / `--subs` to burn in captions,",
    "   `vertical: false` / `--no-vertical` to keep the original 16:9 frame instead of a centered 9:16 crop.",
    "   Clip files are written next to this script as `clip_01.mp4`, `clip_02.mp4`, ...",
    "3. To cut one by hand, use the ffmpeg command shown in its section.",
    "4. Check each output: the first and last seconds must not cut a word, and the clip must",
    "   make sense on its own. If a boundary is off, change `start`/`end` in the **Clip data**",
    "   JSON block at the bottom (or use the `adjust_clip` tool) and re-extract only that clip.",
    `5. Every extraction is logged to \`${p.historyFile}\`. After posting, add`,
    "   performance notes there so future plans learn from them.",
    "",
  ];
  for (const c of p.clips) {
    const dur = c.end - c.start;
    const id2 = String(c.id).padStart(2, "0");
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
        ? [
            "",
            `**Edit (${c.edit.segments.length} segments${c.edit.title ? `, title "${c.edit.title}"` : ""}):**`,
            "",
            ...describeEdit(c.edit).map((l) => `- ${l}`),
            ...(c.edit.emphasis?.length ? [`- Emphasis: ${c.edit.emphasis.join(", ")}`] : []),
          ]
        : []),
      "",
      "**Transcript:**",
      "",
      ...linesIn(p.segs, c.start, c.end).map((s) => `> \`${fmt(s.start, "tenths")}\` ${s.text}  `),
      "",
      "**Manual cut:**",
      "```",
      `ffmpeg -ss ${c.start.toFixed(2)} -i "${p.video}" -t ${dur.toFixed(2)} -c:v libx264 -crf 20 -preset veryfast -c:a aac -b:a 160k clip_${id2}.mp4`,
      "```",
      "",
    );
  }
  const data: ClipData = {
    video: p.video,
    transcript: rel(transcriptJson(p.video)),
    aspect: p.aspect,
    history_file: p.historyFile,
    // The outline feeds the Planner only: its editing rules are frozen into the take here, so later
    // outline edits change the next take, not how this one is cut.
    edit_style: readEditStyle(readText(OUTLINE_FILE)),
    clips: p.clips.map(({ id, title, start, end, on_screen_text, reason, edit }) => ({ id, title, start, end, on_screen_text, reason, ...(edit ? { edit } : {}) })),
  };
  out.push(
    "## Clip data",
    "",
    "Machine-readable copy read by the extract agent and `extract_clips.py`. Edit times here to adjust a cut.",
    "",
    "<!-- clip-data -->",
    "```json",
    JSON.stringify(data, null, 2),
    "```",
    "",
  );
  return out.join("\n");
}

/** Everything both planning engines need: transcript, outline and the resolved clip settings. */
export function planContext(video: string, input: PlanInput) {
  const segs = readTranscript(video);
  if (!segs?.length) throw new Error(`No transcript for ${parse(video).name}. Run the transcribe agent first.`);
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

/** Write clips/<video>_<stamp>/clip_script.md (plus optional sidecar files) and return the job result. */
export function writeRun(
  ctx: JobContext,
  video: string,
  p: { model: string; aspect: string; historyFile: string; clips: PlannedClip[]; segs: Segment[] },
  sidecars: Record<string, unknown> = {},
) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("")}`;
  const runId = `${parse(video).name}_${stamp}`;
  const dir = join(CLIPS_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "clip_script.md"), render({ video, runId, ...p }), "utf8");
  for (const [name, data] of Object.entries(sidecars)) writeFileSync(join(dir, name), JSON.stringify(data, null, 2), "utf8");
  // The outline this take was planned with: the Outline coach scores outline versions by their takes.
  snapshotOutline(dir);
  ctx.log(`Wrote ${p.clips.length} clips to ${rel(join(dir, "clip_script.md"))}`);
  return {
    run: runId,
    script: rel(join(dir, "clip_script.md")),
    model: p.model,
    clips: p.clips.map((c) => ({ id: c.id, title: c.title, start: fmt(c.start, "tenths"), end: fmt(c.end, "tenths"), seconds: +(c.end - c.start).toFixed(1), hook: c.hook })),
  };
}

export async function planClips(ctx: JobContext, video: string, input: PlanInput) {
  const { segs, outline, count, min, max, aspect, hist, historyFile, total } = planContext(video, input);
  const models = input.models?.length ? input.models : MODELS.plan;

  ctx.log(`Outline: ${count} clips, ${min}-${max}s, ${aspect}; history from ${hist.map(rel).join(", ") || "none"}`);
  const prompt = PROMPT({
    outline, history: readHistory(hist), feedback: feedbackDigest(video), total, count, min, max, notes: input.notes,
    transcript: segs.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n"),
    vision: visionLines(readVision(video)),
  });

  ctx.progress(0.15, `asking ${models[0]}`);
  ctx.log(`Planning with ${models[0]} (fallbacks: ${models.slice(1).join(", ") || "none"}), prompt ${Math.round(prompt.length / 1000)}k chars`);
  let result: { clips?: any[] } = {};
  let usedModel = models[0];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await openrouter({ temperature: 0.4, messages: [{ role: "user", content: prompt }] }, models, ctx.signal);
      ctx.addCost(res.usage?.cost);
      usedModel = res.model;
      result = extractJson(res.content);
      break;
    } catch (e) {
      if (ctx.signal.aborted || attempt === 3) throw e;
      ctx.log(`attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`, "warn");
      await sleep(3000 * attempt, ctx.signal);
    }
  }
  ctx.progress(0.8, "validating clips");

  const { clips } = acceptClips(ctx, result.clips ?? [], segs, min, max, { style: readEditStyle(outline), vt: readVision(video) });
  if (!clips.length) throw new Error("Model returned no usable clips");
  return writeRun(ctx, video, { model: usedModel, aspect, historyFile, clips, segs }, { "engine.json": { engine: "classic", model: usedModel } });
}

/**
 * The deterministic rules every plan must pass, whoever wrote it: snap to line boundaries, stay
 * within the outline's length range, no overlaps. Returns the accepted clips and why others failed.
 */
export function acceptClips(
  ctx: JobContext, raw: any[], segs: Segment[], min: number, max: number,
  editing?: { style: EditStyle; vt: VisionTranscript | null },
) {
  const clips: PlannedClip[] = [];
  const rejected: { title: string; reason: string }[] = [];
  const total = segs[segs.length - 1].end;
  for (const c of [...raw].sort((a, b) => Number(a.start) - Number(b.start))) {
    const title = String(c.title ?? "untitled").slice(0, 80);
    const s0 = Number(c.start), e0 = Number(c.end);
    if (!Number.isFinite(s0) || !Number.isFinite(e0) || e0 <= s0 || s0 < 0 || s0 > total) {
      rejected.push({ title, reason: "start/end must be seconds from the video start, with end after start" });
      continue;
    }
    let [start, end] = snap(s0, e0, segs);
    // The edit: the planner's own EDL if it passes validation, otherwise the deterministic default.
    let edit: Edit | undefined;
    if (editing) {
      const n = normalizeEdit(c.edit, segs, editing.style, editing.vt);
      if (n) {
        edit = n.edit;
        for (const note of n.notes) ctx.log(`"${title}": ${note}`, "warn");
        start = Math.min(...edit.segments.map((x) => x.start));
        end = Math.max(...edit.segments.map((x) => x.end));
      } else {
        edit = autoEdit(start, end, segs, editing.style, editing.vt, c.on_screen_text ? String(c.on_screen_text) : undefined);
      }
    }
    const dur = edit && editing ? editDuration(edit, editing.style) : end - start;
    if (!(dur >= min * 0.8 && dur <= max * 1.25)) {
      rejected.push({ title, reason: `${dur.toFixed(0)}s ${edit ? "after editing" : "after snapping to line boundaries"}; needs ${min}-${max}s` });
      ctx.log(`skipping "${title}": ${dur.toFixed(0)}s is outside ${min}-${max}s`, "warn");
      continue;
    }
    if (clips.length && start < clips[clips.length - 1].end) {
      rejected.push({ title, reason: "overlaps the previous clip" });
      ctx.log(`skipping "${title}": overlaps previous clip`, "warn");
      continue;
    }
    clips.push({
      id: clips.length + 1, title, start, end,
      hook: c.hook ? String(c.hook).slice(0, 300) : undefined,
      reason: c.reason ? String(c.reason).slice(0, 600) : undefined,
      on_screen_text: c.on_screen_text ? String(c.on_screen_text).slice(0, 120) : undefined,
      edit_notes: c.edit_notes ? String(c.edit_notes).slice(0, 400) : undefined,
      ...(edit ? { edit } : {}),
    });
  }
  return { clips, rejected };
}

/** WebMCP mode: a plan written by the browser agent, validated by the same rules, saved as a take. */
export function planFromAgent(ctx: JobContext, video: string, input: { clips: any[]; direction?: string; agent?: string }) {
  const { segs, min, max, aspect, historyFile, outline } = planContext(video, {} as PlanInput);
  ctx.log(`Validating ${input.clips.length} clips submitted by ${input.agent || "the browser agent"}`);
  const { clips, rejected } = acceptClips(ctx, input.clips, segs, min, max, { style: readEditStyle(outline), vt: readVision(video) });
  if (!clips.length) {
    throw new Error(`No clip passed validation: ${rejected.map((r) => `"${r.title}": ${r.reason}`).join("; ") || "empty plan"}`);
  }
  const model = `${input.agent || "browser agent"} (WebMCP)`;
  const result = writeRun(ctx, video, { model, aspect, historyFile, clips, segs }, {
    "engine.json": { engine: "webmcp", agent: input.agent ?? null, direction: input.direction ?? null },
  });
  return { ...result, rejected, rules: { min_seconds: min, max_seconds: max, snapped_to: "transcript line boundaries" } };
}

