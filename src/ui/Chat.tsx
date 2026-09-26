import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { UIMessage } from "ai";
import type { AgentKey, Job, Library } from "./api";
import { AGENT_LABEL, crewTool, md, shortName, unwrapOutput } from "./util";

type Props = {
  messages: UIMessage[];
  status: string;
  send: (text: string) => void;
  stop: () => void;
  clear: () => void;
  jobs: Job[];
  library: Library | null;
  workerReady: boolean;
  onFocusJob: (id: string) => void;
  draft: string;
  setDraft: (s: string) => void;
};

export function Console(p: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const busy = p.status === "submitted" || p.status === "streaming";

  // Follow the stream unless the user has scrolled up to read.
  useEffect(() => {
    if (stuck.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [p.messages, p.status]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const jobsById = useMemo(() => new Map(p.jobs.map((j) => [j.id, j])), [p.jobs]);

  return (
    <main className="console pane">
      <div className="scroll" ref={scrollRef} onScroll={onScroll}>
        {p.messages.length === 0 ? (
          <Empty />
        ) : (
          <div className="transcript-log">
            {p.messages.map((m, i) => (
              <Message
                key={m.id}
                msg={m}
                live={busy && i === p.messages.length - 1 && m.role === "assistant"}
                jobsById={jobsById}
                onFocusJob={p.onFocusJob}
              />
            ))}
            {p.status === "submitted" && p.messages[p.messages.length - 1]?.role === "user" && (
              <div className="msg">
                <div className="msg-who"><span className="dot" />Director</div>
                <span className="caret muted">Reading the room</span>
              </div>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <Composer {...p} busy={busy} />
    </main>
  );
}

function Empty() {
  return (
    <div className="empty dock-empty">
      <h1>Ask, or just <em>drive</em>.</h1>
      <p>
        The canvas runs everything by itself: press ▶ on a node. Talk to the Director when you'd rather say what you want,
        like "plan 3 funny clips under a minute" or "why is clip 2 so long?". It calls the same crew and the canvas updates as it works.
      </p>
      <p className="faint">
        Stop it any time with ■. Comments you leave in the canvas reach it through read_feedback.
      </p>
    </div>
  );
}

function Message({ msg, live, jobsById, onFocusJob }: {
  msg: UIMessage; live: boolean; jobsById: Map<string, Job>; onFocusJob: (id: string) => void;
}) {
  if (msg.role === "user") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    return (
      <div className="msg user">
        <div className="msg-who"><span className="dot" />You</div>
        <div className="msg-body" dir="auto">{text}</div>
      </div>
    );
  }
  const parts = msg.parts.filter((p) => p.type !== "step-start");
  const lastText = parts.map((p) => p.type).lastIndexOf("text");
  return (
    <div className="msg">
      <div className="msg-who"><span className="dot" />Director</div>
      {parts.map((part: any, i) => {
        if (part.type === "text") {
          if (!part.text.trim()) return null;
          return (
            <div
              key={i}
              dir="auto"
              className={`prose ${live && i === lastText ? "caret" : ""}`}
              dangerouslySetInnerHTML={{ __html: md(part.text) }}
            />
          );
        }
        if (part.type === "reasoning") {
          if (!part.text?.trim()) return null;
          return (
            <details key={i} className="thinking">
              <summary>thinking{part.state === "streaming" ? "…" : ""}</summary>
              <div>{part.text}</div>
            </details>
          );
        }
        if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
          const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
          return <Slate key={part.toolCallId ?? i} name={name} part={part} jobsById={jobsById} onFocusJob={onFocusJob} />;
        }
        return null;
      })}
    </div>
  );
}

function argSummary(input: any): string {
  if (!input || typeof input !== "object") return "";
  const bits: string[] = [];
  if (input.video) bits.push(shortName(String(input.video).replace(/\.[^.]+$/, "")));
  if (input.run) bits.push(shortName(String(input.run)));
  if (input.job_id) bits.push(input.job_id);
  if (input.clip_id != null) bits.push(`clip ${input.clip_id}`);
  if (Array.isArray(input.only) && input.only.length) bits.push(`clips ${input.only.join(",")}`);
  if (input.subs) bits.push("captions");
  if (input.count) bits.push(`${input.count} clips`);
  if (input.notes) bits.push(`“${input.notes}”`);
  if (input.from_s != null || input.to_s != null) bits.push(`${input.from_s ?? 0}s–${input.to_s ?? "end"}s`);
  return bits.join(" · ");
}

function Slate({ name, part, jobsById, onFocusJob }: {
  name: string; part: any; jobsById: Map<string, Job>; onFocusJob: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { tool, agent } = crewTool(name);
  const out = part.state === "output-available" ? unwrapOutput(part.output) : null;
  const failed = part.state === "output-error" || out?.isError;
  const jobId: string | undefined = out?.json?.job_id ?? out?.json?.id ?? part.input?.job_id;
  const job = jobId ? jobsById.get(jobId) : undefined;
  const pending = part.state === "input-streaming" || part.state === "input-available";

  return (
    <div className={`slate ${agent ?? ""}`}>
      <button className="slate-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="slate-agent">{agent ? AGENT_LABEL[agent as AgentKey] : "tool"}</span>
        <span className="slate-tool">{tool}</span>
        <span className="slate-args" dir="auto">{argSummary(part.input)}</span>
        <span className={`slate-state ${failed ? "err" : out ? "done" : ""}`}>
          {pending && <span className="spin" />}
          {pending ? "calling" : failed ? "error" : "ok"}
        </span>
      </button>
      {job && (
        <div className="slate-progress" onClick={() => onFocusJob(job.id)} style={{ cursor: "pointer" }} title="Show job in Crew panel">
          <div className={`film ${job.status}`} style={{ ["--p" as any]: job.progress }} />
          <div className="job-meta" style={{ marginTop: 5 }}>
            <span className="stage">{job.status === "running" ? job.stage : job.status}</span>
            <span className="mono">{job.id}</span>
          </div>
        </div>
      )}
      {open && (
        <div className="slate-body">
          <h4>Input</h4>
          <pre className="codebox">{JSON.stringify(part.input ?? {}, null, 2)}</pre>
          {(out || part.errorText) && (
            <>
              <h4>{failed ? "Error" : "Output"}</h4>
              <pre className="codebox">{part.errorText ?? (out?.json ? JSON.stringify(out.json, null, 2) : out?.text)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Composer(p: Props & { busy: boolean }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const chips = useMemo(() => suggestions(p.library), [p.library]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [p.draft]);

  const submit = () => {
    const text = p.draft.trim();
    if (!text || p.busy || !p.workerReady) return;
    p.send(text);
    p.setDraft("");
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-wrap">
      {!p.busy && chips.length > 0 && (
        <div className="chips">
          {chips.map((c) => (
            <button key={c.text} className="chip" style={{ ["--c" as any]: `var(--${c.agent})` }} onClick={() => p.setDraft(c.text)} title={c.text}>
              <b>{c.label}</b>{c.target}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          ref={ta}
          rows={1}
          dir="auto"
          value={p.draft}
          onChange={(e) => p.setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={p.workerReady ? "Ask the Director. Enter to send, Shift+Enter for a new line" : "Waiting for the Director to come online…"}
        />
        {p.busy ? (
          <button className="btn send danger" onClick={p.stop} title="Stop">■</button>
        ) : (
          <button className="btn primary send" onClick={submit} disabled={!p.draft.trim() || !p.workerReady} title="Send">↑</button>
        )}
      </div>
      <div className="console-foot">
        <span>{p.busy ? "Director is working…" : p.status === "error" ? "Last turn failed. Try again." : " "}</span>
        {p.messages.length > 0 && !p.busy && (
          <button className="btn ghost sm" onClick={() => confirm("Clear the conversation with the Director?") && p.clear()}>
            Clear conversation
          </button>
        )}
      </div>
    </div>
  );
}

type Chip = { label: string; target: string; text: string; agent: AgentKey | "director" };

function suggestions(lib: Library | null): Chip[] {
  if (!lib) return [];
  const out: Chip[] = [];
  const untranscribed = lib.videos.find((v) => !v.transcript);
  const unplanned = lib.videos.find((v) => v.transcript && v.runs.length === 0);
  const uncut = lib.runs.find((r) => r.clips.some((c) => !c.file));
  const latest = lib.videos.find((v) => v.transcript) ?? lib.videos[0];

  if (untranscribed) {
    const n = shortName(untranscribed.stem);
    out.push({ label: "Transcribe", target: n, text: `Transcribe "${untranscribed.name}".`, agent: "transcribe" });
  }
  if (unplanned) {
    const n = shortName(unplanned.stem);
    out.push({ label: "Plan", target: n, text: `Plan clips for "${unplanned.name}" using the outline.`, agent: "plan" });
  }
  if (latest) {
    out.push({ label: "New take", target: shortName(latest.stem), text: `Plan a fresh set of clips for "${latest.name}" that avoids moments we've already used.`, agent: "plan" });
  }
  if (uncut) {
    out.push({ label: "Cut", target: `run ${uncut.created}`, text: `Extract the clips from run "${uncut.id}" with captions.`, agent: "extract" });
  }
  out.push({ label: "Review", target: "what worked before", text: "Summarise the clip history: what we've cut so far and any performance notes.", agent: "director" });
  return out.slice(0, 5);
}
