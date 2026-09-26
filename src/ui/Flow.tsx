import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { fileUrl, thumbUrl, type Engine } from "./api";
import { Film, StateChip } from "./Common";
import { outlineSetting, type NodeState, type Pipeline, type StageKey } from "./pipeline";
import { bytes, tc } from "./util";

export type CutOptions = { subs: boolean; vertical: boolean };

export type FlowHandlers = {
  select: (stage: StageKey) => void;
  transcribe: () => void;
  brief: () => void;
  plan: () => void;
  design: () => void;
  watch: () => void;
  rubric: () => void;
  coach: () => void;
  applyProposal: (id: string) => void;
  approve: () => void;
  cut: () => void;
  stop: (jobId: string) => void;
  cutOpts: CutOptions;
  setCutOpts: (o: CutOptions) => void;
};

type NodeData = { p: Pipeline; h: FlowHandlers; selected: StageKey | null; next: StageKey };

const LAYOUT: Record<StageKey, { x: number; y: number }> = {
  source: { x: 0, y: -80 },
  outline: { x: 0, y: 330 },
  transcribe: { x: 330, y: -40 },
  brief: { x: 330, y: 330 },
  plan: { x: 660, y: 60 },
  design: { x: 990, y: 20 },
  review: { x: 1320, y: 60 },
  cut: { x: 1650, y: 10 },
  clips: { x: 1980, y: 40 },
  // The feedback row runs right to left, back towards the Outline.
  watch: { x: 1650, y: 620 },
  rubric: { x: 1320, y: 620 },
  coach: { x: 990, y: 620 },
};

const AGENT: Record<StageKey, string> = {
  source: "director", outline: "director", transcribe: "transcribe", brief: "brief", plan: "plan", design: "design", review: "director", cut: "extract", clips: "extract", watch: "transcribe", rubric: "brief", coach: "coach",
};

// ── Node shell ─────────────────────────────────────────────────────

function Shell({ stage, title, kicker, state, data, children, actions, inputs = true, outputs = true, extra, reverse }: {
  stage: StageKey; title: string; kicker: string; state: NodeState; data: NodeData;
  children: React.ReactNode; actions?: React.ReactNode; inputs?: boolean; outputs?: boolean; extra?: React.ReactNode;
  /** Right-to-left node (the feedback row): input on the right, output on the left. */
  reverse?: boolean;
}) {
  const isNext = data.next === stage && state !== "running" && state !== "done";
  return (
    <div
      className={`gnode ${AGENT[stage]} s-${state} ${data.selected === stage ? "picked" : ""} ${isNext ? "is-next" : ""}`}
      onClick={() => data.h.select(stage)}
    >
      {inputs && <Handle type="target" position={reverse ? Position.Right : Position.Left} className="port" />}
      <div className="gnode-head">
        <div>
          <div className="gnode-kicker">{kicker}</div>
          <div className="gnode-title">{title}</div>
        </div>
        <StateChip state={state} />
      </div>
      <div className="gnode-body">{children}</div>
      {actions && (
        <div className="gnode-actions nodrag" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      )}
      {outputs && <Handle type="source" position={reverse ? Position.Left : Position.Right} className="port" />}
      {extra}
      {isNext && <div className="next-flag">next step</div>}
    </div>
  );
}

function RunStop({ state, job, onRun, onStop, runLabel, rerunLabel }: {
  state: NodeState; job?: { id: string }; onRun: () => void; onStop: (id: string) => void; runLabel: string; rerunLabel: string;
}) {
  if (state === "running" && job) return <button className="btn sm danger" onClick={() => onStop(job.id)}>■ Stop</button>;
  if (state === "locked") return <button className="btn sm" disabled>{runLabel}</button>;
  const primary = state === "ready" || state === "failed" || state === "stopped";
  return (
    <button className={`btn sm ${primary ? "primary" : ""}`} onClick={onRun}>
      {primary ? `▶ ${state === "ready" ? runLabel : "Retry"}` : `↻ ${rerunLabel}`}
    </button>
  );
}

