// Step 3 · Brief (LLM writes). The one place an LLM turns your inputs into what every judge uses:
//   pick     the questions Jev asks about every opening line, closing line and candidate clip,
//            with weights, tone categories and safety gates
//   design   when each allowed camera move and transition fits, and how hook cards should read
//   check    the rules Jev rates every finished clip on (outline rules + the style reference's traits)
// It reads the outline, the style reference and its copy guide, your notes and a transcript sample.
// Cached per video in transcripts/<video>/brief.json and rewritten only when the outline or the
// reference changes, so re-running the workflow costs no LLM call. If the LLM fails, a built-in
// brief takes over: the workflow never stops on it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { MODELS, WRITER } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter } from "../lib";
import { OUTLINE_FILE, readText, readTranscript, transcriptDir } from "../library";
import { feedbackDigest } from "../review";
import { readEditStyle, type EditStyle, type Transition, type Zoom } from "./edit";
import { readReference, referenceText, type Reference } from "./reference";
import { audienceSummary, clipStr, hashText, sectionsOf } from "./text";

export type BriefQuestion =
  | { key: string; label: string; type: "noul"; instructions: string; weight: number }
  | { key: string; label: string; type: "score"; instructions: string; criteria: string[]; weight: number };

export type CheckRule = { key: string; section: string; rule: string; question: string };

export type Brief = {
  source: "default" | "llm";
  model?: string;
  /** Audience, feeling and what to avoid, in a few sentences: part of every Jev state. */
  summary: string;
  pick: {
    opener: BriefQuestion[]; // asked about every possible opening line
    ending: BriefQuestion[]; // asked about every possible closing line
    window: BriefQuestion[]; // asked about every candidate clip
    tones: Record<string, string>;
    preferredTones: string[];
    gates: { key: string; min: number }[]; // safety floors a clip must pass
  };
  design: {
    zoomGuide: Partial<Record<Zoom, string>>; // "use when…" for Jev's per-part camera move
    transitionGuide: Partial<Record<Transition, string>>; // "use when…" for Jev's per-gap transition
    titleGuide: string; // how the hook card should read (language, length, tone)
  };
  check: CheckRule[];
};

export type BriefFile = { at: number; inputs: string; outline_hash: string; reference: string; cost: number; brief: Brief };

export const briefPath = (video: string) => join(transcriptDir(video), "brief.json");

/** Which reference the brief was built with: changes when a clip is added or re-analysed. */
export const referenceFingerprint = (ref: Reference | null = readReference()) =>
  !ref ? "none" : `${ref.id}:${ref.analysis?.at ?? "unanalysed"}`;

/** The brief's inputs, hashed: what decides whether a cached brief is still current. */
/** Bump when the Brief's prompt or output changes, so briefs (and the takes made from them) are made again. */
export const BRIEF_VERSION = 2;

/** What a brief is made from. Its hash is the brief's cache key, and each take records it. */
export function briefInputs(video: string) {
  const outline = readText(OUTLINE_FILE);
  const outlineHash = hashText(outline);
  const reference = referenceFingerprint();
  return { outline, outlineHash, reference, hash: hashText(`${basename(video)}|${outlineHash}|${reference}|v${BRIEF_VERSION}`) };
}

export function readBrief(video: string): BriefFile | null {
  try {
    const f = briefPath(video);
    const b = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as BriefFile) : null;
    return b?.brief?.pick ? b : null; // briefs from before the workflow update have another shape
  } catch {
    return null;
  }
}

// ── the built-in brief ───────────────────────────────────────────────

const FIT_LEVELS = ["poor fit", "weak fit", "decent fit", "strong fit", "perfect fit"];
const SKIP = /^(settings|previous clip attempts|music|extra notes)/i;

/** Outline rules and reference traits as check rules, without an LLM. */
function defaultRules(outline: string, ref: Reference | null): CheckRule[] {
  const rules: CheckRule[] = sectionsOf(outline)
    .filter((s) => !SKIP.test(s.name) && s.body.trim())
    .map((s, i) => ({
      key: `s${i + 1}`, section: s.name, rule: clipStr(s.body.replace(/\s+/g, " "), 120),
      question: `The finished clip follows this part of the outline (${s.name}): "${clipStr(s.body.replace(/\s+/g, " "), 350)}"`,
    }));
  return [...rules, ...referenceRules(ref)];
}

/** The style reference's traits, as rules: how close the finished clips come to the reference. */
function referenceRules(ref: Reference | null): CheckRule[] {
  return (ref?.analysis?.profile.traits ?? []).map((t) => ({ key: t.key, section: t.section, rule: `Like the reference: ${t.trait}`, question: t.question }));
}

