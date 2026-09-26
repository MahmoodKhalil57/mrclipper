// The brief: what Jev is asked while planning. System One uses a fixed default. Hybrid has an LLM
// read the outline once and compile it into a brief for this plan: outline-specific questions and
// weights, tone categories, hard gates, and when to use each allowed camera move and transition.
// Jev still answers every question: fast, cheap and consistent across ~1,000 candidates.
import { MODELS } from "../config";
import type { JobContext } from "../jobs";
import { extractJson, openrouter } from "../lib";
import type { EditStyle, Transition, Zoom } from "./edit";

export type BriefQuestion =
  | { key: string; label: string; type: "noul"; instructions: string; weight: number }
  | { key: string; label: string; type: "score"; instructions: string; criteria: string[]; weight: number };

export type JevBrief = {
  source: "default" | "llm";
  model?: string;
  summary: string; // audience/tone summary passed to Jev as part of the state
  opener: BriefQuestion[]; // asked about every possible opening line
  ending: BriefQuestion[]; // asked about every possible closing line
  window: BriefQuestion[]; // asked about every candidate clip
  tones: Record<string, string>;
  preferredTones: string[];
  gates: { key: string; min: number }[]; // window/opener/ending keys a clip must pass
  zoomGuide: Partial<Record<Zoom, string>>; // "use when…" for Jev's per-segment camera choice
  transitionGuide: Partial<Record<Transition, string>>; // "use when…" for Jev's per-gap choice
};

const FIT_LEVELS = ["poor fit", "weak fit", "decent fit", "strong fit", "perfect fit"];

/** System One's fixed brief (the questions Jev has always been asked). */
export function defaultBrief(summary: string): JevBrief {
  return {
    source: "default",
    summary,
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
    zoomGuide: {},
    transitionGuide: {},
  };
}

// ── LLM compile step (hybrid) ──────────────────────────────────────

const COMPILE_PROMPT = (p: { outline: string; feedback: string; notes?: string; sample: string; zooms: string[]; transitions: string[] }) =>
  `You are configuring TypeSafe's Jev, a decision model that cannot write text. It answers typed questions about a
piece of text: "noul" = probability that a proposition is true; "score" = level on an ordered scale. Jev will answer
your questions for every candidate opening line, closing line and clip of a video, and code will rank the clips by
your weights. Translate the editor's outline below into those questions.

# Outline
${p.outline}

# Editor's feedback on earlier takes
${p.feedback || "None."}
${p.notes ? `\n# Direction for this take\n${p.notes}\n` : ""}
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
  "gates": [{"key": "a window/opener/ending key", "min": 0.2-0.5}],       // hard rules from the outline, e.g. respect
  "zoom_guide": {${p.zooms.map((z) => `"${z}": "use when…"`).join(", ")}},
  "transition_guide": {${p.transitions.map((t) => `"${t}": "use when…"`).join(", ")}}
}
Rules:
- Write every instruction in English as a proposition about the given text, e.g. "The laughter fades into a quiet,
  lingering look between the friends." Make them specific to this outline's audience, tone and story rules.
- keys are snake_case, unique; labels are 1-3 words for the UI; weight is 0-3 (0 = only used as a gate).
- score questions need "criteria": 3-5 ordered labels from worst to best.
- zoom_guide and transition_guide describe, in the outline's terms, when each allowed option fits.`;

const KEY = /^[a-z][a-z0-9_]{1,30}$/;
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

/**
 * Hybrid: one LLM call turns the outline (plus feedback and direction) into a Jev brief.
 * Anything malformed falls back to the default brief's part, so the plan never fails on it.
 */