// ── Nodes ──────────────────────────────────────────────────────────

function SourceNode({ data }: NodeProps<Node<NodeData>>) {
  const { video } = data.p;
  return (
    <Shell stage="source" kicker="01 · Input" title="Video" state="done" data={data} inputs={false}>
      <div className="thumb" style={{ backgroundImage: `url("${thumbUrl(video.name, video.duration * 0.18)}")` }}>
        <span className="mono">{tc(video.duration)}</span>
      </div>
      <div className="gnode-name" dir="auto">{video.stem.replace(/\s*\[[\w-]+\]\s*$/, "")}</div>
      <div className="gnode-meta"><span>{bytes(video.size)}</span><span className="mono">{video.path.split("/").slice(0, -1).join("/") || "project root"}</span></div>
    </Shell>
  );
}

/** Second input: the outline steers the Planner (what to pick) and the Editor (how to cut). */
function OutlineNode({ data }: NodeProps<Node<NodeData>>) {
  const text = data.p.outline.text;
  const s = (label: string) => outlineSetting(text, label);
  const rows: [string, string | undefined][] = [
    ["Clips", [s("Number of clips"), s("Clip length")].filter(Boolean).join(" · ") || undefined],
    ["Format", [s("Aspect ratio"), s("Platform")?.split("/")[0]?.trim()].filter(Boolean).join(" · ") || undefined],
    ["Story", [s("Structure"), s("Max segments per clip") && `≤${s("Max segments per clip")} segments`].filter(Boolean).join(" · ") || undefined],
    ["Captions", s("Caption style")],
    ["Title", s("Hook title")?.match(/^\s*(yes|no)/i)?.[1] ? (s("Hook title")!.match(/^\s*yes/i) ? `hook card, ${s("Title duration") ?? "2.5 seconds"}` : "off") : undefined],
  ];
  const sections = (text.match(/^## /gm) ?? []).length;
  return (
    <Shell stage="outline" kicker="01 · Input" title="Outline" state={data.p.outline.state} data={data} inputs={false}
      extra={<>
        <Handle type="target" id="loop" position={Position.Bottom} className="port loop-port" style={{ left: "28%" }} />
        <Handle type="source" id="tocoach" position={Position.Bottom} className="port" style={{ left: "72%" }} />
      </>}>
      <div className="outline-rows">
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <div key={k}><span>{k}</span><b dir="auto">{v}</b></div>
        ))}
      </div>
      <div className="gnode-meta"><span>{sections} sections · feeds the Brief</span><span className="mono">clip_outline.md</span></div>
      {data.p.coach.current && (
        <div className="gnode-meta">
          <span className={`engine-tag ${data.p.coach.current.source === "coach" ? "coach" : ""}`}>{data.p.coach.current.label}{data.p.coach.current.source === "coach" ? " · by coach" : ""}</span>
          <span className="mono">{data.p.coach.current.mean !== null ? `one-shot ${data.p.coach.current.mean}` : "not scored yet"}</span>
        </div>
      )}
    </Shell>
  );
}

