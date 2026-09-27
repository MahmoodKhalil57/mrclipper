import { useCallback, useEffect, useRef, useState } from "react";
import { pushStoredKey } from "./Key";

/** The three MCP crew servers (Director tool calls are labelled by them). */
export type AgentKey = "transcribe" | "plan" | "extract";
/** Job kinds, named after the canvas nodes they belong to; "workflow" is ▶ Run. */
export type JobAgent = "source" | "refclip" | "transcript" | "shots" | "refstyle" | "brief" | "pick" | "titles" | "music" | "design" | "render" | "check" | "coach" | "workflow";

export type Job = {
  id: string;
  agent: JobAgent;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  progress: number;
  stage: string;
  input: Record<string, any>;
  result?: any;
  error?: string;
  cost: number;
  log: { t: number; level: "info" | "warn" | "error"; msg: string }[];
  startedAt: number;
  finishedAt?: number;
};

// ── The workflow (computed by the server, workflow.ts) ───────────────

export type NodeId = "source" | "outline" | "refclip" | "guide" | "transcript" | "shots" | "refstyle" | "brief" | "pick" | "titles" | "music" | "design" | "render" | "check" | "review" | "coach";
export type NodeState = "empty" | "optional" | "locked" | "ready" | "stale" | "running" | "waiting" | "done" | "failed" | "stopped";
export type Who = "you" | "transcriber" | "llm" | "jev" | "code";
/** canRun: an optional step you can still run by hand (Music, when the outline doesn't ask for it). */
export type WfNode = { id: NodeId; phase: number; who: Who; state: NodeState; reason?: string; facts: [string, string][]; job?: string; cost?: number; canRun?: boolean };
/** Pick's settings: its inputs for a take, besides the brief, your notes and the transcript. */
export type PickSettings = { direction: string; count: number | null };
export type TakeRef = {
  id: string; created: string; current: boolean; reviewed: boolean; score: number | null; clips: number;
  /** The Pick settings it was made with, and whether its other inputs (brief, notes, transcript) are current. */
  settings: PickSettings; otherInputsCurrent: boolean;
};
export type Workflow = {
  video: string; stem: string;
  take: TakeRef | null; takes: TakeRef[];
  /** Pick's saved settings for the next take. */
  pick: PickSettings;
  nodes: Record<NodeId, WfNode>;
  plan: NodeId[];
  next: { node: NodeId; text: string };
  run: string | null;
};

// ── Artifacts ────────────────────────────────────────────────────────

export type Comment = { id: string; text: string; at: number; by?: "you" | "agent" };
export type Note = Comment & { t: number };
export type Review = {
  approved: boolean;
  approvedAt?: number;
  comments: Comment[];
  clips: Record<string, { status?: "keep" | "drop"; comments: Comment[]; nudges?: number; rating?: 1 | -1 }>;
};
/** An effect as an edit uses it; times are anchors (seconds, "start", "p2", "cut1", "p2@123.4"…). */
export type FxUse = { fx: string; at?: number | string; from?: number | string; to?: number | string; duration?: number; params?: Record<string, unknown> };
export type EditSegment = { start: number; end: number; role?: string; zoom?: string; speed?: number; reframe_x?: number; look?: string; fx?: FxUse[]; freeze?: number; reverse?: boolean };
export type Gap = string | { fx: string; duration?: number; params?: Record<string, unknown> };
export type ClipEdit = { segments: EditSegment[]; transitions: Gap[]; title?: string; emphasis?: string[]; enabled?: boolean; fx?: FxUse[]; concept?: { name: string; idea: string } };
export type FxKind = "segment" | "video" | "graphic" | "text" | "asset" | "transition" | "sound" | "voice" | "music";
/** Where a clip's parts, joins and effects play in the finished clip (seconds). */
export type ClipTimeline = {
  duration: number; parts: { t0: number; t1: number }[]; joins: { t: number; overlap: number; name: string }[];
  fx: { fx: string; kind: FxKind; t0: number; t1: number; label?: string }[];
};
export type WatchFrame = {
  t: number; frame: string; faces: number; face_cut: boolean;
  desc?: string; framing?: "good" | "cut_off" | "empty" | "split" | "fit"; captions?: string; caption_ok?: boolean; effect?: string;
};
export type ClipWatch = {
  at: number; file: string; duration: number; model?: string; fresh: boolean;
  audio: { text: string; match: number | null } | null;
  frames: WatchFrame[];
  metrics: { script_match: number | null; faces_ok: number | null; cut_off: number; captions_ok: number | null; framing_ok: number | null };
};
export type Clip = { id: number; title: string; start: number; end: number; on_screen_text?: string; reason?: string; file: string | null; edit?: ClipEdit; timeline?: ClipTimeline | null; watch?: ClipWatch | null };

