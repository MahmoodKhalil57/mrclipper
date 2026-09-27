// Step 4c · Music (LLM writes, Jev judges, Lyria makes): a score made for each clip of a take, so every
// clip sounds like itself. When the outline asks for it (`**Music source:** generate`), or you press
// ▶ Score clips on the Music node:
//   1. the LLM reads one clip (what's said, with times, how long it runs), the outline's music notes, the
//      brief and the style reference's audio, and writes three instrumental prompts shaped to that clip:
//      where it stays sparse, where it swells, where it drops out, how it ends
//   2. Jev picks the prompt that suits the clip
//   3. Google's Lyria 3 makes it: Pro writes a full piece ($0.08), `generate clip` a 30-second one ($0.04)
// Scores are saved with the take (music/clip_01.mp3…, music.json) and play under their whole clip, ducked
// under speech. Each is remembered by what it was made from, so it's made once per clip: re-running the
// step, redesigning or re-rendering costs nothing more, and only a new take (or a changed version of this
// step) makes new ones. Lyria follows the requested shape loosely (a 45-second request came back 63 s long,
// its build on cue and its ending late), so the render fades the score out with the clip.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS, WRITER } from "../config";
import type { JobContext } from "../jobs";
import { decide } from "../jev";
import { extractJson, measureLoudness, openrouter, openrouterAudio, pool, probeMedia } from "../lib";
import { readClipData, readText, readTranscript, runDir } from "../library";
import { droppedClips } from "../review";
import { takeBrief, type Brief } from "../agents/brief";
import { takeStyle, type EditStyle } from "../agents/edit";
import { readReference, type Reference } from "../agents/reference";
import { clipStr, hashText, sectionsOf } from "../agents/text";
import { loadCatalog } from "./catalog";
import { layout } from "./timeline";

export const LYRIA = { pro: "google/lyria-3-pro-preview", clip: "google/lyria-3-clip-preview" } as const;
/** Listed prices per track, used when OpenRouter doesn't report the cost. */
export const LYRIA_PRICE = { pro: 0.08, clip: 0.04 } as const;
/** Bump when the prompts change, so takes are scored again with the new ones. */
export const MUSIC_VERSION = 2;

export type ClipScore = {
  key: string; file: string; name: string; model: string; seconds: number; lufs?: number; cost: number; at: number;
  /** The prompts the LLM wrote, Jev's odds, the one it picked. */
  options: { key: string; name: string; prompt: string }[]; odds: Record<string, number>; chosen: string;
};
export type MusicFile = { at: number; cost: number; clips: Record<string, ClipScore> };

const musicFile = (runId: string) => join(runDir(runId), "music.json");

export function readMusic(runId: string): MusicFile | null {
  try {
    return existsSync(musicFile(runId)) ? JSON.parse(readFileSync(musicFile(runId), "utf8")) : null;
  } catch {
    return null;
  }
}

/** The outline asks for music made for its clips. */
export const musicWanted = (style: EditStyle) => !!style.music?.on && style.music.source === "generate" && !style.music.file;

/** The outline's music notes (not its volume or source lines) and the reference's audio: what a score follows. */
export function musicNotes(outline: string, style: EditStyle, reference: Reference | null) {
  const section = sectionsOf(outline).find((s) => /^music/i.test(s.name))?.body ?? "";
  const prose = section.split("\n").filter((l) => !/\*\*(Background music|Music volume|Music source):\*\*/i.test(l)).join("\n").trim();
  const tone = sectionsOf(outline).find((s) => /tone/i.test(s.name))?.body ?? "";
  const notes = [style.music?.mood && `Mood: ${style.music.mood}`, prose].filter(Boolean).join("\n") || clipStr(tone, 800);
  return { notes, refAudio: reference?.analysis?.profile.audio ?? "" };
}

/** What a clip's score is made from: the take and the clip, the music notes, the model and this step's version. */
export const scoreKey = (runId: string, clipId: number, notes: string, refAudio: string, model: string) =>
  hashText(JSON.stringify({ v: MUSIC_VERSION, take: runId, clip: clipId, notes, refAudio, model }));

/** Where each kept clip stands: scored from its current inputs, or not. For the workflow node. */
export function musicStatus(runId: string) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const style = takeStyle(readText(join(dir, "outline.md")), data.edit_style);
  const { notes, refAudio } = musicNotes(readText(join(dir, "outline.md")), style, readReference());
  const model = LYRIA[style.music?.model ?? "pro"];
  const m = readMusic(runId);
  const dropped = new Set(droppedClips(runId));
  const kept = data.clips.filter((c) => !dropped.has(c.id));
  const current = (id: number) => {
    const s = m?.clips[id];
    return !!s && s.key === scoreKey(runId, id, notes, refAudio, model) && existsSync(join(dir, s.file));
  };
  return {
    wanted: musicWanted(style), total: kept.length, file: m,
    /** The outline turns music on, and whether it names the one track every clip plays. */
    on: !!style.music?.on, named: !!style.music?.file,
    scored: kept.filter((c) => current(c.id)).map((c) => c.id),
    missing: kept.filter((c) => !current(c.id)).map((c) => c.id),
    cost: Object.values(m?.clips ?? {}).reduce((n, s) => n + (s.cost ?? 0), 0),
  };
}