function TranscribeNode({ data }: NodeProps<Node<NodeData>>) {
  const { transcribe: t, video, engine } = data.p;
  const cells = Array.from({ length: t.chunks.total }, (_, i) => i);
  return (
    <Shell
      stage="transcribe" kicker="02 · Transcriber" title="Transcript" state={t.state} data={data}
      actions={
        t.state === "done" && engine !== "webmcp" && (video.transcript?.aligned ?? 0) < 0.5 ? (
          <button className="btn sm primary" onClick={data.h.transcribe} title="Reuses the cached text; only measures word timings (about $0.02)">⏱ Measure timing</button>
        ) : t.state === "done" && !video.vision ? (
          <button className="btn sm primary" onClick={data.h.transcribe} title="Reuses the audio transcript; finds shot changes and labels every shot (about $0.04)">👁 Add vision</button>
        ) : (
          <RunStop state={t.state} job={t.job} onRun={data.h.transcribe} onStop={data.h.stop}
            runLabel={engine === "webmcp" ? "Prepare (no AI)" : "Transcribe"} rerunLabel={engine === "webmcp" ? "Re-prepare" : "Redo missing"} />
        )
      }
    >
      <div className="chunks" title={`${t.chunks.done}/${t.chunks.total} two-minute chunks`}>
        {cells.map((i) => <i key={i} className={i < t.chunks.done ? "on" : t.state === "running" && i < t.chunks.done + 6 ? "busy" : ""} />)}
      </div>
      {t.state === "running" && t.job ? (
        <>
          <Film value={t.job.progress} status="running" agent="transcribe" />
          <div className="gnode-meta"><span dir="auto">{t.job.stage}</span></div>
        </>
      ) : (
        <div className="gnode-meta">
          {video.transcript ? <span><b>{video.transcript.segments}</b> segments</span> : <span>{t.chunks.total} chunks to transcribe</span>}
          {video.transcript && (
            (video.transcript.aligned ?? 0) >= 0.5
              ? <span className="timing ok" title="Word times measured from the audio">⏱ {Math.round((video.transcript.aligned ?? 0) * 100)}% measured</span>
              : <span className="timing est" title="Times are the transcriber's estimates">⏱ estimated</span>
          )}
          {video.vision && <span className="timing ok" title={`Vision transcript by ${video.vision.model}`}>👁 {video.vision.shots} shots</span>}
          {t.state === "failed" && <span className="err">{t.job?.error}</span>}
        </div>
      )}
    </Shell>
  );
}

export const ENGINE_NAME: Record<Engine, string> = { classic: "LLM", hybrid: "Hybrid · LLM + Jev", jev: "Jev · System One", webmcp: "Browser agent · WebMCP" };
function EngineTag({ engine }: { engine: Engine }) {
  return <span className={`engine-tag ${engine}`}>{ENGINE_NAME[engine]}</span>;
}

function PlanNode({ data }: NodeProps<Node<NodeData>>) {
  const { plan, run, runs, engine } = data.p;
  return (
    <Shell
      stage="plan" kicker="04 · Planner" title="Clip plan" state={plan.state} data={data}
      actions={
        engine === "webmcp" && plan.state !== "running" ? (
          <span className="hint">{plan.state === "locked" ? "Needs a transcript" : "Waiting for your browser agent's submit_plan"}</span>
        ) : (
          <RunStop state={plan.state} job={plan.job} onRun={data.h.plan} onStop={data.h.stop} runLabel="Plan clips" rerunLabel="New take" />
        )
      }
    >
      {plan.state === "running" && plan.job ? (
        <>
          <Film value={plan.job.progress} status="running" agent="plan" />
          <div className="gnode-meta"><span>{plan.job.stage}</span></div>
        </>
      ) : run ? (
        <>
          <div className="mini-tl">
            {run.clips.map((c) => (
              <i key={c.id} style={{ left: `${(c.start / data.p.video.duration) * 100}%`, width: `${Math.max(((c.end - c.start) / data.p.video.duration) * 100, 1.2)}%` }} />
            ))}
          </div>
          <div className="gnode-meta">
            <span><b>{run.clips.length}</b> clips · take {runs.length - runs.indexOf(run)} of {runs.length}</span>
            <EngineTag engine={run.engine} />
          </div>
          {run.jev && <div className="gnode-meta"><span className="mono">{run.jev.stats.calls} decisions · {run.jev.stats.candidates} candidates</span></div>}
          {run.jev?.brief?.source === "llm" && <div className="gnode-meta"><span className="faint">brief: {run.jev.brief.window.length + run.jev.brief.opener.length + run.jev.brief.ending.length} questions from the outline</span></div>}
        </>
      ) : (
        <div className="gnode-meta"><span>{plan.state === "locked" ? "Needs a transcript" : "Reads your outline, history and comments"}</span></div>
      )}
      <div className="gnode-meta"><span className="faint">next take:</span><EngineTag engine={engine} /></div>
    </Shell>
  );
}