export type BriefQuestion = { key: string; label: string; type: "noul" | "score"; instructions: string; criteria?: string[]; weight: number };
export type CheckRule = { key: string; section: string; rule: string; question: string };
export type Brief = {
  source: "default" | "llm"; model?: string; summary: string;
  pick: { opener: BriefQuestion[]; ending: BriefQuestion[]; window: BriefQuestion[]; tones: Record<string, string>; preferredTones: string[]; gates: { key: string; min: number }[] };
  design: { zoomGuide: Record<string, string>; transitionGuide: Record<string, string>; titleGuide: string };
  check: CheckRule[];
};
export type BriefFile = { at: number; inputs: string; outline_hash: string; reference: string; cost: number; brief: Brief };
export type PickScores = {
  overall: number; tone: { key: string; p: number }; rows?: { key: string; label: string; value: number }[];
  direction?: number; against?: number; repeat?: boolean; visual?: number; vertical?: number;
};
export type PickRun = {
  model: string; direction: string | null;
  stats: { calls: number; cost: number; openers: number; endings: number; candidates: number; eligible: number };
  clips: Record<string, PickScores>;
  brief?: Brief | Record<string, unknown>;
  alternatives: { start: number; end: number; overall: number; tone: string; opening: string }[];
};
export type DesignConcept = { key: string; name: string; idea: string; p: number; chosen: boolean; ok: boolean; plan: string[]; notes: string[] };
export type DesignRun = {
  at: number; cost: number; guide?: "llm" | "standard";
  inputs?: { version: number; effects: string; assets: string };
  /** Music Lyria made for the outline's mood: made in this design, or reused from an earlier one. */
  music?: { name: string; file: string; model: string; seconds: number; cost: number; made: boolean; options: { key: string; name: string; prompt: string }[]; odds: Record<string, number>; chosen: string };
  clips: Record<string, {
    zooms: { piece: number; zoom: string; p: number; options: Record<string, number>; flashback?: number; varied?: boolean; ending?: boolean; ending_p?: number }[];
    transitions: { gap: number; transition: string; p: number; options: Record<string, number> }[];
    hook?: { chosen: string; p: number; options: Record<string, number>; texts: Record<string, string> };
    emphasis?: { w: string; p: number; kept: boolean }[];
    /** concepts: the LLM planned two edits and Jev picked one; moves: Jev picked a move per part. */
    mode?: "concepts" | "moves";
    concepts?: DesignConcept[];
  }>;
};
export type ParamSpec =
  | { type: "number"; min: number; max: number; default: number; doc?: string }
  | { type: "color"; default: string; doc?: string }
  | { type: "enum"; values: string[]; default: string; doc?: string }
  | { type: "text"; default?: string; max?: number; doc?: string }
  | { type: "asset"; kinds: string[]; doc?: string };