/** The score for one clip, for the renderer: its file, loudness, length and a fingerprint. */
export function scoreFor(runId: string, clipId: number): { file: string; lufs?: number; seconds: number; key: string } | null {
  const s = readMusic(runId)?.clips[clipId];
  if (!s) return null;
  const file = join(runDir(runId), s.file);
  return existsSync(file) ? { file, lufs: s.lufs, seconds: s.seconds, key: s.key } : null;
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(0).padStart(2, "0")}`;

/** Score every kept clip of a take that doesn't have a current score (or `only` these). */
export async function scoreTake(ctx: JobContext, runId: string, opts: { only?: number[] } = {}) {
  const dir = runDir(runId);
  const data = readClipData(join(dir, "clip_script.md"));
  const outline = readText(join(dir, "outline.md"));
  const style = takeStyle(outline, data.edit_style);
  const brief: Brief = takeBrief(runId, data.video);
  const segs = readTranscript(data.video) ?? [];
  const reference = readReference();
  const { notes, refAudio } = musicNotes(outline, style, reference);
  const which = style.music?.model ?? "pro";
  const model = LYRIA[which];
  const cat = loadCatalog();
  const status = musicStatus(runId);
  const todo = data.clips.filter((c) => (opts.only?.length ? opts.only.includes(c.id) : status.missing.includes(c.id)) && c.edit?.segments?.length);
  const file: MusicFile = status.file ?? { at: Date.now(), cost: 0, clips: {} };
  if (!todo.length) {
    ctx.log("Every kept clip already has its score");
    return { run: runId, scored: [], cost: 0 };
  }
  ctx.log(`Scoring ${todo.length} clip${todo.length > 1 ? "s" : ""}: for each, the LLM writes three prompts, Jev picks one, ${model.split("/").pop()} makes it ($${LYRIA_PRICE[which].toFixed(2)} each)`);
  mkdirSync(join(dir, "music"), { recursive: true });
  let spent = 0, done = 0;
  const addCost = (c?: number) => ((spent += c ?? 0), ctx.addCost(c));
  const save = () => writeFileSync(musicFile(runId), JSON.stringify({ ...file, at: Date.now(), cost: Object.values(file.clips).reduce((n, s) => n + (s.cost ?? 0), 0) }, null, 1), "utf8");

  await pool(todo, 3, async (c) => {
    const e = c.edit!;
    const map = layout(e, style, cat, segs);
    const seconds = Math.round(map.duration);
    // What happens in the clip, on its own timeline: the planner's view, in lines of words with times.
    const lines: string[] = [];
    let cur: string[] = [], at = 0;
    for (const w of map.words) {
      if (!cur.length) at = w.t;
      cur.push(w.w);
      if (cur.length >= 10) (lines.push(`[${mmss(at)}] ${cur.join(" ")}`), (cur = []));
    }
    if (cur.length) lines.push(`[${mmss(at)}] ${cur.join(" ")}`);
    const quiet = map.parts.map((p, i) => `part ${i + 1}: ${mmss(p.t0)}-${mmss(p.t1)}${e.segments[i]?.freeze ? ` (holds still at the end)` : ""}`).join("; ");
    const key = scoreKey(runId, c.id, notes, refAudio, model);

    // 1. The LLM writes three prompts for this clip.
    let options: ClipScore["options"] = [];
    try {
      const res = await openrouter({
        temperature: 0.9, ...WRITER,
        messages: [{ role: "user", content: `You write prompts for Google's Lyria 3, a music generation model, to score ONE short vertical video clip.
The music plays quietly under people talking, so it must be instrumental and leave room for speech.

Who the clips are for, and the feeling: ${clipStr(brief.summary, 1000)}
The editor's music notes:
${notes}${refAudio ? `\nThe audio of the style reference the editor wants to copy: ${refAudio}` : ""}

The clip runs ${seconds} seconds (${quiet}). What is said, with times:
${clipStr(lines.join("\n"), 3500)}