/** LLM node between the Outline and the Planner: compiles the outline into Jev's brief (Hybrid). */
function BriefNode({ data }: NodeProps<Node<NodeData>>) {
  const { brief: b, video, engine } = data.p;
  const info = video.brief;
  return (
    <Shell
      stage="brief" kicker="03 · LLM" title="Brief" state={b.state} data={data}
      actions={b.active ? <RunStop state={b.state} job={b.job?.agent === "brief" ? b.job : undefined} onRun={data.h.brief} onStop={data.h.stop} runLabel="Compile brief" rerunLabel="Recompile" /> : undefined}
    >
      {b.state === "running" && b.job ? (
        <>
          <Film value={b.job.agent === "brief" ? b.job.progress : 0.5} status="running" agent="brief" />
          <div className="gnode-meta"><span>{b.job.agent === "brief" ? b.job.stage : "compiling for the plan"}</span></div>
        </>
      ) : !b.active ? (
        <div className="gnode-meta"><span>Hybrid only. {engine === "classic" ? "The LLM planner reads the outline itself." : engine === "jev" ? "System One asks its fixed questions." : "Your browser agent reads the outline."}</span></div>
      ) : info ? (
        <>
          <div className="gnode-meta">
            <span><b>{info.questions}</b> Jev questions + tones, gates, edit guide</span>
          </div>
          <div className="gnode-meta">
            <span className={`timing ${info.fresh ? "ok" : "est"}`}>{info.fresh ? "✓ matches the outline" : "outline changed: recompiles on next take"}</span>
            <span className="mono">${info.cost.toFixed(3)}</span>
          </div>
        </>
      ) : (
        <div className="gnode-meta"><span>Writes Jev's questions from the outline, once per outline version</span></div>
      )}
    </Shell>
  );
}

