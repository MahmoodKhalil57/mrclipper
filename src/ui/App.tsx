import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { actions, thumbUrl, useStudio, useWorkflow, type NodeId, type NodeState, type StepArgs, type Video, type Workflow } from "./api";
import { AddVideo } from "./AddVideo";
import { WorkflowCanvas, NODE_TITLE, PHASES, type CanvasHandlers } from "./Canvas";
import { Console } from "./Chat";
import { Film } from "./Common";
import { KeyButton } from "./Key";
import { Panel } from "./panels";
import { AGENT_LABEL, AGENT_WHO, shortName, tc, usd } from "./util";
import { WorkspaceLine } from "./Workspace";

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

type Toast = { id: number; msg: string; kind: "err" | "ok" };

export function App() {
  const studio = useStudio();
  const { library, jobs, status } = studio;
  const [project, setProject] = useState<string | null>(() => store.get("mrclipper.project", null));
  // A take you chose to look at; otherwise the latest take is shown.
  const [takeByVideo, setTakeByVideo] = useState<Record<string, string>>(() => store.get("mrclipper.takes", {}));
  const [open, setOpen] = useState<NodeId | null>(null);
  const [dock, setDock] = useState<boolean>(() => store.get("mrclipper.dock", true));
  const [adding, setAdding] = useState(false);
  const [importId, setImportId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);

  const agent = useAgent({ agent: "director", name: "studio" });
  const chat = useAgentChat({ agent });
  const workerReady = status?.worker === "ready" && agent.readyState === WebSocket.OPEN;

  const toast = useCallback((msg: string, kind: "err" | "ok" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 7000 : 3500);
  }, []);

  useEffect(() => store.set("mrclipper.project", project), [project]);
  useEffect(() => store.set("mrclipper.takes", takeByVideo), [takeByVideo]);
  useEffect(() => store.set("mrclipper.dock", dock), [dock]);

  // Keep a valid project selected.
  const video: Video | null = useMemo(() => {
    if (!library?.videos.length) return null;
    return library.videos.find((v) => v.name === project) ?? library.videos[0];
  }, [library, project]);
  const takeId = video ? takeByVideo[video.name] ?? null : null;
  const { wf } = useWorkflow(video?.name ?? null, takeId, studio.version);
  const run = useMemo(() => (wf?.take && library ? library.runs.find((r) => r.id === wf.take!.id) ?? null : null), [wf?.take?.id, library]);

  // A finished import becomes the active project.
  const importJob = jobs.find((j) => j.id === importId);
  useEffect(() => {
    if (importJob?.status === "done" && importJob.result?.video) {
      setProject(importJob.result.video);
      setAdding(false);
      setImportId(null);
      toast(`Imported ${importJob.result.video}`);
    }
  }, [importJob?.status]);

  // A new take (Pick) becomes the one you're looking at.
  const lastPick = useRef<string | null>(null);
  useEffect(() => {
    const done = jobs.find((j) => j.agent === "pick" && j.status === "done" && j.result?.run);
    if (done && done.id !== lastPick.current && Date.now() - (done.finishedAt ?? 0) < 10000) {
      lastPick.current = done.id;
      setTakeByVideo((m) => {
        const { [done.input.video]: _, ...rest } = m;
        return rest;
      });
    }
  }, [jobs]);

  const guard = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      studio.refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const stop = (id: string) => guard(() => actions.cancel(id), "Stopping…");
  const step = (id: NodeId, args: StepArgs = {}) => {
    if (!video) return;
    guard(() => actions.step(id, { video: video.name, take: wf?.take?.id, ...args }));
  };
  const runAll = () => video && guard(() => actions.run(video.name, takeId), "Running the workflow");
  const ask = (text: string) => {
    setDraft(text);
    setDock(true);
  };

  const handlers: CanvasHandlers = {
    open: (id) => setOpen((cur) => (cur === id ? null : id)),
    step: (id) => step(id),
    stop,
    applyProposal: (id) => guard(() => actions.applyProposal(id), "Outline updated. ▶ Run makes a new take with it."),
  };

  const running = jobs.filter((j) => j.status === "running");
  const spend = jobs.reduce((n, j) => n + (j.cost || 0), 0);

  // Drop a file anywhere to add it.
  useEffect(() => {
    const enter = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && setDragging(true);
    window.addEventListener("dragenter", enter);
    return () => window.removeEventListener("dragenter", enter);
  }, []);

  const onAdded = (name: string | null, jobId?: string) => {
    setDragging(false);
    if (jobId) setImportId(jobId);
    if (name) {
      setProject(name);
      setAdding(false);
      toast(`Added ${name}`);
      studio.refresh();
    }
  };

  return (
    <div className={`studio ${dock ? "dock-open" : ""} ${open && wf ? "panel-open" : ""}`}>
      <header className="topbar">
        <button className={`btn ghost sm dock-btn ${dock ? "on" : ""}`} onClick={() => setDock(!dock)} title="Director chat">
          <span className={`lamp ${workerReady ? "ready" : status?.worker ?? "starting"}`} /> Director
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">mrClipper</span>
        </div>
        <ProjectSwitcher videos={library?.videos ?? []} current={video} onPick={(n) => (setProject(n), setOpen(null))} onAdd={() => setAdding(true)} toast={toast} />
        <div className="spacer" />
        {wf && <RunButton wf={wf} onRun={runAll} onStop={stop} />}
        <KeyButton status={status?.key} onChange={studio.refreshStatus} toast={toast} />
        {running.length > 0 && <span className="meter"><span className="lamp starting" /><b>{running.length}</b> running</span>}
        <span className="meter hide-sm" title="OpenRouter spend reported by jobs">spend <b>{usd(spend)}</b></span>
      </header>

      <aside className="dock pane">
        <div className="dock-head">
          <span className="pane-title">Director</span>
          <span className="mono faint">{status?.models.director.split("/")[1]}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setDock(false)} aria-label="Hide panel">⟨</button>
        </div>
        <Console
          messages={chat.messages}
          status={chat.status}
          send={(text) => chat.sendMessage({ text })}
          stop={chat.stop}
          clear={chat.clearHistory}
          jobs={jobs}
          library={library}
          workerReady={workerReady}
          onFocusJob={() => {}}
          draft={draft}
          setDraft={setDraft}
        />
      </aside>

      <main className="stage-area">
        {video && wf && library ? (
          <>
            <div className="guide">
              <PhaseStrip wf={wf} onPick={(id) => setOpen(id)} />
              <div className="guide-text"><b>Next</b> <span dir="auto">{wf.next.text}</span></div>
            </div>
            <WorkflowCanvas wf={wf} lib={library} jobs={jobs} run={run} selected={open} h={handlers} fitKey={`${dock}-${!!open}`} />
          </>
        ) : library && !library.videos.length ? (
          <div className="hero-wrap"><AddVideo hero onAdded={onAdded} importJob={importJob} /><WorkspaceLine toast={toast} /></div>
        ) : null}

        {running.length > 0 && (
          <div className="tray">
            {running.map((j) => (
              <div key={j.id} className={`tray-item who-${AGENT_WHO[j.agent] ?? "code"}`}>
                <span className="tag" style={{ ["--c" as any]: `var(--who-${AGENT_WHO[j.agent] ?? "code"})` }}>{AGENT_LABEL[j.agent] ?? j.agent}</span>
                <div className="grow">
                  <div className="tray-title" dir="auto">{j.stage}</div>
                  <Film value={j.progress} status="running" agent={`who-${AGENT_WHO[j.agent] ?? "code"}`} />
                </div>
                <button className="btn sm danger" onClick={() => stop(j.id)} title="Stop">■</button>
              </div>
            ))}
          </div>
        )}
      </main>

      {open && wf && library && video && (
        <Panel
          id={open}
          onClose={() => setOpen(null)}
          wf={wf}
          lib={library}
          jobs={jobs}
          run={run}
          video={video}
          refresh={studio.refresh}
          ask={ask}
          stop={stop}
          toast={toast}
          step={step}
          selectTake={(id) => setTakeByVideo((m) => {
            const { [video.name]: _, ...rest } = m;
            return id ? { ...rest, [video.name]: id } : rest;
          })}
        />
      )}

      {(adding || dragging) && (
        <div className="modal-back" onClick={() => (setAdding(false), setDragging(false))}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}>
          <div className="modal add-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="pane-title">Add a video</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => (setAdding(false), setDragging(false))}>Close</button>
            </div>
            <AddVideo onAdded={onAdded} importJob={importJob} />
          </div>
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} dir="auto">{t.msg}</div>)}
      </div>
    </div>
  );
}