Write three genuinely different prompts for this clip (different instruments or a different reading of the moment), each 50-90 words:
- start with "Instrumental, no vocals. About ${seconds} seconds long."
- follow this clip's shape with times: where the music stays sparse under talk, where it swells (a laugh, a reveal, the payoff), where it drops away (a pause, a look), and how it ends at ${mmss(seconds)}
- name the instruments, the tempo in BPM, and the key, mode or maqam
- keep it out of the voice's way: no busy lead in the speech range, no drums unless the notes ask for them
- no artist names, song titles or lyrics
Give each a 2-4 word English name.
Reply with ONLY JSON: {"options": [{"name": "...", "prompt": "..."}]}` }],
      }, MODELS.plan, ctx.signal);
      addCost(res.usage?.cost);
      options = (extractJson(res.content).options ?? [])
        .map((o: any, i: number) => ({ key: String.fromCharCode(97 + i), name: String(o?.name ?? "").slice(0, 40), prompt: String(o?.prompt ?? "").trim().slice(0, 1000) }))
        .filter((o: ClipScore["options"][number]) => o.prompt.length > 30)
        .slice(0, 3);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Clip ${c.id}: the LLM couldn't write prompts (${err instanceof Error ? err.message : err}); using the outline's notes`, "warn");
    }
    if (!options.length) options = [{ key: "a", name: style.music?.mood || "score", prompt: `Instrumental, no vocals. About ${seconds} seconds long. A quiet, sparse score that leaves room for speech. ${notes}`.slice(0, 1000) }];

    // 2. Jev picks one.
    let chosen = options[0];
    let odds: Record<string, number> = { [chosen.key]: 1 };
    if (options.length > 1) {
      try {
        const d = await decide(
          { brief: clipStr(brief.summary, 1200), music_notes: clipStr(notes, 1200), clip_transcript: clipStr(lines.join("\n"), 2500), ...(refAudio ? { style_reference_audio: clipStr(refAudio, 500) } : {}) },
          { music: { type: "choice", instructions: "Which music would score this clip best: quiet under its speech, following its moments and the editor's music notes?", criteria: Object.fromEntries(options.map((o) => [o.key, `${o.name}: ${o.prompt}`])) } },
          ctx.signal,
        );
        addCost(d.cost);
        const a = d.answers.music;
        if (a?.type === "choice") {
          chosen = options.find((o) => o.key === a.choice) ?? chosen;
          odds = a.probabilities;
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`Clip ${c.id}: Jev couldn't compare the prompts (${err instanceof Error ? err.message : err}); using the first`, "warn");
      }
    }

    // 3. Lyria makes it. Now and then it answers with section markers and no audio: then Jev's runner-up
    // prompt gets a go. Only what OpenRouter reports as spent is counted.
    try {
      const order = [chosen, ...options.filter((o) => o !== chosen).sort((x, y) => (odds[y.key] ?? 0) - (odds[x.key] ?? 0))].slice(0, 2);
      let res: Awaited<ReturnType<typeof openrouterAudio>> | null = null;
      let cost = 0;
      for (const o of order) {
        const r = await openrouterAudio({ messages: [{ role: "user", content: o.prompt }] }, model, ctx.signal);
        const spent = r.cost ?? (r.audio.length ? LYRIA_PRICE[which] : 0);
        cost += spent;
        addCost(spent);
        if (r.audio.length) {
          if (o !== chosen) ctx.log(`Clip ${c.id}: Lyria returned no audio for "${chosen.name}", so it made Jev's runner-up "${o.name}"`, "warn");
          res = r;
          chosen = o;
          break;
        }
      }
      if (!res) throw new Error(`${model} returned no audio for either prompt`);
      const rel = `music/clip_${String(c.id).padStart(2, "0")}.mp3`;
      writeFileSync(join(dir, rel), res.audio);
      const len = await probeMedia(join(dir, rel)).then((x) => +x.duration.toFixed(1)).catch(() => 0);
      const lufs = (await measureLoudness(join(dir, rel)).catch(() => null)) ?? undefined;
      file.clips[c.id] = { key, file: rel, name: chosen.name, model: res.model, seconds: len, ...(lufs !== undefined ? { lufs: +lufs.toFixed(1) } : {}), cost, at: Date.now(), options, odds, chosen: chosen.key };
      save();
      ctx.log(`Clip ${c.id}: "${chosen.name}" (Jev ${Math.round((odds[chosen.key] ?? 1) * 100)}%), ${len}s from ${res.model.split("/").pop()} ($${cost.toFixed(2)})`);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Clip ${c.id}: Lyria couldn't make the score (${err instanceof Error ? err.message : err})`, "warn");
    }
    ctx.progress(++done / todo.length, `scored ${done}/${todo.length}`);
  }, ctx.signal);

  const scored = todo.filter((c) => file.clips[c.id]?.key === scoreKey(runId, c.id, notes, refAudio, model)).map((c) => c.id);
  if (!scored.length) throw new Error("Lyria couldn't make any of the scores; see the log");
  ctx.log(`Music done: ${scored.length}/${todo.length} clips scored ($${spent.toFixed(3)})`);
  return { run: runId, scored, cost: spent };
}