/** Transcriber on the output: listens to and watches the finished clips. */
function WatchNode({ data }: NodeProps<Node<NodeData>>) {
  const { watch: w } = data.p;
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  return (
    <Shell
      stage="watch" kicker="09 · Transcriber" title="Clip transcript" state={w.state} data={data} reverse
      actions={<RunStop state={w.state} job={w.job?.agent === "watch" ? w.job : undefined} onRun={data.h.watch} onStop={data.h.stop} runLabel="Watch clips" rerunLabel="Re-watch" />}
    >
      {w.state === "running" && w.job ? (
        <>
          <Film value={w.job.agent === "watch" ? w.job.progress : 0.5} status="running" agent="transcribe" />
          <div className="gnode-meta"><span>{w.job.stage}</span></div>
        </>
      ) : w.clips.length ? (
        <div className="cut-rows">
          {w.clips.map((c) => (
            <div key={c.id} className={`cut-row ${c.watch?.fresh ? "done" : ""}`} title={c.watch?.audio?.text}>
              <span className="mono">{String(c.id).padStart(2, "0")}</span>
              <span className="grow mono faint">{c.watch?.fresh ? `🔊 ${pc(c.watch.metrics.script_match)} overlap · 👁 ${c.watch.metrics.cut_off ? `${c.watch.metrics.cut_off} cut off` : "framing ok"}` : "not watched"}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="gnode-meta"><span>Hears and sees the finished clips for the coach</span></div>
      )}
      {w.clips.length > 0 && <div className="gnode-meta"><span><b>{w.watched}</b>/{w.clips.length} finished clips watched</span></div>}
    </Shell>
  );
}

/** LLM node before the Jev coach (Hybrid): rules for Jev to rate clips on, and rewrites to choose from. */
function RubricNode({ data }: NodeProps<Node<NodeData>>) {
  const { rubric: r, coach } = data.p;
  const rb = r.rubric;
  return (
    <Shell
      stage="rubric" kicker="10 · LLM" title="Rubric" state={r.state} data={data} reverse
      extra={<Handle type="target" id="outline" position={Position.Bottom} className="port" />}
      actions={r.active ? <RunStop state={r.state} job={r.job?.agent === "rubric" ? r.job : undefined} onRun={data.h.rubric} onStop={data.h.stop} runLabel="Write rubric" rerunLabel="Rewrite" /> : undefined}
    >
      {r.state === "running" && r.job ? (
        <>
          <Film value={r.job.agent === "rubric" ? r.job.progress : 0.5} status="running" agent="brief" />
          <div className="gnode-meta"><span>{r.job.stage}</span></div>
        </>
      ) : !r.active ? (
        <div className="gnode-meta"><span>Hybrid only. {coach.by === "llm" ? "The LLM coach reads the evidence itself." : coach.by === "jev" ? "System One rates one rule per outline section." : "Needs OpenRouter."}</span></div>
      ) : rb && rb.source === "llm" ? (
        <>
          <div className="gnode-meta">
            <span><b>{rb.rules.length}</b> rules · <b>{rb.sections.reduce((n, s) => n + s.variants.length, 0)}</b> rewrites for {rb.sections.length} section{rb.sections.length === 1 ? "" : "s"}</span>
          </div>
          {rb.diagnosis && <div className="gnode-meta"><span className="faint" dir="auto">{rb.diagnosis.slice(0, 90)}{rb.diagnosis.length > 90 ? "…" : ""}</span></div>}
          <div className="gnode-meta"><span className={`timing ${rb.fresh ? "ok" : "est"}`}>{rb.fresh ? "✓ for the current outline" : "for an older outline"}</span><span className="mono">${rb.cost.toFixed(3)}</span></div>
        </>
      ) : (
        <div className="gnode-meta"><span>Writes the rules Jev checks every finished clip against, and rewrites for failing sections</span></div>
      )}
    </Shell>
  );
}

/** The coach after Clips: learns a better outline from the reviews and feeds it back into the Outline. */
function CoachNode({ data }: NodeProps<Node<NodeData>>) {
  const { coach: c } = data.p;
  const cur = c.current;
  const sc = c.scorecard && c.scorecard.outline_hash === cur?.hash ? c.scorecard : null;
  const weakest = sc ? [...sc.rules].sort((a, b) => a.followed - b.followed)[0] : null;
  return (
    <Shell
      stage="coach" kicker={`11 · ${c.by === "llm" ? "LLM" : c.by ? "Jev" : "Coach"}`} title="Outline coach" state={c.state} data={data} reverse outputs={false}
      extra={<Handle type="source" id="loop" position={Position.Bottom} className="port loop-port" />}
      actions={
        c.pending && c.state !== "running" ? (
          <>
            <button className="btn sm" onClick={() => data.h.select("coach")}>See diff</button>
            <button className="btn sm primary" onClick={() => data.h.applyProposal(c.pending!.id)}>✓ Apply to outline</button>
          </>
        ) : (
          <RunStop state={c.state} job={c.job} onRun={data.h.coach} onStop={data.h.stop} runLabel="Coach outline" rerunLabel="Propose again" />
        )
      }
    >
      {c.state === "running" && c.job ? (
        <>
          <Film value={c.job.progress} status="running" agent="coach" />
          <div className="gnode-meta"><span>{c.job.stage}</span></div>
        </>
      ) : (
        <>
          <div className="coach-score">
            <b>{cur?.mean ?? "–"}</b>
            <span>one-shot score of {cur?.label ?? "the outline"}<br />{cur ? `${cur.rated} reviewed of ${cur.takes} take${cur.takes === 1 ? "" : "s"}` : ""}</span>
          </div>
          {c.versions.length > 1 && (
            <div className="spark" title="One-shot score per outline version">
              {c.versions.map((v) => <i key={v.hash} className={`${v.hash === cur?.hash ? "on" : ""} ${v.mean === null ? "none" : ""}`} style={{ height: `${Math.max(8, v.mean ?? 8)}%` }} title={`${v.label} (${v.source}): ${v.mean ?? "not scored"}`} />)}
            </div>
          )}
          {weakest && !c.pending && (
            <div className="gnode-meta"><span>Least followed: <span dir="auto">{weakest.rule.slice(0, 60)}</span> <b className="mono">{Math.round(weakest.followed * 100)}%</b></span></div>
          )}
          <div className="gnode-meta">
            {c.pending ? <span><b>{c.pending.changes.length}</b> changes proposed{c.pending.mode && c.pending.mode !== "llm" ? " by Jev" : ""}: <span dir="auto">{c.pending.hypothesis.slice(0, 70)}{c.pending.hypothesis.length > 70 ? "…" : ""}</span></span>
              : <span className="faint">{c.state === "locked" ? "Plan and review a take first" : "Learns from your keeps, drops, nudges and comments"}</span>}
          </div>
        </>
      )}
    </Shell>
  );
}

/** Between the Planner and the Editor: Jev picks each segment's camera move and each gap's transition. */
function DesignNode({ data }: NodeProps<Node<NodeData>>) {
  const { design: d, run } = data.p;
  const clips = run?.design ? Object.values(run.design.clips) : [];
  const moves = new Map<string, number>();
  for (const c of clips) {
    for (const z of c.zooms) moves.set(z.zoom, (moves.get(z.zoom) ?? 0) + 1);
    for (const t of c.transitions) moves.set(t.transition, (moves.get(t.transition) ?? 0) + 1);
  }
  const top = [...moves].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return (
    <Shell
      stage="design" kicker="05 · Designer" title="Edit design" state={d.state} data={data}
      actions={d.by === "jev" ? <RunStop state={d.state} job={d.job?.agent === "design" ? d.job : undefined} onRun={data.h.design} onStop={data.h.stop} runLabel="Design edits" rerunLabel="Redesign" /> : undefined}
    >
      {d.state === "running" && d.job ? (
        <>
          <Film value={d.job.agent === "plan" ? Math.max(0, (d.job.progress - 0.92) / 0.08) : d.job.progress} status="running" agent="design" />
          <div className="gnode-meta"><span>{d.job.stage}</span></div>
        </>
      ) : !run ? (
        <div className="gnode-meta"><span>Camera moves, transitions and flashbacks for each clip</span></div>
      ) : d.by !== "jev" ? (
        <div className="gnode-meta"><span>{d.by === "llm" ? "The LLM planner wrote this take's edits" : "Your browser agent wrote this take's edits"}</span></div>
      ) : run.design ? (
        <>
          <div className="design-chips">{top.map(([k, n]) => <span key={k}>{k.replace("_", " ")} <b>{n}</b></span>)}</div>
          <div className="gnode-meta">
            <span><b>{d.decisions}</b> Jev decisions</span>
            <span className={`engine-tag ${run.design.mode}`}>{run.design.guide === "llm" ? "guide from outline" : "standard guide"}</span>
          </div>
          {run.design.mode === "hybrid" && <div className="gnode-meta"><span className="faint">titles and emphasis by the LLM</span></div>}
        </>
      ) : (
        <div className="gnode-meta"><span>Automatic edit only. Let Jev design it.</span></div>
      )}
    </Shell>
  );
}

function ReviewNode({ data }: NodeProps<Node<NodeData>>) {
  const { review, run, gate } = data.p;
  return (
    <Shell
      stage="review" kicker="06 · You" title="Review gate" state={review.state} data={data}
      actions={
        review.state === "waiting" ? (
          <>
            <button className="btn sm" onClick={() => data.h.select("review")}>Review</button>
            <button className="btn sm primary" onClick={data.h.approve}>✓ Approve {review.kept}</button>
          </>
        ) : undefined
      }
    >
      {run ? (
        <>
          <div className="pills">
            {run.clips.map((c) => {
              const s = run.review.clips[c.id]?.status;
              return <span key={c.id} className={`pill ${s ?? ""}`} title={c.title}>{c.id}</span>;
            })}
          </div>
          <div className="gnode-meta">
            <span>{review.kept} kept{review.dropped ? ` · ${review.dropped} dropped` : ""}</span>
            {review.comments > 0 && <span>💬 {review.comments}</span>}
            {!gate && <span className="faint">gate off</span>}
          </div>
        </>
      ) : (
        <div className="gnode-meta"><span>{gate ? "Nothing is cut until you approve" : "Gate off: plans go straight to cutting"}</span></div>
      )}
    </Shell>
  );
}

function CutNode({ data }: NodeProps<Node<NodeData>>) {
  const { cut, run, engine } = data.p;
  const o = data.h.cutOpts;
  return (
    <Shell
      stage="cut" kicker="07 · Editor" title="Cut clips" state={cut.state} data={data}
      actions={<RunStop state={cut.state} job={cut.job} onRun={data.h.cut} onStop={data.h.stop} runLabel={`Cut ${cut.total || ""}`} rerunLabel="Re-cut" />}
    >
      <div className="toggles nodrag" onClick={(e) => e.stopPropagation()}>
        <label><input type="checkbox" checked={o.subs} onChange={(e) => data.h.setCutOpts({ ...o, subs: e.target.checked })} /> captions</label>
        <label><input type="checkbox" checked={o.vertical} onChange={(e) => data.h.setCutOpts({ ...o, vertical: e.target.checked })} /> 9:16</label>
      </div>
      {run && (
        <div className="cut-rows">
          {run.clips.filter((c) => run.review.clips[c.id]?.status !== "drop").map((c) => (
            <div key={c.id} className={`cut-row ${c.file ? "done" : ""} ${cut.current === c.id ? "busy" : ""}`}>
              <span className="mono">{String(c.id).padStart(2, "0")}</span>
              <span className="grow" dir="auto">{c.title}</span>
              <span className="mono">{cut.current === c.id ? "…" : c.file ? "✓" : "–"}</span>
            </div>
          ))}
        </div>
      )}
      {cut.state === "running" && cut.job && <Film value={cut.job.progress} status="running" agent="extract" />}
      {(engine === "jev" || engine === "hybrid") && <div className="gnode-meta"><span className="faint">Jev pre-flight checks edges first</span></div>}
    </Shell>
  );
}

function ClipsNode({ data }: NodeProps<Node<NodeData>>) {
  const { clips } = data.p;
  return (
    <Shell stage="clips" kicker="08 · Output" title="Clips" state={clips.state} data={data} outputs={false}
      extra={<Handle type="source" id="fb" position={Position.Bottom} className="port" />}>
      {clips.files.length ? (
        <div className="reel-grid">
          {clips.files.slice(0, 6).map((c) => (
            <video key={c.id} src={fileUrl(c.file) + "#t=1"} muted preload="metadata" title={c.title} />
          ))}
        </div>
      ) : (
        <div className="gnode-meta"><span>Finished clips land here</span></div>
      )}
      {clips.files.length > 0 && <div className="gnode-meta"><span><b>{clips.files.length}</b> ready to post</span></div>}
    </Shell>
  );
}

const nodeTypes = {
  source: SourceNode, outline: OutlineNode, transcribe: TranscribeNode, brief: BriefNode, watch: WatchNode, rubric: RubricNode, plan: PlanNode, design: DesignNode, review: ReviewNode, cut: CutNode, clips: ClipsNode, coach: CoachNode,
};

// ── Canvas ─────────────────────────────────────────────────────────

const ORDER: StageKey[] = ["source", "outline", "transcribe", "brief", "plan", "design", "review", "cut", "clips", "watch", "rubric", "coach"];

type Wire = { from: StageKey; to: StageKey; sh?: string; th?: string; kind?: "config" | "loop"; label?: string };
// The pipeline, the outline's control wire through the Brief, and the coach's feedback loop.
const wiresFor = (p: Pipeline): Wire[] => [
  { from: "source", to: "transcribe" }, { from: "transcribe", to: "plan" },
  { from: "outline", to: "brief", kind: "config" },
  // Outside Hybrid the brief isn't compiled; the outline reaches the Planner unchanged.
  { from: "brief", to: "plan", kind: p.brief.active ? undefined : "config" },
  { from: "plan", to: "design" }, { from: "design", to: "review" }, { from: "review", to: "cut" }, { from: "cut", to: "clips" },
  // Feedback row: finished clips → clip transcript → rubric → coach → back into the outline.
  { from: "clips", to: "watch", sh: "fb" },
  { from: "watch", to: "rubric", kind: p.rubric.active ? undefined : "config" },
  { from: "rubric", to: "coach", kind: p.rubric.active ? undefined : "config" },
  { from: "outline", to: "rubric", sh: "tocoach", th: "outline", kind: "config" },
  { from: "coach", to: "outline", sh: "loop", th: "loop", kind: "loop", label: "revised outline" },
];

function edgeFor(w: Wire, p: Pipeline): Edge {
  const s = (k: StageKey) => (k === "source" ? "done" : (p as any)[k].state as NodeState);
  const base: Edge = {
    id: `${w.from}-${w.to}`, source: w.from, target: w.to,
    ...(w.sh ? { sourceHandle: w.sh } : {}), ...(w.th ? { targetHandle: w.th } : {}),
    ...(w.sh || w.th ? { type: "smoothstep" } : {}), ...(w.label ? { label: w.label } : {}),
  };
  if (w.kind === "loop") {
    const hot = s("coach") === "waiting" || s("coach") === "running";
    return { ...base, animated: hot, className: `wire loop ${hot ? "flowing" : ""}` };
  }
  if (w.kind === "config") return { ...base, className: `wire config ${s(w.to) === "running" ? "flowing" : ""} w-${AGENT[w.to]}`, animated: s(w.to) === "running" };
  const target = s(w.to);
  const upstreamDone = s(w.from) === "done";
  const cls = target === "running" ? "flowing" : upstreamDone && (target === "done" || target === "waiting") ? "done" : upstreamDone ? "armed" : "idle";
  return { ...base, animated: target === "running", className: `wire ${cls} w-${AGENT[w.to]}` };
}

function Canvas({ p, h, selected, next, fitKey }: { p: Pipeline; h: FlowHandlers; selected: StageKey | null; next: StageKey; fitKey: string }) {
  const { fitView } = useReactFlow();
  // Nodes live in state so React Flow's measured sizes stick; fitView ignores unmeasured nodes.
  const [nodes, setNodes] = useState<Node<NodeData>[]>(() =>
    ORDER.map((k) => ({ id: k, type: k, position: LAYOUT[k], data: { p, h, selected, next } })),
  );
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { p, h, selected, next }, selected: selected === n.id })));
  }, [p, h, selected, next]);
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns) as Node<NodeData>[]),
    [],
  );

  // Re-frame when switching projects or when the dock/panel resize the stage (after their slide transition).
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.1 }), 320);
    return () => clearTimeout(t);
  }, [p.video.name, fitKey, fitView]);
  useEffect(() => {
    const onResize = () => fitView({ padding: 0.1 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitView]);

  const edges = useMemo(() => wiresFor(p).map((w) => edgeFor(w, p)), [p]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      nodesConnectable={false}
      elementsSelectable={false}
      colorMode="dark"
      fitView
      fitViewOptions={{ padding: 0.1 }}
      minZoom={0.3}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--line-2)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

export function PipelineCanvas(props: { p: Pipeline; h: FlowHandlers; selected: StageKey | null; next: StageKey; fitKey: string }) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
