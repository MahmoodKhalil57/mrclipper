import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";

export type AgentName = "import" | "transcribe" | "brief" | "plan" | "design" | "extract" | "watch" | "rubric" | "coach";
export type JobStatus = "running" | "done" | "failed" | "cancelled";
export type LogEntry = { t: number; level: "info" | "warn" | "error"; msg: string };

export type Job = {
  id: string;
  agent: AgentName;
  title: string;
  status: JobStatus;
  progress: number; // 0..1
  stage: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
  cost: number; // USD reported by OpenRouter
  log: LogEntry[];
  startedAt: number;
  finishedAt?: number;
};

export type JobContext = {
  job: Job;
  log: (msg: string, level?: LogEntry["level"]) => void;
  progress: (value: number, stage?: string) => void;
  addCost: (usd?: number) => void;
  /** Aborted when the user stops the job; pass it to fetches and child processes. */
  signal: AbortSignal;
};

type Listener = (event: { type: "job"; job: Job } | { type: "sys"; entry: LogEntry }) => void;

const FILE = join(DATA_DIR, "jobs.json");
const MAX_LOG = 400;
const jobs = new Map<string, Job>();
const listeners = new Set<Listener>();
const pending = new Map<string, Timer>();
const waiters = new Map<string, Set<() => void>>();
const controllers = new Map<string, AbortController>();

mkdirSync(DATA_DIR, { recursive: true });
if (existsSync(FILE)) {
  try {
    for (const j of JSON.parse(readFileSync(FILE, "utf8")) as Job[]) {
      // A job that was running when the server stopped will never finish.
      if (j.status === "running") Object.assign(j, { status: "failed", error: "Server restarted mid-job" });
      jobs.set(j.id, j);
    }
  } catch {}
}

let saveTimer: Timer | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const recent = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
    writeFileSync(FILE, JSON.stringify(recent));
  }, 500);
}

/** Coalesce rapid updates (ffmpeg progress, log bursts) into one event per job per 150ms. */
function emit(job: Job, immediate = false) {
  save();
  if (pending.has(job.id) && !immediate) return;
  clearTimeout(pending.get(job.id));
  const fire = () => {
    pending.delete(job.id);
    for (const l of listeners) l({ type: "job", job });
  };
  if (immediate) fire();
  else pending.set(job.id, setTimeout(fire, 150));
}

export function onEvent(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function sysLog(msg: string, level: LogEntry["level"] = "info") {
  const entry = { t: Date.now(), level, msg };
  for (const l of listeners) l({ type: "sys", entry });
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getJob(id: string) {
  return jobs.get(id);
}

/** Start a background job and return immediately. */
export function startJob(
  agent: AgentName,
  title: string,
  input: Record<string, unknown>,
  fn: (ctx: JobContext) => Promise<unknown>,
): Job {
  const job: Job = {
    id: `${agent}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    agent, title, input,
    status: "running", progress: 0, stage: "starting", cost: 0, log: [],
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const ctx: JobContext = {
    job,
    signal: controller.signal,
    log(msg, level = "info") {
      job.log.push({ t: Date.now(), level, msg });
      if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
      emit(job);
    },
    progress(value, stage) {
      job.progress = Math.max(0, Math.min(1, value));
      if (stage) job.stage = stage;
      emit(job);
    },
    addCost(usd) {
      if (usd) job.cost += usd;
    },
  };
  emit(job, true);
  fn(ctx)
    .then((result) => Object.assign(job, { status: "done", result, progress: 1, stage: "done" }))
    .catch((e: unknown) => {
      if (controller.signal.aborted) {
        Object.assign(job, { status: "cancelled", error: "Stopped by you", stage: "stopped" });
        job.log.push({ t: Date.now(), level: "warn", msg: "Stopped by you" });
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      Object.assign(job, { status: "failed", error: msg, stage: "failed" });
      job.log.push({ t: Date.now(), level: "error", msg });
    })
    .finally(() => {
      controllers.delete(job.id);
      job.finishedAt = Date.now();
      emit(job, true);
      for (const w of waiters.get(job.id) ?? []) w();
      waiters.delete(job.id);
    });
  return job;
}

/** Stop a running job. Its work function sees `ctx.signal` abort and unwinds. */
export function cancelJob(id: string): boolean {
  const c = controllers.get(id);
  if (!c) return false;
  jobs.get(id)?.log.push({ t: Date.now(), level: "warn", msg: "Stop requested" });
  c.abort();
  return true;
}

/** Resolve when the job finishes or after `seconds`, whichever comes first. */
export function waitForJob(id: string, seconds: number): Promise<Job | undefined> {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || seconds <= 0) return Promise.resolve(job);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve(jobs.get(id));
    };
    const timer = setTimeout(() => {
      waiters.get(id)?.delete(done);
      resolve(jobs.get(id));
    }, seconds * 1000);
    if (!waiters.has(id)) waiters.set(id, new Set());
    waiters.get(id)!.add(done);
  });
}

/** Compact view for agents: no full log, just the tail. */
export function jobSummary(job: Job, tail = 8) {
  const { log, ...rest } = job;
  return { ...rest, elapsed_s: Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000), recent_log: log.slice(-tail).map((l) => `${l.level}: ${l.msg}`) };
}