export async function compileBrief(
  ctx: JobContext,
  p: { outline: string; feedback: string; notes?: string; sample: string; style: EditStyle; summary: string },
): Promise<JevBrief> {
  const base = defaultBrief(p.summary);
  const zooms = p.style.zooms.filter((z) => z !== "none");
  const transitions = p.style.transitions;
  ctx.log(`Compiling the outline into Jev's brief with ${MODELS.plan[0]}`);
  let raw: any;
  let model = MODELS.plan[0];
  try {
    const res = await openrouter(
      { temperature: 0.3, messages: [{ role: "user", content: COMPILE_PROMPT({ ...p, zooms, transitions }) }] },
      MODELS.plan, ctx.signal,
    );
    ctx.addCost(res.usage?.cost);
    model = res.model;
    raw = extractJson(res.content);
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Brief compile failed (${e instanceof Error ? e.message : e}); using System One's default brief`, "warn");
    return base;
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
  const allKeys = new Set([...(opener ?? base.opener), ...(ending ?? base.ending), ...(window ?? base.window)].map((q) => q.key));
  const gates = (Array.isArray(raw.gates) ? raw.gates : [])
    .filter((g: any) => allKeys.has(String(g?.key)))
    // Gates are safety floors, not taste: capped low and few, or a stylised outline rejects every clip.
    .map((g: any) => ({ key: String(g.key), min: Math.max(0.1, Math.min(0.5, Number(g.min) || 0.3)) }))
    .slice(0, 2);
  const guide = <T extends string>(obj: any, allowed: readonly T[]) =>
    Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => allowed.includes(k as T) && String(v).trim()).map(([k, v]) => [k, String(v).slice(0, 200)])) as Partial<Record<T, string>>;

  const brief: JevBrief = {
    source: "llm",
    model,
    summary: String(raw.summary ?? "").trim().slice(0, 1200) || base.summary,
    opener: opener ?? base.opener,
    ending: ending ?? base.ending,
    window: window ?? base.window,
    tones: Object.keys(tones).length >= 3 ? tones : base.tones,
    preferredTones: (Array.isArray(raw.preferred_tones) ? raw.preferred_tones : []).map(String).filter((t: string) => t in tones),
    gates: gates.length ? gates : window ? [] : base.gates,
    zoomGuide: guide(raw.zoom_guide, zooms),
    transitionGuide: guide(raw.transition_guide, transitions),
  };
  const fell = [!opener && "openers", !ending && "endings", !window && "clip questions", Object.keys(tones).length < 3 && "tones"].filter(Boolean);
  ctx.log(
    `Brief: ${brief.opener.length} opener, ${brief.ending.length} ending and ${brief.window.length} clip questions; ` +
      `tones ${Object.keys(brief.tones).join(", ")}${brief.preferredTones.length ? ` (preferring ${brief.preferredTones.join(", ")})` : ""}` +
      `${brief.gates.length ? `; gates ${brief.gates.map((g) => `${g.key}≥${g.min}`).join(", ")}` : ""}` +
      `${fell.length ? `; default used for ${fell.join(", ")}` : ""}`,
  );
  return brief;
}

// ── LLM finishing step (hybrid): titles and emphasis for the final clips only ──

export async function finishClips(
  ctx: JobContext,
  brief: JevBrief,
  clips: { id: number; lines: string[] }[],
): Promise<Record<number, { title?: string; hook_title?: string; emphasis?: string[]; why?: string }>> {
  if (!clips.length) return {};
  const prompt = `You are finishing short-form clips that were chosen by a scoring model.
Brief: ${brief.summary}

For each clip, write:
- "title": a 2-5 word English working title
- "hook_title": the on-screen hook card, in the clip's own language and dialect, max 8 words, not a quote of the first line
- "emphasis": 1-3 exact words copied from the clip's transcript that carry its feeling
- "why": one English sentence on why it fits the brief

${clips.map((c) => `## Clip ${c.id}\n${c.lines.join("\n").slice(0, 2500)}`).join("\n\n")}

Reply with ONLY JSON: {"clips": [{"id": 1, "title": "...", "hook_title": "...", "emphasis": ["..."], "why": "..."}]}`;
  try {
    const res = await openrouter({ temperature: 0.5, messages: [{ role: "user", content: prompt }] }, MODELS.plan, ctx.signal);
    ctx.addCost(res.usage?.cost);
    const out: Record<number, any> = {};
    for (const c of extractJson(res.content).clips ?? []) out[Number(c.id)] = c;
    ctx.log(`Wrote titles and emphasis for ${Object.keys(out).length} clips with ${res.model}`);
    return out;
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    ctx.log(`Title pass failed (${e instanceof Error ? e.message : e}); keeping placeholder titles`, "warn");
    return {};
  }
}