export function defaultBrief(outline: string, ref: Reference | null = readReference()): Brief {
  return {
    source: "default",
    summary: audienceSummary(outline),
    pick: {
      opener: [
        { key: "hook", label: "Hook", type: "noul", weight: 2, instructions: "The opening line would stop a fast-scrolling viewer within three seconds: surprising, funny, provocative, or a gripping question." },
        { key: "cold", label: "Works cold", type: "noul", weight: 1.5, instructions: "The opening line makes sense to someone who has not seen anything before it (no dangling 'this', 'as I said', or unexplained references)." },
      ],
      ending: [
        { key: "payoff", label: "Lands", type: "noul", weight: 1.5, instructions: "The closing line lands as an ending: a punchline, a striking fact, or an open question that lingers." },
        { key: "complete", label: "Ends clean", type: "noul", weight: 1.5, instructions: "The thought is complete at the closing line; the line after it does not continue the same sentence or argument." },
      ],
      window: [
        { key: "fit", label: "Fits outline", type: "score", weight: 3, criteria: FIT_LEVELS, instructions: "How well does this clip fit the audience and tone described in the brief?" },
        { key: "standalone", label: "Stands alone", type: "noul", weight: 2, instructions: "The clip makes sense on its own, with a clear setup and payoff, without needing the rest of the video." },
        { key: "respectful", label: "Respectful", type: "noul", weight: 0, instructions: "The clip treats any sensitive subject (violence, colonialism, race) seriously and does not mock victims." },
      ],
      tones: {
        funny: "Comedy: jokes, sarcasm, absurd comparisons",
        shocking_fact: "A surprising or shocking fact or number",
        emotional: "Moving, sad or uplifting human story",
        explainer: "Clear explanation of how or why something happened",
        provocative: "A challenge to what the audience believes",
      },
      preferredTones: [],
      gates: [{ key: "respectful", min: 0.4 }],
    },
    design: {
      zoomGuide: {},
      transitionGuide: {},
      titleGuide: "At most 8 words in the clip's own language and dialect. Tease the moment; don't quote the first line or give away the payoff.",
    },
    check: defaultRules(outline, ref),
  };
}

// ── the LLM brief ────────────────────────────────────────────────────

const KEY = /^[a-z][a-z0-9_]{1,36}$/;
const RESERVED = new Set(["tone", "direction", "against", "visual", "vertical", "overall", "repeat"]);

function cleanQuestions(raw: any, allowScore: boolean, min: number, max: number, taken: Set<string>): BriefQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BriefQuestion[] = [];
  for (const q of raw) {
    const key = String(q?.key ?? "").toLowerCase();
    const instructions = String(q?.instructions ?? "").trim();
    if (!KEY.test(key) || RESERVED.has(key) || taken.has(key) || instructions.length < 12) continue;
    const weight = Math.max(0, Math.min(3, Number(q.weight) || 1));
    const label = String(q.label ?? key).slice(0, 24);
    if (allowScore && q.type === "score") {
      const criteria = Array.isArray(q.criteria) ? q.criteria.map(String).filter(Boolean).slice(0, 6) : [];
      if (criteria.length < 3) continue;
      out.push({ key, label, type: "score", instructions: instructions.slice(0, 400), criteria, weight });
    } else {
      out.push({ key, label, type: "noul", instructions: instructions.slice(0, 400), weight });
    }
    taken.add(key);
    if (out.length >= max) break;
  }
  return out.length >= min ? out : null;
}

const PROMPT = (p: { outline: string; feedback: string; sample: string; zooms: string[]; transitions: string[]; reference: string }) =>
  `You configure TypeSafe's Jev for a short-form clipping pipeline. Jev is a decision model that cannot write text: it answers typed
questions about a piece of text ("noul" = probability a proposition is true; "score" = level on an ordered scale; "choice" = pick
one of named options). Jev will answer your questions for every candidate opening line, closing line and clip of a video, choose
camera moves and transitions, pick hook cards, and check every finished clip against your rules. Translate the editor's inputs below.

# Outline
${p.outline}
${p.reference ? `\n# Style reference: the editor wants the clips to copy this, as far as the copy guide says\n${p.reference}\n` : ""}
# The editor's notes and reviews so far
${p.feedback || "None."}

# A sample of the transcript (for language and content, not for choosing)
${p.sample}

