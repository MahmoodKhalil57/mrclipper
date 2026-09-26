import { useCallback, useEffect, useRef, useState } from "react";
import { pushStoredKey } from "./Key";

export type AgentKey = "transcribe" | "plan" | "extract";
export type JobAgent = AgentKey | "import" | "design" | "brief" | "watch" | "rubric" | "coach";

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

export type Comment = { id: string; text: string; at: number };
export type Note = Comment & { t: number };
export type Review = {
  approved: boolean;
  approvedAt?: number;
  comments: Comment[];
  clips: Record<string, { status?: "keep" | "drop"; comments: Comment[]; nudges?: number; rating?: 1 | -1 }>;
};
export type EditSegment = { start: number; end: number; role?: string; zoom?: string; speed?: number; reframe_x?: number; look?: string };
export type ClipEdit = { segments: EditSegment[]; transitions: string[]; title?: string; emphasis?: string[]; enabled?: boolean };
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
export type Clip = { id: number; title: string; start: number; end: number; on_screen_text?: string; reason?: string; file: string | null; edit?: ClipEdit; watch?: ClipWatch | null };
export type Engine = "classic" | "hybrid" | "jev" | "webmcp";
export type JevScores = {
  overall: number; hook: number; cold: number; payoff: number; complete: number; fit: number;
  standalone: number; respectful: number; tone: { key: string; p: number }; direction?: number; against?: number; repeat?: boolean;
  visual?: number; vertical?: number;
  /** Every question the brief asked, in order (Hybrid briefs have their own questions). */
  rows?: { key: string; label: string; value: number }[];
};
export type BriefQuestion = { key: string; label: string; type: "noul" | "score"; instructions: string; criteria?: string[]; weight: number };
export type JevBrief = {
  source: "default" | "llm"; model?: string; summary: string;
  opener: BriefQuestion[]; ending: BriefQuestion[]; window: BriefQuestion[];
  tones: Record<string, string>; preferredTones: string[]; gates: { key: string; min: number }[];
  zoomGuide: Record<string, string>; transitionGuide: Record<string, string>;
};
export type DesignRun = {
  at: number; mode: "hybrid" | "jev"; guide: "llm" | "standard"; cost: number;
  clips: Record<string, {
    zooms: { piece: number; zoom: string; p: number; options: Record<string, number>; flashback?: number; varied?: boolean; ending?: boolean }[];
    transitions: { gap: number; transition: string; p: number; options: Record<string, number> }[];
    titles?: "llm";
  }>;
};
export type JevRun = {
  model: string; direction: string | null;
  stats: { calls: number; cost: number; openers: number; endings: number; candidates: number; eligible: number };
  clips: Record<string, JevScores>;
  brief?: JevBrief;
  alternatives: { start: number; end: number; overall: number; tone: string; opening: string }[];
};
export type EdgeCheck = {
  start: number; end: number; start_clean: number; end_clean: number; standalone: number;
  suggest_start?: { t: number; p: number; line: string }; suggest_end?: { t: number; p: number; line: string };
};
export type Run = {
  id: string; videoStem: string; created: string; script: string; aspect?: string; clips: Clip[]; review: Review;
  engine: Engine; jev: JevRun | null; qa: { checkedAt: number; model: string; clips: Record<string, EdgeCheck> } | null;
  design: DesignRun | null;
};
export type Video = {
  name: string; stem: string; path: string; size: number; duration: number;
  transcript: { segments: number; path: string; aligned?: number } | null;
  vision: { shots: number; labelled: number; model: string } | null;
  runs: string[];
  /** The Brief node's cached output (Hybrid). fresh = compiled from the current outline. */
  brief: { at: number; fresh: boolean; source: "default" | "llm"; model?: string; questions: number; cost: number } | null;
};
export type Settings = { requireApproval: boolean; engine: Engine };
export type Proposal = {
  id: string; at: number; status: "proposed" | "applied" | "discarded"; parent: string; hash: string; outline: string;
  changes: { section: string; change: string; evidence: string }[];
  hypothesis: string; keep: string; warnings: string[]; takes: string[]; direction?: string; model: string; cost: number;
  mode?: "llm" | "jev" | "hybrid"; scorecard?: string;
};
export type OutlineVersion = {
  hash: string; at: number; source: "user" | "coach"; parent?: string; proposal?: string;
  label: string; takes: number; rated: number; mean: number | null;
};
export type Rubric = {
  source: "llm" | "default"; model?: string; at: number; outline_hash: string; cost: number; diagnosis: string; fresh: boolean;
  rules: { key: string; section: string; rule: string; question: string }[];
  sections: { section: string; why: string; variants: { key: string; summary: string; text: string }[] }[];
};
export type Scorecard = {
  id: string; at: number; mode: "jev" | "hybrid"; outline_hash: string; rubric_source: "llm" | "default"; cost: number; calls: number; diagnosis: string;
  rules: { key: string; section: string; rule: string; followed: number; good: number | null; bad: number | null; n: number }[];
  clips: { run: string; clip: number; title: string; reward: number | null; watched: boolean; answers: Record<string, number> }[];
  decisions: { section: string; chosen: string; summary: string; p: number; options: Record<string, number>; applied: boolean }[];
  proposal?: string;
};
export type CoachState = {
  current: string; versions: OutlineVersion[];
  outcomes: Record<string, { score: number | null; hash: string | null }>;
  pending: Proposal | null; proposals: Omit<Proposal, "outline">[];
  rubric: Rubric | null; scorecard: Scorecard | null;
};
export type Library = {
  root: string; videos: Video[]; runs: Run[]; outline: string;
  history: { path: string; text: string }[]; settings: Settings; coach: CoachState;
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

/** JSON request that throws the server's error message (and flags review-gate refusals). */
export async function call<T = any>(url: string, method = "POST", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { approval: !!data.approval });
  return data;
}

