// Step 4d · Check (Transcriber + Jev judges). For every finished clip of a take:
//   hear & see   the Transcriber on the rendered file: Whisper, a frame every ~3 s, faces, framing, captions (watch.ts)
//   rules        Jev rates the clip on every check rule in the take's brief (outline rules + reference traits)
//   edges        Jev rates whether the first and last lines are clean places to start and stop, and suggests better ones
// Results go in check.json and appear next to each clip in Review. Only clips rendered since the last
// check are checked again.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext } from "../jobs";
import { decide, noul, pick, type Question } from "../jev";
import { pool } from "../lib";
import { readClipData, readTranscript, runDir } from "../library";
import { droppedClips } from "../review";
import type { CheckRule } from "./brief";
import { takeBrief } from "./design";
import { clipStr } from "./text";
import { readWatch, watchClips, watchSummary } from "./watch";
import type { Segment } from "../lib";

export type EdgeCheck = {
  start: number; end: number; // the edges that were checked; suggestions are stale once these change
  start_clean: number; end_clean: number; standalone: number;
  suggest_start?: { t: number; p: number; line: string };
  suggest_end?: { t: number; p: number; line: string };
};
export type ClipCheck = { mtime: number; at: number; watched: boolean; rules: Record<string, number>; followed: number; edges: EdgeCheck | null };
export type CheckFile = { at: number; model: string; cost: number; rules: CheckRule[]; clips: Record<string, ClipCheck> };

const pad2 = (id: number) => String(id).padStart(2, "0");
const checkPath = (runId: string) => join(runDir(runId), "check.json");

export function readCheck(runId: string): CheckFile | null {
  try {
    return existsSync(checkPath(runId)) ? JSON.parse(readFileSync(checkPath(runId), "utf8")) : null;
  } catch {
    return null;
  }
}

/** Kept, rendered clips whose check is missing or older than their file. */
export function checkStatus(runId: string) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const ck = readCheck(runId);
  const dropped = new Set(droppedClips(runId));
  const rendered = data.clips.filter((c) => !dropped.has(c.id) && existsSync(join(dir, `clip_${pad2(c.id)}.mp4`)));
  const todo = rendered.filter((c) => {
    const x = ck?.clips[c.id];
    return !x || x.mtime !== Math.round(statSync(join(dir, `clip_${pad2(c.id)}.mp4`)).mtimeMs);
  }).map((c) => c.id);
  return { rendered: rendered.length, todo, checked: rendered.length - todo.length };
}

const nearest = <T extends { start: number; end: number }>(segs: T[], t: number, key: "start" | "end") =>
  segs.reduce((best, s, i) => (Math.abs(s[key] - t) < Math.abs(segs[best][key] - t) ? i : best), 0);

/** Jev on a clip's edges: are they clean, and is there a better line nearby? */
async function edgeCheck(segs: Segment[], c: { start: number; end: number }, signal: AbortSignal) {
  const si = nearest(segs, c.start, "start");
  const ei = nearest(segs, c.end, "end");
  const around = (i: number) => Object.fromEntries([-2, -1, 0, 1, 2].filter((d) => segs[i + d]).map((d) => [`at_${d + 2}`, clipStr(segs[i + d].text, 160)]));
  const d = await decide(
    {
      clip_transcript: clipStr(segs.slice(si, ei + 1).map((s) => s.text).join("\n"), 5000),
      line_before_clip: segs[si - 1]?.text ?? "",
      line_after_clip: segs[ei + 1]?.text ?? "",
    },
    {
      start_clean: { type: "noul", instructions: "The clip's first line is a clean place to start: it doesn't begin mid-sentence or depend on the line before it." },
      end_clean: { type: "noul", instructions: "The clip's last line is a clean place to stop: the line after it doesn't finish the same thought." },
      standalone: { type: "noul", instructions: "The clip makes sense on its own for a viewer who hasn't seen the rest of the video." },
      best_start: { type: "choice", instructions: "Which of these lines is the strongest clean opening for this clip?", criteria: around(si) },
      best_end: { type: "choice", instructions: "Which of these lines is the best place to end this clip?", criteria: around(ei) },
    },
    signal,
  );
  const bs = pick(d.answers.best_start);
  const be = pick(d.answers.best_end);
  const s2 = si + Number(bs.key.replace("at_", "")) - 2;
  const e2 = ei + Number(be.key.replace("at_", "")) - 2;
  const check: EdgeCheck = { start: c.start, end: c.end, start_clean: noul(d.answers.start_clean), end_clean: noul(d.answers.end_clean), standalone: noul(d.answers.standalone) };
  // Only suggest a move when Jev is fairly sure and the result still makes a sensible clip.
  const newStart = segs[s2]?.start ?? c.start;
  const newEnd = segs[e2]?.end ?? c.end;
  if (s2 !== si && bs.p >= 0.5 && newEnd - newStart > 5) check.suggest_start = { t: newStart, p: bs.p, line: clipStr(segs[s2].text, 90) };
  if (e2 !== ei && be.p >= 0.5 && newEnd - newStart > 5) check.suggest_end = { t: newEnd, p: be.p, line: clipStr(segs[e2].text, 90) };
  return { check, cost: d.cost, model: d.model };
}

