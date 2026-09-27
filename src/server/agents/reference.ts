// Style reference: "make my clips like this one". Two optional inputs and one Understand step:
//   Reference clip    a finished short someone else made (uploaded, or a TikTok/Reels/Shorts link)
//   Copy guide        what to copy from it, in your words ("the captions and the fast cuts")
//   Reference style   measures the clip (cut rhythm, speech rate, pauses, faces) and has a multimodal
//                     model watch and listen to it, focused on the copy guide. Out comes a style
//                     profile and a list of checkable traits ("cuts every 1-2 s", "two-word captions
//                     in the centre"). The Brief turns the traits into check rules, and the Coach
//                     uses them to rewrite the outline.
// Stored in <workspace>/references/<id>/ (reference.json + the clip); current.json names the active one.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MODELS, ROOT } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter, pool, probeMedia, run } from "../lib";
import { rel } from "../library";
import { runFaceDetector } from "./framing";
import { timeChunk } from "./transcribe";

export const REF_DIR = join(ROOT, "references");
const CURRENT = join(REF_DIR, "current.json");
const MAX_SECONDS = 180; // a reference is a short; longer files are analysed from the start

export type RefTrait = { key: string; section: string; trait: string; question: string };
export type RefProfile = {
  summary: string; pacing: string; captions: string; framing: string; color: string;
  effects: string; transitions: string; title: string; audio: string; structure: string;
  traits: RefTrait[];
};
export type RefAnalysis = {
  at: number; guide: string; model: string; cost: number;
  duration: number; analysed: number; width: number; height: number;
  shots: number; avg_shot: number; cuts_per_min: number; words_per_min: number; pauses: number;
  transcript: string;
  frames: { t: number; frame: string; faces: number }[];
  profile: RefProfile;
};
export type Reference = { id: string; name: string; file: string; source?: string; at: number; guide: string; analysis?: RefAnalysis };

const readJson = <T,>(f: string): T | null => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
};

export function readReference(): Reference | null {
  const cur = readJson<{ id: string }>(CURRENT);
  return cur ? readJson<Reference>(join(REF_DIR, cur.id.replace(/[^\w-]/g, ""), "reference.json")) : null;
}

export function saveReference(r: Reference) {
  const dir = join(REF_DIR, r.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "reference.json"), JSON.stringify(r, null, 1), "utf8");
  writeFileSync(CURRENT, JSON.stringify({ id: r.id }), "utf8");
  return r;
}

/** A new, empty reference folder; the caller writes the clip into it. Keeps the current copy guide. */
export function newReference(name: string, source?: string) {
  const id = `r${Date.now().toString(36)}`;
  const dir = join(REF_DIR, id);
  mkdirSync(dir, { recursive: true });
  return { id, dir, guide: readReference()?.guide ?? "", name, source };
}

export function setGuide(guide: string) {
  const r = readReference();
  const text = guide.trim().slice(0, 2000);
  if (r) return saveReference({ ...r, guide: text });
  // No clip yet: keep the guide so it's there when one is added.
  mkdirSync(REF_DIR, { recursive: true });
  writeFileSync(join(REF_DIR, "pending-guide.txt"), text, "utf8");
  return { guide: text };
}
export const pendingGuide = () => (existsSync(join(REF_DIR, "pending-guide.txt")) ? readFileSync(join(REF_DIR, "pending-guide.txt"), "utf8") : "");

export function clearReference() {
  rmSync(CURRENT, { force: true });
  return { cleared: true };
}

/** The reference, for prompts: what to copy, what was measured, and the profile. Empty if none. */
export function referenceText(r: Reference | null = readReference()): string {
  const a = r?.analysis;
  if (!r || !a) return "";
  const p = a.profile;
  return [
    `Copy guide (what the editor wants copied): ${r.guide || "(none given: copy the overall style)"}`,
    `Measured: ${a.analysed.toFixed(0)}s${a.analysed < a.duration ? ` of ${a.duration.toFixed(0)}s` : ""}, ${a.width}x${a.height}, ${a.shots} shots (a cut every ${a.avg_shot.toFixed(1)}s, ${a.cuts_per_min.toFixed(0)} per minute), ${a.words_per_min.toFixed(0)} words per minute, ${a.pauses} pauses over 0.6s`,
    `Summary: ${p.summary}`,
    `Pacing: ${p.pacing}`, `Structure: ${p.structure}`, `Captions: ${p.captions}`, `Framing: ${p.framing}`,
    `Colour: ${p.color}`, `Effects: ${p.effects}`, `Transitions: ${p.transitions}`, `Title/text: ${p.title}`, `Audio: ${p.audio}`,
    `Traits to copy:\n${p.traits.map((t) => `- [${t.section}] ${t.trait}`).join("\n")}`,
  ].join("\n");
}