/** ▶ Run: every step that isn't done, in order, stopping at Review. Its tooltip says exactly what it will do. */
function RunButton({ wf, onRun, onStop }: { wf: Workflow; onRun: () => void; onStop: (id: string) => void }) {
  if (wf.run) return <button className="btn danger run-btn" onClick={() => onStop(wf.run!)} title="Stop the workflow (the current step stops too)">■ Stop run</button>;
  const n = wf.plan.length;
  return (
    <button className="btn primary run-btn" disabled={!n} onClick={onRun}
      title={n ? `Runs: ${wf.plan.map((s) => NODE_TITLE[s]).join(" → ")}` : wf.next.text}>
      ▶ Run{n ? <span className="run-n">{n} step{n === 1 ? "" : "s"}</span> : null}
    </button>
  );
}

const RANK: NodeState[] = ["running", "waiting", "failed", "stopped", "stale", "ready", "empty", "locked", "optional", "done"];
/** The six phases, each showing its most urgent node state. */
function PhaseStrip({ wf, onPick }: { wf: Workflow; onPick: (id: NodeId) => void }) {
  return (
    <ol className="steps phases">
      {PHASES.map((name, i) => {
        const nodes = Object.values(wf.nodes).filter((n) => n.phase === i + 1);
        const worst = RANK.find((s) => nodes.some((n) => n.state === s)) ?? "done";
        const target = nodes.find((n) => n.state === worst) ?? nodes[0];
        const state = worst === "optional" ? "done" : worst === "empty" ? "ready" : worst;
        return (
          <li key={name} className={`s-${state} ${wf.nodes[wf.next.node].phase === i + 1 ? "cur" : ""}`}>
            <button onClick={() => onPick(target.id)} title={nodes.map((n) => `${NODE_TITLE[n.id]}: ${n.state}`).join("\n")}><span>{i + 1}</span>{name}</button>
          </li>
        );
      })}
    </ol>
  );
}