# What to return
Reply with ONLY JSON:
{
  "summary": "3-5 sentences in English: who the clips are for, the feeling they must create, what to avoid",
  "opener": [{"key","label","type":"noul","instructions","weight"}],      // 2-3 questions about ONE opening line
  "ending": [{"key","label","type":"noul","instructions","weight"}],      // 2-3 questions about ONE closing line
  "window": [{"key","label","type":"noul"|"score","instructions","weight","criteria"?}], // 4-7 questions about a whole clip
  "tones": {"snake_key": "one-line description"},                        // 4-6 tone categories that fit THIS outline
  "preferred_tones": ["snake_key"],                                       // the outline's target tones (subset)
  "gates": [{"key": "an opener/ending/window key", "min": 0.2-0.5}],      // safety floors only, e.g. respect
  "zoom_guide": {${p.zooms.map((z) => `"${z}": "use when…"`).join(", ")}},
  "transition_guide": {${p.transitions.map((t) => `"${t}": "use when…"`).join(", ")}},
  "title_guide": "how the hook card should read: language and dialect, length, tone, what to avoid",
  "check_rules": [{"key","section","rule","question"}]                    // 5-10 rules a FINISHED clip must meet
}
Rules:
- Write every instruction and question in English as a proposition about the given text, specific to this outline's audience,
  tone and story rules, e.g. "The laughter fades into a quiet, lingering look between the friends."
- opener, ending and window questions are asked about the SOURCE: the transcript lines and what the shots show, before any
  editing. Don't ask them about camera moves, flashbacks, transitions, captions or anything else the edit adds; rules about the
  edit belong in check_rules.
- keys are snake_case and unique; labels are 1-3 words; weight is 0-3 (0 = only used as a gate).
- score questions need "criteria": 3-5 ordered labels from worst to best.
- check_rules: "section" is the exact outline section the rule comes from; "question" is a statement about ONE finished clip that
  Jev rates 0-1. The renderer already applies the outline's bold settings to every clip (which transitions and zooms are allowed,
  transition length, pause trimming, segments per clip, caption font, size, colours, position and words per caption, colour grade,
  vignette, grain, glow, bars, fades, the flashback look, title duration and position), so don't write rules that only restate them.
  Write rules for what needs judgement: how the story opens and ends, the tone, whether people are well framed, whether the camera
  moves, flashbacks and emphasis words fit their moments, and the hook card's wording.${p.reference ? `
- The style reference: reflect what the copy guide asks to copy in the questions, the guides and the title guide.` : ""}`;

