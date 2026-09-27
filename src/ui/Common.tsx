import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Comment, Job } from "./api";
import { AGENT_LABEL, AGENT_WHO, clock, elapsed, md, usd } from "./util";

export function Film({ value, status, agent }: { value: number; status: string; agent?: string }) {
  return <div className={`film ${status}`} style={{ ["--p" as any]: value, ...(agent ? { ["--c" as any]: `var(--${agent})` } : {}) }} />;
}

export function JobLog({ job, height = 200 }: { job: Job; height?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.log.length]);
  return (
    <pre ref={ref} className="job-log" style={{ maxHeight: height }}>
      {job.log.length === 0 ? "…" : job.log.map((l, i) => (
        <div key={i} className={l.level}><time>{clock(l.t)}</time>{l.msg}</div>
      ))}
    </pre>
  );
}

/** A job summary with progress, stop control and log. */
export function JobCard({ job, onStop, flash, defaultOpen }: { job: Job; onStop?: (id: string) => void; flash?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? job.status === "running");
  const ref = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (job.status !== "running") return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [job.status]);
  useEffect(() => {
    if (flash) {
      setOpen(true);
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [flash]);

  const agent = `who-${AGENT_WHO[job.agent] ?? "code"}`;
  return (
    <div ref={ref} className={`job ${agent} ${flash ? "flash" : ""}`}>
      <div className="job-head">
        <div className="job-top">
          <span className="tag" style={{ ["--c" as any]: `var(--${agent})` }}>{AGENT_LABEL[job.agent] ?? job.agent}</span>
          <button className="job-title linkish" dir="auto" title={job.title} onClick={() => setOpen(!open)}>{job.title}</button>
          {job.status === "running" && onStop && (
            <button className="btn sm danger" onClick={() => onStop(job.id)} title="Stop this job">■ Stop</button>
          )}
          <StateChip state={job.status === "running" ? "running" : job.status === "done" ? "done" : job.status === "cancelled" ? "stopped" : "failed"} />
        </div>
        <Film value={job.status === "done" ? 1 : job.progress} status={job.status} agent={agent} />
        <div className="job-meta">
          <span className="stage" dir="auto">{job.status === "failed" || job.status === "cancelled" ? job.error : job.stage}</span>
          <span style={{ flex: 1 }} />
          {job.cost > 0 && <span className="mono">{usd(job.cost)}</span>}
          <span className="mono">{elapsed((job.finishedAt ?? Date.now()) - job.startedAt)}</span>
          <button className="btn ghost xs" onClick={() => setOpen(!open)}>{open ? "hide log" : "log"}</button>
        </div>
      </div>
      {open && <JobLog job={job} />}
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  empty: "add it", optional: "optional", locked: "waiting", ready: "ready", stale: "out of date",
  running: "running", waiting: "your turn", done: "done", failed: "failed", stopped: "stopped",
};

export function StateChip({ state }: { state: string }) {
  return <span className={`state-chip s-${state}`}>{state === "running" && <i className="spin" />}{STATE_LABEL[state] ?? state}</span>;
}

/** A thread of comments with an input. Comments are stored with the artifact and read by the agents. */
export function Thread({ comments, onAdd, onDelete, placeholder, onSendToDirector, compact }: {
  comments: Comment[]; onAdd: (text: string) => Promise<unknown>; onDelete: (id: string) => void;
  placeholder?: string; onSendToDirector?: (text: string) => void; compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await onAdd(text.trim());
      setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`thread ${compact ? "compact" : ""}`}>
      {comments.map((c) => (
        <div key={c.id} className="comment">
          <div className="comment-text" dir="auto">{c.text}</div>
          <div className="comment-meta">
            <span>{new Date(c.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
            {onSendToDirector && <button className="linkish" onClick={() => onSendToDirector(c.text)}>ask Director</button>}
            <button className="linkish" onClick={() => onDelete(c.id)}>delete</button>
          </div>
        </div>
      ))}
      <div className="comment-input">
        <textarea
          rows={1}
          dir="auto"
          value={text}
          placeholder={placeholder ?? "Leave a note for the agents…"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn sm" disabled={!text.trim() || busy} onClick={submit}>Comment</button>
      </div>
    </div>
  );
}

export function TextEditor({ path, initial, hint, save, onSaved }: {
  path: string; initial: string; hint: ReactNode; save: (text: string) => Promise<void>; onSaved: () => void;
}) {
  const [text, setText] = useState(initial);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [msg, setMsg] = useState("");
  const dirty = text !== initial;
  useEffect(() => setText(initial), [initial]);

  const onSave = async () => {
    try {
      await save(text);
      setMsg("Saved");
      onSaved();
      setTimeout(() => setMsg(""), 1800);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Save failed");
    }
  };

  return (
    <div className="stack">
      <div className="hint">{hint}</div>
      <div className="editor-bar">
        <span className="grow mono">{path}{dirty ? " · unsaved" : ""}{msg ? ` · ${msg}` : ""}</span>
        <button className="btn sm ghost" onClick={() => setMode(mode === "edit" ? "preview" : "edit")}>{mode === "edit" ? "Preview" : "Edit"}</button>
        <button className="btn sm" disabled={!dirty} onClick={() => setText(initial)}>Revert</button>
        <button className="btn sm primary" disabled={!dirty} onClick={onSave}>Save</button>
      </div>
      {mode === "edit" ? (
        <textarea
          className="editor"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              if (dirty) onSave();
            }
          }}
        />
      ) : (
        <div className="card prose" dir="auto" dangerouslySetInnerHTML={{ __html: md(text) }} />
      )}
    </div>
  );
}
