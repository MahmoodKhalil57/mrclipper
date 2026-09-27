// Client for TypeSafe's System One API on OpenRouter (Jev). Jev doesn't generate text: it takes a
// state plus typed questions and returns calibrated answers:
//   noul   -> probability a proposition is true (0..1)
//   choice -> picked key + probability per option
//   score  -> expected level (0..n-1) over ordered labels, + distribution
import { MODELS } from "./config";
import { MISSING_KEY, openrouterKey } from "./key";
import { sleep } from "./lib";

export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export type Decision = { answers: Record<string, Answer>; cost: number; model: string };

const ENDPOINT = "https://openrouter.ai/api/v1/systemone";

/** One System One call. Keep `state` small: Jev's context is ~32k tokens. Retries transient failures. */
export async function decide(
  state: unknown,
  questions: Record<string, Question>,
  signal?: AbortSignal,
  retries = 3,
): Promise<Decision> {
  const key = openrouterKey();
  if (!key) throw new Error(MISSING_KEY);
  let last: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODELS.jev, state, questions }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (res.ok && data.answers) return { answers: data.answers, cost: data.usage?.cost ?? 0, model: data.model ?? MODELS.jev };
      const msg = JSON.stringify(data.error ?? data).slice(0, 240);
      // Oversized state or a bad question won't get better on retry.
      if (res.status === 400) throw Object.assign(new Error(`Jev rejected the request: ${msg}`), { fatal: true });
      last = new Error(`Jev HTTP ${res.status}: ${msg}`);
    } catch (e) {
      if (signal?.aborted || (e as any)?.fatal) throw e;
      last = e;
    }
    await sleep(800 * attempt, signal);
  }
  throw last;
}

export const noul = (a: Answer | undefined) => (a?.type === "noul" ? a.noul : 0);
/** Normalised 0..1 score for a `score` answer with `levels` labels. */
export const level = (a: Answer | undefined, levels: number) => (a?.type === "score" ? a.score / Math.max(1, levels - 1) : 0);
export const pick = (a: Answer | undefined) =>
  a?.type === "choice" ? { key: a.choice, p: a.probabilities[a.choice] ?? a.confidence } : { key: "", p: 0 };