export async function checkTake(ctx: JobContext, runId: string, opts: { only?: number[] } = {}) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const status = checkStatus(runId);
  const todo = opts.only?.length ? opts.only : status.todo;
  if (!status.rendered) throw new Error("This take has no rendered clips to check yet.");
  if (!todo.length) {
    ctx.log(`All ${status.rendered} rendered clips are checked`);
    return { run: runId, checked: 0 };
  }
  let cost = 0;
  let model = "";
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));

  // 1. Hear and see the finished files.
  ctx.progress(0.02, "watching the finished clips");
  try {
    await watchClips({ ...ctx, addCost, progress: (v, s) => ctx.progress(0.02 + 0.5 * v, s) }, runId, { only: todo });
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Couldn't watch every clip (${e instanceof Error ? e.message : e}); checking from the plan instead`, "warn");
  }

  // 2. Rules and edges, per clip.
  const brief = takeBrief(runId, data.video);
  const rules = brief.check;
  const ruleQ: Record<string, Question> = Object.fromEntries(rules.map((r) => [r.key, { type: "noul", instructions: r.question }]));
  const segs = readTranscript(data.video) ?? [];
  ctx.log(`Jev: rating ${todo.length} clip(s) on ${rules.length} rule(s) and checking their edges`);
  const prev = readCheck(runId);
  const results: Record<string, ClipCheck> = { ...(prev?.clips ?? {}) };
  let done = 0;
  await pool(data.clips.filter((c) => todo.includes(c.id)), 6, async (c) => {
    const file = join(dir, `clip_${pad2(c.id)}.mp4`);
    if (!existsSync(file)) return;
    const w = readWatch(runId, c.id);
    const e = c.edit;
    const planned = (e?.segments?.length ? e.segments : [{ start: c.start, end: c.end }])
      .map((s) => segs.filter((l) => l.end > s.start && l.start < s.end).map((l) => l.text).join(" ")).join(" … ");
    const [r, edges] = await Promise.all([
      rules.length
        ? decide({
            brief: brief.summary,
            clip_title: c.title,
            hook_card: e?.title,
            seconds: Math.round(c.end - c.start),
            clip_transcript: clipStr(w?.audio?.text || planned, 3000),
            ...(w ? { finished_clip: watchSummary(w), frames: w.frames.map((f) => `${f.t.toFixed(0)}s ${f.desc ?? ""}${f.effect ? ` [${f.effect}]` : ""}${f.captions ? ` captions: ${f.captions}` : ""}`).slice(0, 14) } : {}),
            edit: e?.segments?.length ? { parts: e.segments.map((s) => s.zoom ?? "none"), transitions: e.transitions, looks: e.segments.map((s) => s.look ?? "") } : undefined,
          }, ruleQ, ctx.signal)
        : null,
      segs.length ? edgeCheck(segs, c, ctx.signal) : null,
    ]);
    if (r) (addCost(r.cost), (model = r.model));
    if (edges) addCost(edges.cost);
    const answers = r ? Object.fromEntries(rules.map((q) => [q.key, noul(r.answers[q.key])])) : {};
    const vals = Object.values(answers);
    results[c.id] = {
      mtime: Math.round(statSync(file).mtimeMs), at: Date.now(), watched: !!w, rules: answers,
      followed: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 0,
      edges: edges?.check ?? null,
    };
    const low = rules.filter((q) => (answers[q.key] ?? 1) < 0.4).map((q) => q.rule);
    const edgeWarn = edges && (edges.check.start_clean < 0.5 || edges.check.end_clean < 0.5);
    ctx.log(`Clip ${c.id}: follows ${Math.round(results[c.id].followed * 100)}% of the rules${low.length ? `; misses ${low.slice(0, 3).join("; ")}` : ""}${edgeWarn ? "; an edge may cut mid-thought" : ""}`, low.length || edgeWarn ? "warn" : "info");
    ctx.progress(0.55 + 0.43 * (++done / todo.length), `checked ${done}/${todo.length}`);
  }, ctx.signal);

  const file: CheckFile = { at: Date.now(), model: model || prev?.model || "", cost: (prev?.cost ?? 0) + cost, rules, clips: results };
  writeFileSync(checkPath(runId), JSON.stringify(file, null, 1), "utf8");
  ctx.progress(1, "clips checked");
  return { run: runId, checked: done, cost };
}
