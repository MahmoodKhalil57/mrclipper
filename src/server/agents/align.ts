// Word-level timing for the transcript.
//
// Gemini writes the most faithful dialect text but only guesses timestamps (often whole seconds, and
// each line "lasts" until the next begins). Whisper measures word times from the audio but its text
// is less faithful and it sometimes hallucinates. So: keep Gemini's words, and give each one the
// start/end of the Whisper word it lines up with.
import type { Segment } from "../lib";

export type Word = { w: string; start: number; end: number };
export type TimedSegment = Segment & { words?: Word[]; timing: "aligned" | "estimated" };

// ── Arabic-aware normalisation for matching (display text is never changed) ──

const DIACRITICS = /[ً-ٰٟۖ-ۭـ]/g; // tashkeel, superscript alef, Quranic marks, tatweel
export function norm(word: string): string {
  return word
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toLowerCase();
}

export const tokenize = (text: string) => text.split(/\s+/).filter((w) => norm(w).length > 0);

export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  // Levenshtein ratio; words are short so the O(n*m) table is tiny.
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Monotonic fuzzy alignment (LCS weighted by similarity). Returns, for each `a` word, the index of
 * the matched `b` word or -1.
 */
function alignWords(a: string[], b: string[], threshold = 0.6): number[] {
  const n = a.length, m = b.length;
  const score = new Float32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = similarity(a[i - 1], b[j - 1]);
      const diag = s >= threshold ? score[at(i - 1, j - 1)] + s : -Infinity;
      score[at(i, j)] = Math.max(score[at(i - 1, j)], score[at(i, j - 1)], diag);
    }
  }
  const match = new Array<number>(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0; ) {
    const s = similarity(a[i - 1], b[j - 1]);
    if (s >= threshold && Math.abs(score[at(i, j)] - (score[at(i - 1, j - 1)] + s)) < 1e-4) {
      match[i - 1] = j - 1;
      i--, j--;
    } else if (score[at(i - 1, j)] >= score[at(i, j - 1)]) i--;
    else j--;
  }
  return match;
}

/**
 * Theil–Sen line fit (median of pairwise slopes, then median intercept): real ≈ a·est + b.
 * Robust to the wrong matches a fuzzy aligner inevitably makes. Null if there's too little to go on.
 */
function robustLine(pairs: { est: number; real: number }[]): { a: number; b: number } | null {
  if (pairs.length < 12) return null;
  const pts = pairs.length > 200 ? pairs.filter((_, i) => i % Math.ceil(pairs.length / 200) === 0) : pairs;
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].est - pts[i].est;
      if (Math.abs(dx) > 3) slopes.push((pts[j].real - pts[i].real) / dx);
    }
  if (slopes.length < 10) return null;
  const med = (xs: number[]) => (xs.sort((x, y) => x - y), xs[xs.length >> 1]);
  const a = med(slopes);
  if (!(a > 0.4 && a < 2.5)) return null;
  const b = med(pts.map((p) => p.real - a * p.est));
  return { a, b };
}

/**
 * Put Gemini's segments for one chunk onto Whisper's word timeline. Times are chunk-relative.
 * Returns null when too few words line up to trust the result (the caller keeps estimated times).
 */