export type EffectInfo = { name: string; kind: FxKind; timing: "whole" | "range" | "instant"; description: string; tags: string[]; params?: Record<string, ParamSpec>; duration?: number; origin?: "builtin" | "workspace" };
export type AssetInfo = { kind: "sfx" | "music" | "overlay" | "image" | "lut" | "font"; name: string; url: string; size: number; duration?: number; builtin?: boolean; description?: string };
export type EffectsLibrary = { effects: EffectInfo[]; notes: string[]; assets: AssetInfo[]; folders: Record<AssetInfo["kind"], string>; assetsDir: string; effectsDir: string };
export type EdgeCheck = {
  start: number; end: number; start_clean: number; end_clean: number; standalone: number;
  suggest_start?: { t: number; p: number; line: string }; suggest_end?: { t: number; p: number; line: string };
};
export type CheckRun = {
  at: number; model: string; cost: number; rules: CheckRule[];
  clips: Record<string, { mtime: number; at: number; watched: boolean; rules: Record<string, number>; followed: number; edges: EdgeCheck | null }>;
};
/** Hook cards: the options per clip with Jev's odds, and the emphasis words it kept. */
export type TitlesRun = {
  at: number; cost: number;
  clips: Record<string, { hook?: { chosen: string; p: number; options: Record<string, number>; texts: Record<string, string> }; emphasis?: { w: string; p: number; kept: boolean }[] }>;
};
/** Music: the score Lyria made for each clip, from the prompt Jev picked. */
export type MusicRun = {
  at: number; cost: number;
  clips: Record<string, { file: string; name: string; model: string; seconds: number; lufs?: number; cost: number; options: { key: string; name: string; prompt: string }[]; odds: Record<string, number>; chosen: string }>;
};
export type Run = {
  id: string; videoStem: string; created: string; script: string; aspect?: string; clips: Clip[]; review: Review;
  jev: PickRun | null; design: DesignRun | null; check: CheckRun | null; titles?: TitlesRun | null; music?: MusicRun | null;
  info: { video: string; created: number; notes?: string; inputs: { outline: string; reference: string; brief: string } } | null;
};
export type Video = {
  name: string; stem: string; path: string; size: number; duration: number;
  transcript: { segments: number; path: string; aligned?: number } | null;
  vision: { shots: number; labelled: number; model: string } | null;
  runs: string[];
};
export type Proposal = {
  id: string; at: number; status: "proposed" | "applied" | "discarded"; parent: string; hash: string; outline: string;
  changes: { section: string; change: string; evidence: string }[];
  hypothesis: string; keep: string; warnings: string[]; takes: string[]; direction?: string; model: string; cost: number; scorecard?: string;
};
export type OutlineVersion = {
  hash: string; at: number; source: "user" | "coach"; parent?: string; proposal?: string;
  label: string; takes: number; rated: number; mean: number | null;
};
export type Scorecard = {
  id: string; at: number; outline_hash: string; cost: number; calls: number; diagnosis: string;
  rules: { key: string; section: string; rule: string; followed: number; good: number | null; bad: number | null; n: number }[];
  decisions: { section: string; chosen: string; summary: string; p: number; options: Record<string, number>; applied: boolean }[];
  proposal?: string;
  /** The direction it was given, if any. */
  direction?: string;
};
export type OutlineState = {
  current: string; versions: OutlineVersion[];
  outcomes: Record<string, { score: number | null; hash: string | null }>;
  pending: Proposal | null; proposals: Omit<Proposal, "outline">[];
  scorecard: Scorecard | null; lastCoach: number;
};
export type RefTrait = { key: string; section: string; trait: string; question: string };
export type Reference = {
  id: string; name: string; file: string; source?: string; at: number; guide: string;
  analysis?: {
    at: number; guide: string; model: string; cost: number; duration: number; analysed: number; width: number; height: number;
    shots: number; avg_shot: number; cuts_per_min: number; words_per_min: number; pauses: number; transcript: string;
    frames: { t: number; frame: string; faces: number }[];
    profile: Record<"summary" | "pacing" | "structure" | "captions" | "framing" | "color" | "effects" | "transitions" | "title" | "audio", string> & { traits: RefTrait[] };
  };
};
export type Library = {
  root: string; videos: Video[]; runs: Run[]; outline: string;
  history: { path: string; text: string }[];
  outlines: OutlineState;
  reference: Reference | null; pendingGuide: string;
};
export type KeyInfo = { set: boolean; source: "browser" | "env" | null; label?: string; usage?: number; limit?: number | null; verified?: boolean };
export type Status = {
  worker: "starting" | "ready" | "down";
  key: KeyInfo;
  models: { director: string; transcribe: string; plan: string[] };
  root: string;
  agents: { key: AgentKey; title: string; blurb: string; url: string }[];
};
export type Shot = {
  id: number; start: number; end: number; cont?: boolean; frame: string;
  kind?: string; desc?: string; text?: string; subject_x?: number; people?: number;
};
export type SysEntry = { t: number; level: "info" | "warn" | "error"; msg: string };
export type Segment = {
  start: number; end: number; text: string;
  words?: { w: string; start: number; end: number }[];
  timing?: "aligned" | "estimated";
};