export async function compileBrief(ctx: JobContext, video: string): Promise<{ brief: Brief; cost: number }> {
  const outline = readText(OUTLINE_FILE);
  if (!outline.trim()) throw new Error("The outline is empty. Write one in the Outline node first.");
  const segs = readTranscript(video) ?? [];
  const ref = readReference();
  const base = defaultBrief(outline, ref);
  const style: EditStyle = readEditStyle(outline);
  const zooms = style.zooms.filter((z) => z !== "none");
  const transitions = style.transitions;
  const sample = segs.filter((_, i) => i % Math.max(1, Math.floor(segs.length / 40)) === 0).slice(0, 40).map((s) => s.text).join("\n");
  const reference = ref?.analysis ? referenceText(ref) : "";
  ctx.log(`Writing the brief with ${MODELS.plan[0]}${reference ? ", including the style reference" : ""}`);
  let raw: any;
  let model = MODELS.plan[0];
  let cost = 0;
  try {
    const res = await openrouter(
      { temperature: 0.3, ...WRITER, messages: [{ role: "user", content: PROMPT({ outline, feedback: clipStr(feedbackDigest(video), 1500), sample: clipStr(sample, 3000), zooms, transitions, reference }) }] },
      MODELS.plan, ctx.signal,
    );
    ctx.addCost(res.usage?.cost);
    cost = res.usage?.cost ?? 0;
    model = res.model;
    ctx.log(`${res.model} via ${res.provider ?? "OpenRouter"}: ${res.usage?.completion_tokens ?? "?"} tokens, ${cost.toFixed(4)}`);
    raw = extractJson(res.content);
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`The LLM brief failed (${e instanceof Error ? e.message : e}); using the built-in brief`, "warn");
    return { brief: base, cost };
  }
  const taken = new Set<string>();
  const opener = cleanQuestions(raw.opener, false, 1, 3, taken);
  const ending = cleanQuestions(raw.ending, false, 1, 3, taken);
  const window = cleanQuestions(raw.window, true, 2, 7, taken);
  const tones: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.tones ?? {})) {
    const key = k.toLowerCase();
    if (KEY.test(key) && String(v).trim() && Object.keys(tones).length < 6) tones[key] = String(v).slice(0, 160);
  }
  const allKeys = new Set([...(opener ?? base.pick.opener), ...(ending ?? base.pick.ending), ...(window ?? base.pick.window)].map((q) => q.key));
  const gates = (Array.isArray(raw.gates) ? raw.gates : [])
    .filter((g: any) => allKeys.has(String(g?.key)))
    // Gates are safety floors, not taste: capped low and few, or a stylised outline rejects every clip.
    .map((g: any) => ({ key: String(g.key), min: Math.max(0.1, Math.min(0.5, Number(g.min) || 0.3)) }))
    .slice(0, 2);
  const guide = <T extends string>(obj: any, allowed: readonly T[]) =>
    Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => allowed.includes(k as T) && String(v).trim()).map(([k, v]) => [k, String(v).slice(0, 200)])) as Partial<Record<T, string>>;
  const sections = new Set(sectionsOf(outline).map((s) => s.name));
  const ruleKeys = new Set<string>();
  const rules: CheckRule[] = (Array.isArray(raw.check_rules) ? raw.check_rules : [])
    .map((r: any) => ({ key: String(r?.key ?? "").toLowerCase(), section: String(r?.section ?? ""), rule: String(r?.rule ?? "").slice(0, 200), question: String(r?.question ?? "").slice(0, 400) }))
    .filter((r: CheckRule) => KEY.test(r.key) && r.question && !ruleKeys.has(r.key) && ruleKeys.add(r.key))
    .map((r: CheckRule) => ({ ...r, section: sections.has(r.section) ? r.section : "" }))
    .slice(0, 10);
  // The reference's own traits are always checked, whatever the LLM wrote.
  const refRules = referenceRules(ref).filter((r) => !ruleKeys.has(r.key));

  const brief: Brief = {
    source: "llm",
    model,
    summary: String(raw.summary ?? "").trim().slice(0, 1200) || base.summary,
    pick: {
      opener: opener ?? base.pick.opener,
      ending: ending ?? base.pick.ending,
      window: window ?? base.pick.window,
      tones: Object.keys(tones).length >= 3 ? tones : base.pick.tones,
      preferredTones: (Array.isArray(raw.preferred_tones) ? raw.preferred_tones : []).map(String).filter((t: string) => t in tones),
      gates: gates.length ? gates : window ? [] : base.pick.gates,
    },
    design: {
      zoomGuide: guide(raw.zoom_guide, zooms),
      transitionGuide: guide(raw.transition_guide, transitions),
      titleGuide: String(raw.title_guide ?? "").trim().slice(0, 400) || base.design.titleGuide,
    },
    check: rules.length >= 3 ? [...rules, ...refRules] : base.check,
  };
  const fell = [!opener && "openers", !ending && "endings", !window && "clip questions", Object.keys(tones).length < 3 && "tones", rules.length < 3 && "check rules"].filter(Boolean);
  ctx.log(
    `Brief: ${brief.pick.opener.length} opener, ${brief.pick.ending.length} ending and ${brief.pick.window.length} clip questions; ` +
      `tones ${Object.keys(brief.pick.tones).join(", ")}; ${brief.check.length} check rules${refRules.length ? ` (${refRules.length} from the reference)` : ""}` +
      `${fell.length ? `; built-in used for ${fell.join(", ")}` : ""}`,
  );
  return { brief, cost };
}

/** Step 3: write the brief for a video and cache it with the inputs it was built from. */
export async function buildBrief(ctx: JobContext, video: string) {
  if (!readTranscript(video)?.length) throw new Error("The brief reads a transcript sample; transcribe the video first.");
  const inputs = briefInputs(video);
  ctx.progress(0.1, "LLM writing the brief");
  const { brief, cost } = await compileBrief(ctx, video);
  mkdirSync(transcriptDir(video), { recursive: true });
  const file: BriefFile = { at: Date.now(), inputs: inputs.hash, outline_hash: inputs.outlineHash, reference: inputs.reference, cost, brief };
  writeFileSync(briefPath(video), JSON.stringify(file, null, 1), "utf8");
  ctx.progress(1, "brief ready");
  const questions = brief.pick.opener.length + brief.pick.ending.length + brief.pick.window.length;
  return { questions, rules: brief.check.length, source: brief.source };
}

/** The current brief for a video, writing it first if it's missing or out of date. */
export async function currentBrief(ctx: JobContext, video: string): Promise<{ brief: Brief; inputs: string }> {
  const inputs = briefInputs(video).hash;
  const cached = readBrief(video);
  if (cached && cached.inputs === inputs) return { brief: cached.brief, inputs };
  ctx.log(cached ? "The outline or reference changed since the brief; rewriting it" : "No brief yet; writing it");
  await buildBrief({ ...ctx, progress: () => {} }, video);
  return { brief: readBrief(video)!.brief, inputs };
}