export function alignChunk(
  segs: { start: number; text: string }[],
  asr: Word[],
  chunkDuration: number,
): { segments: TimedSegment[]; matchRate: number } | null {
  const gWords: { w: string; seg: number }[] = [];
  segs.forEach((s, k) => tokenize(s.text).forEach((w) => gWords.push({ w, seg: k })));
  if (!gWords.length || !asr.length) return null;

  const match = alignWords(gWords.map((g) => norm(g.w)), asr.map((x) => norm(x.w)));
  // Use Gemini's times as a prior, so a similar-sounding word 30s away can't stretch a short line
  // across half a minute. But Gemini's clock can be squashed or shifted (one video had every chunk's
  // lines in 0-85s of a 120s chunk), so first fit how its times map onto the real ones from the
  // matches themselves, then only keep matches near the *corrected* estimate.
  const pairs = gWords.flatMap((g, i) => (match[i] >= 0 ? [{ est: segs[g.seg].start, real: asr[match[i]].start }] : []));
  const fit = robustLine(pairs);
  const SLACK = fit ? Math.max(5, chunkDuration * 0.06) : 4;
  const project = (t: number) => (fit ? fit.a * t + fit.b : t);
  gWords.forEach((g, i) => {
    if (match[i] < 0) return;
    const lo = project(segs[g.seg].start) - SLACK;
    const hi = project(segs[g.seg + 1]?.start ?? chunkDuration) + SLACK;
    const t = asr[match[i]].start;
    if (t < lo || t > hi) match[i] = -1;
  });
  const matched = match.filter((j) => j >= 0).length;
  const matchRate = matched / gWords.length;
  if (matchRate < 0.35) return null;

  // Matched words take Whisper's times; runs of unmatched words are spread across the gap between
  // their matched neighbours in proportion to their length.
  const times: { start: number; end: number }[] = new Array(gWords.length);
  for (let i = 0; i < gWords.length; i++) if (match[i] >= 0) times[i] = { start: asr[match[i]].start, end: asr[match[i]].end };
  for (let i = 0; i < gWords.length; ) {
    if (times[i]) { i++; continue; }
    let k = i;
    while (k < gWords.length && !times[k]) k++;
    const from = i > 0 ? times[i - 1].end : Math.max(0, (times[k]?.start ?? chunkDuration) - 0.4 * (k - i));
    const to = k < gWords.length ? times[k].start : Math.min(chunkDuration, from + 0.4 * (k - i));
    const lens = gWords.slice(i, k).map((g) => g.w.length);
    const total = lens.reduce((x, y) => x + y, 0) || 1;
    let t = from;
    for (let x = i; x < k; x++) {
      const d = (Math.max(0, to - from) * lens[x - i]) / total;
      times[x] = { start: t, end: t + d };
      t += d;
    }
    i = k;
  }

  const out: TimedSegment[] = [];
  segs.forEach((s, k) => {
    const words = gWords
      .map((g, i) => ({ g, i }))
      .filter(({ g }) => g.seg === k)
      .map(({ g, i }) => ({ w: g.w, start: times[i].start, end: Math.max(times[i].end, times[i].start + 0.05) }));
    if (!words.length) return;
    const start = words[0].start;
    const end = words[words.length - 1].end;
    // Still implausibly slow for its word count (e.g. a music break with a few sung words)? Keep the
    // estimate instead of pretending we measured it.
    if (end - start > Math.max(12, words.length * 1.5)) {
      const st = Math.max(0, project(s.start));
      const next = Math.min(chunkDuration, project(segs[k + 1]?.start ?? chunkDuration));
      out.push({ start: st, end: Math.max(st + 1, Math.min(next, st + 12)), text: s.text, timing: "estimated" });
      return;
    }
    out.push({ start, end, text: s.text, words, timing: "aligned" });
  });
  return { segments: out, matchRate };
}

/**
 * Split long aligned segments into sentence-sized lines: at sentence punctuation first, then at the
 * longest pause, so each line starts and ends with the words actually spoken in it.
 */
export function splitLong(seg: TimedSegment, maxSeconds = 9, minWords = 4): TimedSegment[] {
  const words = seg.words;
  if (!words || seg.end - seg.start <= maxSeconds || words.length < minWords * 2) return [seg];
  let cut = -1;
  // Prefer punctuation near the middle; fall back to the biggest silence between words.
  const mid = (words.length - 1) / 2;
  let best = Infinity;
  for (let i = minWords - 1; i < words.length - minWords; i++) {
    if (/[.!?؟،,;:…]$/.test(words[i].w) && Math.abs(i - mid) < best) (best = Math.abs(i - mid)), (cut = i);
  }
  if (cut < 0) {
    let gap = -1;
    for (let i = minWords - 1; i < words.length - minWords; i++) {
      const g = words[i + 1].start - words[i].end;
      if (g > gap) (gap = g), (cut = i);
    }
  }
  if (cut < 0) return [seg];
  const make = (ws: Word[]): TimedSegment => ({ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.w).join(" "), words: ws, timing: "aligned" });
  return [...splitLong(make(words.slice(0, cut + 1)), maxSeconds, minWords), ...splitLong(make(words.slice(cut + 1)), maxSeconds, minWords)];
}