export const fileUrl = (rel: string) => "/files/" + rel.split("/").map(encodeURIComponent).join("/");
export const thumbUrl = (video: string, t = 60) => `/api/thumb?video=${encodeURIComponent(video)}&t=${Math.round(t)}`;

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** JSON request that throws the server's error message. */
export async function call<T = any>(url: string, method = "POST", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

export async function putText(url: string, body: string) {
  const r = await fetch(url, { method: "PUT", body, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!r.ok) throw new Error((await r.text()) || `Save failed (${r.status})`);
}

const T = (take: string) => `/api/takes/${encodeURIComponent(take)}`;
export type StepArgs = { video?: string; take?: string; count?: number | null; only?: number[]; direction?: string };
/** A started job, or why nothing ran: the step (or every step) is up to date with its inputs. */
export type Started = { job_id: string; skipped?: undefined } | { skipped: string; job_id?: undefined };

export const actions = {
  // The workflow
  workflow: (video: string, take?: string | null) => getJSON<Workflow>(`/api/workflow?video=${encodeURIComponent(video)}${take ? `&take=${encodeURIComponent(take)}` : ""}`),
  run: (video: string, take?: string | null) => call<Started>("/api/run", "POST", { video, take: take ?? undefined }),
  step: (step: NodeId, args: StepArgs) => call<Started>("/api/step", "POST", { step, ...args }),
  pickSettings: (video: string, s: Partial<PickSettings>) => call<PickSettings>("/api/pick", "PUT", { video, ...s }),
  cancel: (id: string) => call(`/api/jobs/${id}/cancel`),
  // Inputs
  importUrl: (url: string) => call<{ job_id: string }>("/api/import", "POST", { url }),
  refImport: (url: string) => call<{ job_id: string }>("/api/reference/import", "POST", { url }),
  refGuide: (guide: string) => call("/api/reference/guide", "PUT", { guide }),
  refClear: () => call("/api/reference", "DELETE"),
  // Understand
  vision: (video: string) => getJSON<{ shots: Shot[]; model?: string }>(`/api/vision?video=${encodeURIComponent(video)}`),
  transcript: (video: string) => getJSON<{ segments: Segment[]; notes: Note[] }>(`/api/transcript?video=${encodeURIComponent(video)}`),
  note: (video: string, t: number, text: string) => call<Note>("/api/notes", "POST", { video, t, text }),
  unnote: (video: string, id: string) => call(`/api/notes?video=${encodeURIComponent(video)}&id=${id}`, "DELETE"),
  // Brief
  briefOf: (video: string) => getJSON<BriefFile | null>(`/api/brief?video=${encodeURIComponent(video)}`),
  // Design: the effects library and your files
  effects: () => getJSON<EffectsLibrary>("/api/effects"),
  openAssets: () => call("/api/assets/open"),
  // Review
  clip: (take: string, id: number, patch: { status?: "keep" | "drop" | null; start?: number; end?: number; title?: string; edit_enabled?: boolean }) => call(`${T(take)}/clip/${id}`, "POST", patch),
  finish: (take: string, done = true) => call(`${T(take)}/finish`, "POST", { done }),
  comment: (take: string, text: string, clip?: number) => call(`${T(take)}/comment`, "POST", { text, clip }),
  uncomment: (take: string, id: string) => call(`${T(take)}/comment?id=${id}`, "DELETE"),
  // Learn
  applyProposal: (id: string) => call(`/api/coach/${id}/apply`),
  discardProposal: (id: string) => call(`/api/coach/${id}/discard`),
  restoreVersion: (hash: string) => call("/api/outline/version", "POST", { hash }),
  // Key
  keyInfo: () => getJSON<KeyInfo>("/api/key"),
  setKey: (key: string) => call<KeyInfo>("/api/key", "PUT", { key }),
  clearKey: () => call<KeyInfo>("/api/key", "DELETE"),
};

/** Upload with progress. XHR because fetch can't report upload progress. */
export function uploadVideo(file: File, onProgress: (p: number) => void, endpoint = "/api/upload"): Promise<{ video: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${endpoint}${endpoint.includes("?") ? "&" : "?"}name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || "{}");
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

/** Live studio state: server status, the workspace on disk, jobs and the system log over SSE. */
export function useStudio() {
  const [status, setStatus] = useState<Status | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sys, setSys] = useState<SysEntry[]>([]);
  const [online, setOnline] = useState(true);
  // Bumped on every library refresh, so views that fetch their own data (the workflow) follow along.
  const [version, setVersion] = useState(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshStatus = useCallback(() => getJSON<Status>("/api/status").then(setStatus).catch(() => {}), []);
  const refresh = useCallback(async () => {
    try {
      setLibrary(await getJSON<Library>("/api/library"));
      setVersion((v) => v + 1);
    } catch {}
  }, []);

  // Debounced so a burst of job events triggers one scan of the disk.
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refresh, 400);
  }, [refresh]);

  useEffect(() => {
    getJSON<Status>("/api/status").then(setStatus).catch(() => {});
    getJSON<Job[]>("/api/jobs").then(setJobs).catch(() => {});
    refresh();

    const es = new EventSource("/api/events");
    // The server keeps the key in memory only: hand it this browser's key on every (re)connect.
    es.onopen = () => {
      setOnline(true);
      pushStoredKey().then(refreshStatus);
    };
    es.onerror = () => setOnline(false);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === "hello" || ev.type === "ping") {
        setStatus((s) => (s ? { ...s, worker: ev.worker } : s));
      } else if (ev.type === "job") {
        const job: Job = ev.job;
        setJobs((prev) => {
          const i = prev.findIndex((j) => j.id === job.id);
          if (i === -1) return [job, ...prev];
          const next = prev.slice();
          next[i] = job;
          return next;
        });
        // Artifacts land on disk as jobs progress, so rescan on every change.
        refreshSoon();
      } else if (ev.type === "sys") {
        setSys((prev) => [...prev.slice(-299), ev.entry]);
        if (/Director worker ready/.test(ev.entry.msg)) setStatus((s) => (s ? { ...s, worker: "ready" } : s));
      }
    };
    return () => es.close();
  }, [refresh, refreshSoon]);

  return { status, library, jobs, sys, online, refresh, refreshStatus, version };
}

/** The workflow for one video and take, refetched whenever the workspace changes. */
export function useWorkflow(video: string | null, take: string | null, version: number) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!video) return setWf(null);
    const n = ++seq.current;
    actions.workflow(video, take).then((w) => n === seq.current && (setWf(w), setError(null))).catch((e) => n === seq.current && setError(String(e.message ?? e)));
  }, [video, take]);
  useEffect(load, [load, version]);
  return { wf, error, reload: load };
}