const SECTIONS = ["Clipping tone", "Story structure", "Editing style", "Visual effects", "Captions style", "Title card", "Music"];

async function sceneCuts(ctx: JobContext, file: string, seconds: number) {
  const cuts: number[] = [];
  const r = await run(
    ["ffmpeg", "-hide_banner", "-nostats", "-t", String(seconds), "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.3)',metadata=print:file=-", "-f", "null", "-"],
    { signal: ctx.signal, onStdout: (line) => { const m = line.match(/pts_time:([\d.]+)/); if (m) cuts.push(Number(m[1])); } },
  );
  if (r.code !== 0) throw new Error(`ffmpeg couldn't read the reference: ${r.stderr.slice(-300)}`);
  // Flashes under 0.3s aren't edits.
  return cuts.filter((c, i) => i === 0 || c - cuts[i - 1] >= 0.3);
}

export async function analyzeReference(ctx: JobContext) {
  const r = readReference();
  if (!r) throw new Error("Add a reference clip first.");
  const file = join(ROOT, r.file);
  const dir = join(REF_DIR, r.id);
  const media = await probeMedia(file);
  const win = Math.min(media.duration, MAX_SECONDS);
  let cost = 0;
  const addCost = (c?: number) => ((cost += c ?? 0), ctx.addCost(c));
  ctx.log(`Analysing the reference: ${media.duration.toFixed(0)}s, ${media.width}x${media.height}${win < media.duration ? ` (first ${win}s)` : ""}`);

  // 1. Edit rhythm: shot changes.
  ctx.progress(0.05, "measuring cuts");
  const cuts = await sceneCuts(ctx, file, win);
  const shots = cuts.length + 1;

  // 2. Speech: Whisper word timings → rate and pauses.
  ctx.progress(0.25, "listening");
  const mp3 = join(dir, "audio.mp3");
  rmSync(join(dir, "audio.words.json"), { force: true });
  await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-t", String(win), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", mp3], { signal: ctx.signal });
  let words: { w: string; start: number; end: number }[] = [];
  try {
    words = await timeChunk({ ...ctx, addCost }, mp3);
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`No speech timings (${e instanceof Error ? e.message : e})`, "warn");
  }
  const pauses = words.slice(1).filter((w, i) => w.start - words[i].end > 0.6).length;

  // 3. Frames, with faces measured locally.
  ctx.progress(0.45, "watching");
  const n = Math.min(16, Math.max(6, Math.round(win / 2.5)));
  const frames = Array.from({ length: n }, (_, i) => ({ t: +(((i + 0.5) * win) / n).toFixed(2), frame: join(dir, `f_${String(i + 1).padStart(2, "0")}.jpg`), faces: 0 }));
  await pool(frames, 6, (f) => run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f.t.toFixed(2), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", f.frame], { signal: ctx.signal }), ctx.signal);
  const faces = await runFaceDetector(ctx, frames.map((f) => f.frame));
  for (const f of frames) f.faces = faces?.get(f.frame)?.length ?? 0;

  // 4. One multimodal call: frames + audio + the measurements, focused on the copy guide.
  ctx.progress(0.6, "describing the style");
  const measured = `${shots} shots in ${win.toFixed(0)}s (a cut every ${(win / shots).toFixed(1)}s), ${words.length ? `${Math.round(words.length / (win / 60))} words per minute, ${pauses} pauses over 0.6s` : "no speech timings"}, ${media.width}x${media.height}`;
  const prompt = `You are a video editor studying a finished short-form clip so another pipeline can copy its style.
The editor wants to copy this from it: ${r.guide ? `"${r.guide}"` : "its overall style"}.
Focus on what the copy guide asks for; describe the rest briefly.

Measured from the file: ${measured}.
Speech (Whisper): ${words.map((w) => w.w).join(" ").slice(0, 2500) || "(none)"}
The ${frames.length} frames below are evenly spaced; the audio is attached.

Reply with ONLY JSON:
{"summary": "two sentences on the style",
 "pacing": "cut rhythm, speed, how long shots hold, where it speeds up or slows down",
 "structure": "how it opens, builds and ends",
 "captions": "caption style: position, size, words per line, colours, highlighting, font weight, animation",
 "framing": "shot sizes, how people are framed, split screens, zooms",
 "color": "grade and look",
 "effects": "visual effects",
 "transitions": "how shots join",
 "title": "on-screen titles or text cards",
 "audio": "music, sound effects, voice treatment",
 "traits": [{"key": "snake_case", "section": one of ${JSON.stringify(SECTIONS)}, "trait": "a concrete, copyable property of this clip", "question": "a statement about ANY finished clip, rated 0-1, true when that clip shares the trait, e.g. The clip cuts to a new shot at least every 2 seconds."}]}
Give 5 to 10 traits, most of them about what the copy guide asks for.`;
  const content: any[] = [{ type: "text", text: prompt }];
  for (const f of frames) {
    content.push({ type: "text", text: `Frame at ${f.t.toFixed(1)}s:` });
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(readFileSync(f.frame)).toString("base64")}` } });
  }
  content.push({ type: "input_audio", input_audio: { data: Buffer.from(readFileSync(mp3)).toString("base64"), format: "mp3" } });
  const res = await openrouter({ temperature: 0.2, messages: [{ role: "user", content }] }, MODELS.transcribe, ctx.signal);
  addCost(res.usage?.cost);
  const raw = extractJson(res.content);
  const s = (k: string) => String(raw?.[k] ?? "").slice(0, 600);
  const taken = new Set<string>();
  const traits: RefTrait[] = (Array.isArray(raw?.traits) ? raw.traits : [])
    .map((t: any) => ({ key: `ref_${String(t.key ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 36)}`, section: SECTIONS.includes(t.section) ? t.section : "Editing style", trait: String(t.trait ?? "").slice(0, 240), question: String(t.question ?? "").slice(0, 400) }))
    .filter((t: RefTrait) => t.key.length > 4 && t.question && !taken.has(t.key) && taken.add(t.key))
    .slice(0, 10);
  if (!traits.length) throw new Error("The model didn't return any traits for the reference; try again.");

  r.analysis = {
    at: Date.now(), guide: r.guide, model: res.model, cost,
    duration: media.duration, analysed: win, width: media.width, height: media.height,
    shots, avg_shot: win / shots, cuts_per_min: shots / (win / 60), words_per_min: words.length / (win / 60), pauses,
    transcript: words.map((w) => w.w).join(" "),
    frames: frames.map((f) => ({ ...f, frame: rel(f.frame) })),
    profile: { summary: s("summary"), pacing: s("pacing"), structure: s("structure"), captions: s("captions"), framing: s("framing"), color: s("color"), effects: s("effects"), transitions: s("transitions"), title: s("title"), audio: s("audio"), traits },
  };
  saveReference(r);
  ctx.log(`Reference style: ${traits.length} traits (${traits.map((t) => t.trait.slice(0, 40)).join("; ")})`);
  ctx.progress(1, "reference analysed");
  return { traits: traits.length, shots, cost };
}

/** Analyse the reference if it has none, or its copy guide changed since. Used before coaching. */
export async function ensureReference(ctx: JobContext) {
  const r = readReference();
  if (!r || (r.analysis && r.analysis.guide === r.guide)) return;
  ctx.log(r.analysis ? "The copy guide changed; re-analysing the reference" : "Analysing the style reference first");
  await analyzeReference({ ...ctx, progress: () => {} });
}

/** Save an uploaded clip as the new current reference. */
export async function addReferenceFile(name: string, body: ReadableStream<Uint8Array>) {
  const { id, dir, guide } = newReference(name);
  const safe = basename(name).replace(/[<>:"|?*\x00-\x1f]/g, "_");
  const dest = join(dir, safe);
  const writer = Bun.file(dest).writer();
  for await (const chunk of body) writer.write(chunk);
  await writer.end();
  return saveReference({ id, name: safe, file: rel(dest), at: Date.now(), guide: guide || pendingGuide() });
}
