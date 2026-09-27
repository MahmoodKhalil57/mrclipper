import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { actions, thumbUrl, useStudio, type Video } from "./api";
import { AddVideo } from "./AddVideo";
import { Console } from "./Chat";
import { AgentDock } from "./AgentDock";
import { TOOLS, registerTools, webmcpAvailable } from "./webmcp";
import { Film } from "./Common";
import { PipelineCanvas, type CutOptions, type FlowHandlers } from "./Flow";
import { Panel } from "./Panels";
import { derivePipeline, nextStep, type StageKey } from "./pipeline";
import { AGENT_LABEL, shortName, tc, usd } from "./util";
import { KeyButton } from "./Key";
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
  const [project, setProject] = useState<string | null>(() => store.get("clipdesk.project", null));
  const [runByProject, setRunByProject] = useState<Record<string, string>>(() => store.get("clipdesk.runs", {}));
  const [stage, setStage] = useState<StageKey | null>(null);
  const [dock, setDock] = useState<boolean>(() => store.get("clipdesk.dock", true));
  const [cutOpts, setCutOptsState] = useState<CutOptions>(() => store.get("clipdesk.cut", { subs: true, vertical: true }));
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

  useEffect(() => store.set("clipdesk.project", project), [project]);
  useEffect(() => store.set("clipdesk.runs", runByProject), [runByProject]);
  useEffect(() => store.set("clipdesk.dock", dock), [dock]);
  const setCutOpts = (o: CutOptions) => (setCutOptsState(o), store.set("clipdesk.cut", o));

  // Keep a valid project selected.
  const video: Video | null = useMemo(() => {
    if (!library?.videos.length) return null;
    return library.videos.find((v) => v.name === project) ?? library.videos[0];
  }, [library, project]);

  const p = useMemo(
    () => (video && library ? derivePipeline(video, library, jobs, runByProject[video.name] ?? null) : null),
    [video, library, jobs, runByProject],
  );
  const next = p ? nextStep(p) : null;

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

  // A new plan becomes the active take.
  const lastPlanDone = useRef<string | null>(null);
  useEffect(() => {
    const done = jobs.find((j) => j.agent === "plan" && j.status === "done" && j.result?.run);
    if (done && done.id !== lastPlanDone.current && Date.now() - (done.finishedAt ?? 0) < 8000) {
      lastPlanDone.current = done.id;
      setRunByProject((m) => ({ ...m, [done.input.video]: done.result.run }));
    }
  }, [jobs]);

  const guard = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      studio.refresh();
    } catch (e) {
      const err = e as Error & { approval?: boolean };
      toast(err.message, "err");
      if (err.approval) setStage("review");
    }
  };

  const runStage = (s: "transcribe" | "brief" | "plan" | "design" | "cut" | "watch" | "rubric" | "coach", extra: Record<string, unknown> = {}) => {
    if (!p) return;
    if (s === "transcribe") guard(() => actions.start("transcribe", { video: p.video.name, ...extra }));
    if (s === "plan") guard(() => actions.start("plan", { video: p.video.name, ...extra }));
    if (s === "design" && p.run) guard(() => actions.design(p.run!.id));
    if (s === "brief") guard(() => actions.brief(p.video.name));
    if (s === "watch" && p.run) guard(() => actions.watch(p.run!.id, !!extra.force));
    if (s === "rubric") guard(() => actions.rubric(p.video.name, typeof extra.direction === "string" ? extra.direction : undefined));
    if (s === "coach") guard(() => actions.coach(p.video.name, typeof extra.direction === "string" ? extra.direction : undefined));
    if (s === "cut" && p.run) guard(() => actions.start("extract", { run: p.run!.id, subs: cutOpts.subs, vertical: cutOpts.vertical, ...extra }));
  };
  const stop = (id: string) => guard(() => actions.cancel(id), "Stopping…");
  const approve = (approved = true) => p?.run && guard(() => actions.approve(p.run!.id, approved), approved ? "Approved. The Editor can cut now." : "Unapproved");
  const ask = (text: string) => {
    setDraft(text);
    setDock(true);
  };

  const handlers: FlowHandlers = {
    select: (s) => setStage((cur) => (cur === s ? null : s)),
    transcribe: () => runStage("transcribe"),
    brief: () => runStage("brief"),
    plan: () => runStage("plan"),
    design: () => runStage("design"),
    watch: () => runStage("watch"),
    rubric: () => runStage("rubric"),
    coach: () => runStage("coach"),
    applyProposal: (id) => guard(() => actions.applyProposal(id), "Outline updated. The next take is planned with it."),
    approve: () => approve(true),
    cut: () => runStage("cut"),
    stop,
    cutOpts,
    setCutOpts,
  };

  const running = jobs.filter((j) => j.status === "running");
  const spend = jobs.reduce((n, j) => n + (j.cost || 0), 0);
  const gate = library?.settings?.requireApproval ?? true;
  const engine = library?.settings?.engine ?? "classic";
  const webmcp = engine === "webmcp";

  // WebMCP mode: expose the pipeline as tools to the agent in this browser; unregister when leaving the mode.
  const [registered, setRegistered] = useState(0);
  useEffect(() => {
    if (!webmcp || !webmcpAvailable()) return setRegistered(0);
    let undo = () => {};
    let alive = true;
    registerTools()
      .then((u) => (alive ? ((undo = u), setRegistered(TOOLS.length)) : u()))
      .catch((e) => toast(`Couldn't register WebMCP tools: ${e instanceof Error ? e.message : e}`, "err"));
    return () => {
      alive = false;
      undo();
      setRegistered(0);
    };
  }, [webmcp]);

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
    <div className={`studio ${dock ? "dock-open" : ""} ${stage && p ? "panel-open" : ""}`}>
      <header className="topbar">
        <button className={`btn ghost sm dock-btn ${dock ? "on" : ""}`} onClick={() => setDock(!dock)} title={webmcp ? "Browser agent (WebMCP)" : "Director chat"}>
          {webmcp
            ? <><span className={`lamp ${registered ? "ready" : "down"}`} /> Agent</>
            : <><span className={`lamp ${workerReady ? "ready" : status?.worker ?? "starting"}`} /> Director</>}
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <span className="brand-name">Clipdesk</span>
        </div>
        <ProjectSwitcher videos={library?.videos ?? []} current={video} onPick={(n) => (setProject(n), setStage(null))} onAdd={() => setAdding(true)} toast={toast} />
        <div className="spacer" />
        <div className="engine-switch" role="radiogroup" aria-label="Crew engine"
          title="Who does the thinking. LLM and System One use OpenRouter; WebMCP hands it to the agent in your browser and makes no OpenRouter calls.">
          <span className="label">Crew engine</span>
          {(["classic", "hybrid", "jev", "webmcp"] as const).map((e) => (
            <button key={e} role="radio" aria-checked={engine === e} className={`${engine === e ? "on" : ""} e-${e}`}
              title={e === "hybrid" ? "An LLM compiles your outline into Jev's questions and edit guidance, Jev decides, the LLM titles the picks" : undefined}
              onClick={() => engine !== e && guard(() => actions.settings({ engine: e }),
                e === "jev" ? "System One mode: Planner and Designer use Jev"
                  : e === "hybrid" ? "Hybrid mode: an LLM briefs Jev from your outline, Jev plans and designs, the LLM writes titles"
                  : e === "webmcp" ? "WebMCP mode: no OpenRouter calls. The agent in your browser does the thinking."
                  : "Classic mode: Planner uses an LLM")}>
              {e === "classic" ? "LLM" : e === "hybrid" ? <><i className="hy" />Hybrid</> : e === "jev" ? <><i className="s1" />System One</> : <><i className="wm" />WebMCP</>}
            </button>
          ))}
        </div>
        <KeyButton status={status?.key} needed={!webmcp} onChange={studio.refreshStatus} toast={toast} />
        <button className={`gate-toggle ${gate ? "on" : ""}`} onClick={() => guard(() => actions.settings({ requireApproval: !gate }), gate ? "Review gate off: plans cut without approval" : "Review gate on")}
          title="When on, nothing is cut until you approve the plan">
          <span className="gate-switch"><i /></span> Review gate
        </button>
        {running.length > 0 && <span className="meter"><span className="lamp starting" /><b>{running.length}</b> running</span>}
        <span className="meter hide-sm" title="OpenRouter spend reported by crew jobs">spend <b>{usd(spend)}</b></span>
      </header>

      <aside className="dock pane">
        <div className="dock-head">
          <span className="pane-title">{webmcp ? "Browser agent" : "Director"}</span>
          <span className="mono faint">{webmcp ? "WebMCP" : status?.models.director.split("/")[1]}</span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setDock(false)} aria-label="Hide panel">⟨</button>
        </div>
        {webmcp ? <AgentDock registered={registered} /> : <Console
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
        />}
      </aside>

      <main className="stage-area">
        {p && next ? (
          <>
            <div className="guide">
              <Steps p={p} onPick={(s) => setStage(s)} current={next.stage} />
              <div className="guide-text"><b>Next</b> {next.text}</div>
            </div>
            <PipelineCanvas p={p} h={handlers} selected={stage} next={next.stage} fitKey={`${dock}-${!!stage}`} />
          </>
        ) : library ? (
          <div className="hero-wrap"><AddVideo hero onAdded={onAdded} importJob={importJob} /><WorkspaceLine toast={toast} /></div>
        ) : null}

        {running.length > 0 && (
          <div className="tray">
            {running.map((j) => (
              <div key={j.id} className={`tray-item ${j.agent}`}>
                <span className="tag" style={{ ["--c" as any]: `var(--${j.agent === "import" ? "director" : j.agent})` }}>{j.agent === "import" ? "Import" : AGENT_LABEL[j.agent]}</span>
                <div className="grow">
                  <div className="tray-title" dir="auto">{j.stage}</div>
                  <Film value={j.progress} status="running" agent={j.agent === "import" ? "director" : j.agent} />
                </div>
                <button className="btn sm danger" onClick={() => stop(j.id)} title="Stop">■</button>
              </div>
            ))}
          </div>
        )}
      </main>

      {stage && p && library && (
        <Panel
          stage={stage}
          onClose={() => setStage(null)}
          p={p}
          lib={library}
          jobs={jobs}
          refresh={studio.refresh}
          ask={ask}
          stop={stop}
          selectRun={(id) => setRunByProject((m) => ({ ...m, [p.video.name]: id }))}
          run={runStage}
          approve={approve}
          cutOpts={cutOpts}
          setCutOpts={setCutOpts}
          toast={toast}
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

function Steps({ p, current, onPick }: { p: ReturnType<typeof derivePipeline>; current: StageKey; onPick: (s: StageKey) => void }) {
  const steps: { k: StageKey; label: string; state: string }[] = [
    { k: "transcribe", label: "Transcribe", state: p.transcribe.state },
    { k: "brief", label: "Brief", state: p.brief.state },
    { k: "plan", label: "Plan", state: p.plan.state },
    { k: "design", label: "Design", state: p.design.state },
    { k: "review", label: "Review", state: p.review.state },
    { k: "cut", label: "Cut", state: p.cut.state },
    { k: "clips", label: "Clips", state: p.clips.state },
    { k: "watch", label: "Watch", state: p.watch.state },
    { k: "rubric", label: "Rubric", state: p.rubric.state },
    { k: "coach", label: "Coach", state: p.coach.state },
  ];
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={s.k} className={`s-${s.state} ${current === s.k ? "cur" : ""}`}>
          <button onClick={() => onPick(s.k)}><span>{i + 1}</span>{s.label}</button>
        </li>
      ))}
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
                  {v.transcript ? <span className="tag" style={{ ["--c" as any]: "var(--transcribe)" }}>transcribed</span> : <span className="tag">new</span>}
                  {v.runs.length > 0 && <span className="tag" style={{ ["--c" as any]: "var(--plan)" }}>{v.runs.length} take{v.runs.length > 1 ? "s" : ""}</span>}
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