export async function putText(url: string, body: string) {
  const r = await fetch(url, { method: "PUT", body, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (!r.ok) throw new Error((await r.text()) || `Save failed (${r.status})`);
}

export const actions = {
  start: (agent: AgentKey, args: Record<string, unknown>) => call<{ job_id: string }>("/api/jobs", "POST", { agent, args }),
  cancel: (id: string) => call(`/api/jobs/${id}/cancel`),
  importUrl: (url: string) => call<{ job_id: string }>("/api/import", "POST", { url }),
  approve: (run: string, approved = true) => call(`/api/runs/${encodeURIComponent(run)}/approve`, "POST", { approved }),
  clip: (run: string, id: number, patch: { status?: "keep" | "drop" | null; start?: number; end?: number; title?: string; edit_enabled?: boolean; rating?: 1 | -1 | null }) =>
    call(`/api/runs/${encodeURIComponent(run)}/clip/${id}`, "POST", patch),
  comment: (run: string, text: string, clip?: number) => call(`/api/runs/${encodeURIComponent(run)}/comment`, "POST", { text, clip }),
  uncomment: (run: string, id: string) => call(`/api/runs/${encodeURIComponent(run)}/comment?id=${id}`, "DELETE"),
  note: (video: string, t: number, text: string) => call<Note>("/api/notes", "POST", { video, t, text }),
  unnote: (video: string, id: string) => call(`/api/notes?video=${encodeURIComponent(video)}&id=${id}`, "DELETE"),
  keyInfo: () => getJSON<KeyInfo>("/api/key"),
  setKey: (key: string) => call<KeyInfo>("/api/key", "PUT", { key }),
  clearKey: () => call<KeyInfo>("/api/key", "DELETE"),
  settings: (patch: Partial<Settings>) => call<Settings>("/api/settings", "PUT", patch),
  briefOf: (video: string) => getJSON<{ at: number; cost: number; brief: JevBrief } | null>(`/api/brief?video=${encodeURIComponent(video)}`),
  brief: (video: string) => call<{ job_id: string }>("/api/brief", "POST", { video }),
  coach: (video: string, direction?: string) => call<{ job_id: string }>("/api/coach", "POST", { video, direction }),
  watch: (run: string, force = false) => call<{ job_id: string }>(`/api/runs/${encodeURIComponent(run)}/watch`, "POST", { force }),
  rubric: (video: string, direction?: string) => call<{ job_id: string }>("/api/rubric", "POST", { video, direction }),
  applyProposal: (id: string) => call(`/api/coach/${id}/apply`),
  discardProposal: (id: string) => call(`/api/coach/${id}/discard`),
  restoreVersion: (hash: string) => call("/api/outline/version", "POST", { hash }),
  design: (run: string) => call<{ job_id: string }>(`/api/runs/${encodeURIComponent(run)}/design`, "POST", {}),
  check: (run: string, only?: number[]) => call<{ job_id: string }>(`/api/runs/${encodeURIComponent(run)}/check`, "POST", { only }),
  vision: (video: string) => getJSON<{ shots: Shot[]; model?: string }>(`/api/vision?video=${encodeURIComponent(video)}`),
  transcript: (video: string) => getJSON<{ segments: Segment[]; notes: Note[] }>(`/api/transcript?video=${encodeURIComponent(video)}`),
};

/** Upload with progress. XHR because fetch can't report upload progress. */
export function uploadVideo(file: File, onProgress: (p: number) => void): Promise<{ video: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || "{}");
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

/** Live studio state: server status, library on disk, jobs and system log over SSE. */
export function useStudio() {
  const [status, setStatus] = useState<Status | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sys, setSys] = useState<SysEntry[]>([]);
  const [online, setOnline] = useState(true);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshStatus = useCallback(() => getJSON<Status>("/api/status").then(setStatus).catch(() => {}), []);
  const refresh = useCallback(async () => {
    try {
      setLibrary(await getJSON<Library>("/api/library"));
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
        // Artifacts land on disk as jobs progress (chunks, clips), so rescan on every change.
        refreshSoon();
      } else if (ev.type === "sys") {
        setSys((prev) => [...prev.slice(-299), ev.entry]);
        if (/Director worker ready/.test(ev.entry.msg)) setStatus((s) => (s ? { ...s, worker: "ready" } : s));
      }
    };
    return () => es.close();
  }, [refresh, refreshSoon]);

  return { status, library, jobs, sys, online, refresh, refreshStatus };
}
