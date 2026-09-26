// Human-in-the-loop state: approvals, keep/drop decisions and comments on the agents' artifacts.
// Stored next to the artifacts so the agents (and the Python scripts) can read them:
//   clips/<run>/review.json          run approval, per-clip status and comments
//   transcripts/<stem>/notes.json    comments pinned to transcript timestamps
//   .data/settings.json              app-wide switches such as the review gate
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { DATA_DIR } from "./config";
import { listRuns, runDir, transcriptDir } from "./library";
import { fmt } from "./lib";

export type Comment = { id: string; text: string; at: number; by?: "you" | "agent" };
/** status: your call before cutting. rating: your verdict after watching the finished clip (1 up, -1 down). */
export type ClipReview = { status?: "keep" | "drop"; comments: Comment[]; nudges?: number; rating?: 1 | -1 };
export type Review = { approved: boolean; approvedAt?: number; comments: Comment[]; clips: Record<string, ClipReview> };
export type Note = Comment & { t: number };
/** engine: who does the crew's thinking. "classic" = LLM prompts, "hybrid" = LLM brief + Jev decisions, "jev" = System One typed decisions. */
export type Settings = { requireApproval: boolean; engine: "classic" | "hybrid" | "jev" | "webmcp" };

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const readJson = <T,>(file: string, fallback: T): T => {
  try {
    return existsSync(file) ? { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) } : fallback;
  } catch {
    return fallback;
  }
};

// ── Settings ─────────────────────────────────────────────────────────

const SETTINGS = join(DATA_DIR, "settings.json");

export function readSettings(): Settings {
  return readJson<Settings>(SETTINGS, { requireApproval: true, engine: "classic" });
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  writeFileSync(SETTINGS, JSON.stringify(next, null, 2));
  return next;
}

// ── Run reviews ──────────────────────────────────────────────────────

const reviewFile = (run: string) => join(runDir(run), "review.json");

export function readReview(run: string): Review {
  return readJson<Review>(reviewFile(run), { approved: false, comments: [], clips: {} });
}

function saveReview(run: string, r: Review) {
  writeFileSync(reviewFile(run), JSON.stringify(r, null, 2), "utf8");
  return r;
}

export function setApproved(run: string, approved: boolean) {
  const r = readReview(run);
  r.approved = approved;
  r.approvedAt = approved ? Date.now() : undefined;
  return saveReview(run, r);
}

export function setClipStatus(run: string, clipId: number, status: "keep" | "drop" | undefined) {
  const r = readReview(run);
  const c = (r.clips[clipId] ??= { comments: [] });
  c.status = status;
  return saveReview(run, r);
}

export function setClipRating(run: string, clipId: number, rating: 1 | -1 | undefined) {
  const r = readReview(run);
  const c = (r.clips[clipId] ??= { comments: [] });
  if (rating) c.rating = rating;
  else delete c.rating;
  return saveReview(run, r);
}

/** You corrected a clip's in/out point. Counts against the outline's one-shot score. */
export function addNudge(run: string, clipId: number) {
  const r = readReview(run);
  const c = (r.clips[clipId] ??= { comments: [] });
  c.nudges = (c.nudges ?? 0) + 1;
  return saveReview(run, r);
}

export function addComment(run: string, text: string, clipId?: number, by: "you" | "agent" = "you") {
  const r = readReview(run);
  const comment: Comment = { id: newId(), text: text.trim(), at: Date.now(), by };
  if (clipId == null) r.comments.push(comment);
  else (r.clips[clipId] ??= { comments: [] }).comments.push(comment);
  saveReview(run, r);
  return comment;
}

export function deleteComment(run: string, commentId: string) {
  const r = readReview(run);
  r.comments = r.comments.filter((c) => c.id !== commentId);
  for (const c of Object.values(r.clips)) c.comments = c.comments.filter((x) => x.id !== commentId);
  return saveReview(run, r);
}

export const droppedClips = (run: string) =>
  Object.entries(readReview(run).clips).filter(([, c]) => c.status === "drop").map(([id]) => Number(id));

// ── Transcript notes ─────────────────────────────────────────────────

const notesFile = (video: string) => join(transcriptDir(video), "notes.json");

export function readNotes(video: string): Note[] {
  const f = notesFile(video);
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
  } catch {
    return [];
  }
}

export function addNote(video: string, t: number, text: string): Note {
  const notes = readNotes(video);
  const note = { id: newId(), t, text: text.trim(), at: Date.now() };
  notes.push(note);
  notes.sort((a, b) => a.t - b.t);
  mkdirSync(transcriptDir(video), { recursive: true });
  writeFileSync(notesFile(video), JSON.stringify(notes, null, 2), "utf8");
  return note;
}

export function deleteNote(video: string, id: string) {
  writeFileSync(notesFile(video), JSON.stringify(readNotes(video).filter((n) => n.id !== id), null, 2), "utf8");
}

// ── Feedback digest for the agents ──────────────────────────────────

/** Everything the user said about this video's transcript and earlier runs, as plain text for a prompt. */
export function feedbackDigest(video: string): string {
  const stem = parse(video).name;
  const out: string[] = [];
  for (const n of readNotes(video)) out.push(`- Transcript note at ${fmt(n.t)}: ${n.text}`);
  for (const run of listRuns().filter((r) => r.videoStem === stem)) {
    const r = readReview(run.id);
    const lines: string[] = [];
    for (const c of r.comments) lines.push(`  - On the whole run: ${c.text}`);
    for (const clip of run.clips) {
      const cr = r.clips[clip.id];
      if (!cr) continue;
      const label = `Clip ${clip.id} "${clip.title}" (${fmt(clip.start)}-${fmt(clip.end)})`;
      if (cr.status) lines.push(`  - ${label}: user marked it ${cr.status.toUpperCase()}`);
      for (const c of cr.comments) lines.push(`  - ${label}: ${c.text}`);
    }
    if (lines.length) out.push(`- Run ${run.created}${r.approved ? " (approved)" : ""}:`, ...lines);
  }
  return out.join("\n");
}