function ProjectSwitcher({ videos, current, onPick, onAdd, toast }: { videos: Video[]; current: Video | null; onPick: (n: string) => void; onAdd: () => void; toast: (m: string, kind?: "err" | "ok") => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="switcher" onClick={(e) => e.stopPropagation()}>
      {current ? (
        <button className="switch-btn" onClick={() => setOpen(!open)}>
          <img src={thumbUrl(current.name, current.duration * 0.18)} alt="" />
          <span className="switch-name" dir="auto">{shortName(current.stem)}</span>
          <span className="faint">▾</span>
        </button>
      ) : null}
      <button className="btn sm primary" onClick={onAdd}>+ Add video</button>
      {open && (
        <div className="switch-menu">
          {videos.map((v) => (
            <button key={v.name} className={`switch-item ${v.name === current?.name ? "on" : ""}`} onClick={() => (onPick(v.name), setOpen(false))}>
              <img src={thumbUrl(v.name, v.duration * 0.18)} alt="" />
              <div className="grow">
                <div className="switch-title" dir="auto">{v.stem.replace(/\s*\[[\w-]+\]\s*$/, "")}</div>
                <div className="reel-meta">
                  <span className="mono">{tc(v.duration)}</span>
                  {v.transcript ? <span className="tag" style={{ ["--c" as any]: "var(--who-transcriber)" }}>transcribed</span> : <span className="tag">new</span>}
                  {v.runs.length > 0 && <span className="tag" style={{ ["--c" as any]: "var(--who-jev)" }}>{v.runs.length} take{v.runs.length > 1 ? "s" : ""}</span>}
                </div>
              </div>
            </button>
          ))}
          <button className="switch-item add" onClick={() => (onAdd(), setOpen(false))}>+ Add another video</button>
          <WorkspaceLine toast={toast} />
        </div>
      )}
    </div>
  );
}
