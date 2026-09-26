// Editor pre-flight in System One mode: Jev checks each clip's edges and suggests better lines.
// It only suggests; changing an approved clip is the user's call (Review panel → Apply).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobContext } from "../jobs";
import { decide, noul, pick } from "../jev";
import { readClipData, readTranscript, runDir } from "../library";
import { fmt, pool } from "../lib";

export type EdgeCheck = {
  start: number; end: number; // the edges that were checked; suggestions are stale once these change
  start_clean: number; end_clean: number; standalone: number;
  suggest_start?: { t: number; p: number; line: string };
  suggest_end?: { t: number; p: number; line: string };
};
export type QaFile = { checkedAt: number; model: string; clips: Record<string, EdgeCheck> };

const short = (t: string, n = 160) => (t.length > n ? t.slice(0, n) + "…" : t);
const nearest = <T extends { start: number; end: number }>(segs: T[], t: number, key: "start" | "end") =>
  segs.reduce((best, s, i) => (Math.abs(s[key] - t) < Math.abs(segs[best][key] - t) ? i : best), 0);

export async function checkRun(ctx: JobContext, runId: string, only?: number[]) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const segs = readTranscript(data.video);
  if (!segs) throw new Error("This run's video has no transcript");
  const clips = data.clips.filter((c) => !only?.length || only.includes(c.id));
  let model = "";
  let done = 0;
  const out: Record<string, EdgeCheck> = {};

  await pool(clips, 8, async (c) => {
    const si = nearest(segs, c.start, "start");
    const ei = nearest(segs, c.end, "end");
    // Candidate lines around each edge; keys are offsets so the answer maps straight back to a segment.
    const around = (i: number) =>
      Object.fromEntries([-2, -1, 0, 1, 2].filter((d) => segs[i + d]).map((d) => [`at_${d + 2}`, short(segs[i + d].text)]));
    const body = segs.slice(si, ei + 1).map((s) => s.text).join("\n");
    const d = await decide(
      {
        clip_transcript: short(body, 5000),
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
      ctx.signal,
    );
    model = d.model;
    ctx.addCost(d.cost);
    const bs = pick(d.answers.best_start);
    const be = pick(d.answers.best_end);
    const s2 = si + Number(bs.key.replace("at_", "")) - 2;
    const e2 = ei + Number(be.key.replace("at_", "")) - 2;
    const check: EdgeCheck = {
      start: c.start, end: c.end,
      start_clean: noul(d.answers.start_clean),
      end_clean: noul(d.answers.end_clean),
      standalone: noul(d.answers.standalone),
    };
    // Only suggest a move when Jev is fairly sure and the result still makes a sensible clip.
    const newStart = segs[s2]?.start ?? c.start;
    const newEnd = segs[e2]?.end ?? c.end;
    if (s2 !== si && bs.p >= 0.5 && newEnd - newStart > 5) check.suggest_start = { t: newStart, p: bs.p, line: short(segs[s2].text, 90) };
    if (e2 !== ei && be.p >= 0.5 && newEnd - newStart > 5) check.suggest_end = { t: newEnd, p: be.p, line: short(segs[e2].text, 90) };
    out[c.id] = check;

    const warn = [
      check.start_clean < 0.5 && `start may be mid-thought (${Math.round(check.start_clean * 100)}%)`,
      check.end_clean < 0.5 && `end may cut off (${Math.round(check.end_clean * 100)}%)`,
      check.suggest_start && `suggests starting at ${fmt(check.suggest_start.t)}`,
      check.suggest_end && `suggests ending at ${fmt(check.suggest_end.t)}`,
    ].filter(Boolean);
    ctx.log(`Clip ${c.id}: ${warn.length ? warn.join("; ") : "edges look clean"}`, warn.length ? "warn" : "info");
    ctx.progress(++done / clips.length, `checked ${done}/${clips.length}`);
  }, ctx.signal);

  // Merge so a partial check (only=[…]) keeps earlier results for other clips.
  const file = join(dir, "jev_qa.json");
  let prev: QaFile | null = null;
  try {
    prev = JSON.parse(await Bun.file(file).text());
  } catch {}
  const qa: QaFile = { checkedAt: Date.now(), model, clips: { ...(prev?.clips ?? {}), ...out } };
  writeFileSync(file, JSON.stringify(qa, null, 2), "utf8");
  return { run: runId, checked: clips.length, flagged: Object.values(out).filter((c) => c.suggest_start || c.suggest_end || c.start_clean < 0.5 || c.end_clean < 0.5).length, clips: out };
}
