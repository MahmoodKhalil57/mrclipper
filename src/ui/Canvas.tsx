// The workflow canvas: one column per phase, thirteen nodes, one loop back into the Outline.
// Steps inside a phase stack top to bottom (Make runs Pick → Design → Render → Check downwards).
// Every node has the same anatomy: phase · who does the work, title, state, a few facts, why it's in
// that state, and one action. States and facts come from the server (workflow.ts).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, useReactFlow,
  type Edge, type Node, type NodeChange, type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { fileUrl, thumbUrl, type Job, type Library, type NodeId, type Run, type WfNode, type Workflow } from "./api";
import { Film, StateChip, UP_TO_DATE } from "./Common";
import { tc } from "./util";

export const PHASES = ["Inputs", "Understand", "Brief", "Make", "Review", "Learn"] as const;
export const WHO_LABEL: Record<WfNode["who"], string> = { you: "You", transcriber: "Transcriber", llm: "LLM writes", jev: "Jev judges", code: "Code" };
export const NODE_TITLE: Record<NodeId, string> = {
  source: "Source video", outline: "Outline", refclip: "Reference clip", guide: "Copy guide",
  transcript: "Transcript", refstyle: "Reference style", brief: "Brief",
  pick: "Pick clips", design: "Design edits", render: "Render", check: "Check",
  review: "Review", coach: "Coach",
};
/** The one action each node offers: its first run, and a run after an input changed (inputs and Review open their panel). */
const ACTION: Partial<Record<NodeId, [first: string, outOfDate: string]>> = {
  transcript: ["Transcribe", "Redo missing"], refstyle: ["Analyse", "Re-analyse"], brief: ["Write brief", "Rewrite"],
  pick: ["Pick clips", "New take"], design: ["Design", "Redesign"], render: ["Render", "Re-render"], check: ["Check", "Re-check"],
  coach: ["Coach", "Coach again"],
};

export type CanvasHandlers = {
  open: (id: NodeId) => void;
  step: (id: NodeId) => void;
  stop: (jobId: string) => void;
  applyProposal: (id: string) => void;
};

const X = [0, 330, 660, 990, 1320, 1650];
/** The bottom row: the Outline, Check, Review and Coach, so the loop runs along the bottom back into the Outline. */
const LOOP_Y = 820;
const LAYOUT: Record<NodeId, { x: number; y: number }> = {
  source: { x: X[0], y: 0 }, refclip: { x: X[0], y: 310 }, guide: { x: X[0], y: 600 }, outline: { x: X[0], y: LOOP_Y },
  transcript: { x: X[1], y: 0 }, refstyle: { x: X[1], y: 455 },
  brief: { x: X[2], y: 590 },
  pick: { x: X[3], y: 0 }, design: { x: X[3], y: 275 }, render: { x: X[3], y: 550 }, check: { x: X[3], y: LOOP_Y },
  review: { x: X[4], y: LOOP_Y },
  coach: { x: X[5], y: LOOP_Y },
};
/** Which ports each node has: inputs on the left (or top, inside Make), outputs on the right (or bottom). */
const PORTS: Record<NodeId, { left?: true; top?: true; right?: true; bottom?: "down" | "loop"; loopIn?: true }> = {
  source: { right: true }, refclip: { right: true }, guide: { right: true }, outline: { right: true, loopIn: true },
  transcript: { left: true, right: true }, refstyle: { left: true, right: true }, brief: { left: true, right: true },
  pick: { left: true, bottom: "down" }, design: { top: true, bottom: "down" }, render: { top: true, bottom: "down" },
  check: { top: true, left: true, right: true }, review: { left: true, right: true }, coach: { left: true, bottom: "loop" },
};
const ORDER = Object.keys(LAYOUT) as NodeId[];

type Wire = { from: NodeId; to: NodeId; kind?: "config" | "loop"; sh?: string; th?: string; label?: string; offset?: number };
const WIRES: Wire[] = [
  { from: "source", to: "transcript" },
  { from: "refclip", to: "refstyle" },
  { from: "guide", to: "refstyle", kind: "config" },
  { from: "outline", to: "brief", kind: "config" },
  { from: "transcript", to: "brief" },
  { from: "refstyle", to: "brief" },
  { from: "transcript", to: "pick" },
  { from: "brief", to: "pick" },
  { from: "pick", to: "design", sh: "down", th: "up" },
  { from: "design", to: "render", sh: "down", th: "up" },
  { from: "render", to: "check", sh: "down", th: "up" },
  { from: "brief", to: "check", kind: "config" },
  { from: "check", to: "review" },
  { from: "review", to: "coach" },
  { from: "coach", to: "outline", kind: "loop", sh: "loop", th: "loop", label: "next outline version", offset: 44 },
];

type NodeData = {
  node: WfNode; job?: Job; wf: Workflow; run: Run | null; lib: Library;
  selected: boolean; isNext: boolean; h: CanvasHandlers;
};
type PhaseData = { n: number; name: string; width: number };

function StepButton({ d }: { d: NodeData }) {
  const { node, job, h } = d;
  if (node.state === "running" && job?.status === "running") return <button className="btn sm danger" onClick={() => h.stop(job.id)}>■ Stop</button>;
  const labels = ACTION[node.id];
  if (!labels) return <button className="btn sm" onClick={() => h.open(node.id)}>{node.id === "review" ? (node.state === "waiting" ? "Review clips" : "Open") : node.state === "empty" || node.state === "optional" ? "Add" : "Edit"}</button>;
  // Idempotent: a step that's up to date with its inputs would only give the same result again.
  if (node.state === "done" || node.state === "waiting") return <button className="btn sm up-to-date" disabled title={UP_TO_DATE}>✓ Up to date</button>;
  const primary = node.state === "ready" || node.state === "stale" || node.state === "failed" || node.state === "stopped";
  return (
    <button className={`btn sm ${primary ? "primary" : ""}`} disabled={node.state === "locked" || node.state === "optional"} onClick={() => h.step(node.id)}>
      {node.state === "stale" ? `▶ ${labels[1]}` : `▶ ${labels[0]}`}
    </button>
  );
}

/** A node-specific picture above the facts. */
function Media({ d }: { d: NodeData }) {
  const { node, wf, run, lib } = d;
  if (node.id === "source") {
    const v = lib.videos.find((x) => x.name === wf.video);
    return v ? <div className="thumb" style={{ backgroundImage: `url("${thumbUrl(v.name, v.duration * 0.18)}")` }}><span className="mono">{tc(v.duration)}</span></div> : null;
  }
  if (node.id === "refclip" && lib.reference) return <div className="ref-mini"><video src={fileUrl(lib.reference.file) + "#t=1"} muted preload="metadata" /></div>;
  if (node.id === "pick" && run) {
    const dur = lib.videos.find((x) => x.name === wf.video)?.duration || 1;
    return (
      <div className="mini-tl">
        {run.clips.map((c) => <i key={c.id} style={{ left: `${(c.start / dur) * 100}%`, width: `${Math.max(((c.end - c.start) / dur) * 100, 1.2)}%` }} />)}
      </div>
    );
  }
  if (node.id === "review" && run && node.state !== "locked") {
    return (
      <div className="pills">
        {run.clips.map((c) => {
          const s = run.review.clips[c.id]?.status ?? (run.review.clips[c.id]?.rating === 1 ? "keep" : run.review.clips[c.id]?.rating === -1 ? "drop" : undefined);
          return <span key={c.id} className={`pill ${s ?? ""}`} title={c.title}>{c.id}</span>;
        })}
      </div>
    );
  }
  if (node.id === "guide" && node.state === "done") return null;
  return null;
}

function WorkflowNode({ data: d }: NodeProps<Node<NodeData>>) {
  const { node, job, h, lib } = d;
  const pending = node.id === "coach" ? lib.outlines?.pending : null;
  const io = PORTS[node.id];
  return (
    <div className={`gnode who-${node.who} s-${node.state} ${d.selected ? "picked" : ""} ${d.isNext ? "is-next" : ""}`} onClick={() => h.open(node.id)}>
      {io.left && <Handle type="target" position={Position.Left} className="port" />}
      {io.top && <Handle type="target" id="up" position={Position.Top} className="port" />}
      {io.loopIn && <Handle type="target" id="loop" position={Position.Bottom} className="port loop-port" />}
      <div className="gnode-head">
        <div style={{ minWidth: 0 }}>
          <div className="gnode-kicker">{node.phase} · {PHASES[node.phase - 1]} <span className="who-tag">{WHO_LABEL[node.who]}</span></div>
          <div className="gnode-title">{NODE_TITLE[node.id]}</div>
        </div>
        <StateChip state={node.state} />
      </div>
      <div className="gnode-body">
        <Media d={d} />
        {node.facts.length > 0 && (
          <div className="facts">
            {node.facts.map(([k, v]) => <div key={k}><span>{k}</span><b dir="auto">{v}</b></div>)}
          </div>
        )}
        {node.state === "running" && job ? (
          <>
            <Film value={job.progress} status="running" agent={`who-${node.who}`} />
            <div className="gnode-reason" dir="auto">{job.stage}</div>
          </>
        ) : node.reason ? (
          <div className={`gnode-reason ${node.state === "stale" ? "stale" : node.state === "failed" ? "failed" : ""}`} dir="auto">{node.reason}</div>
        ) : null}
      </div>
      <div className="gnode-actions nodrag" onClick={(e) => e.stopPropagation()}>
        {node.cost ? <span className="mono faint grow">${node.cost.toFixed(3)}</span> : <span className="grow" />}
        {pending && node.state === "waiting" ? (
          <>
            <button className="btn sm" onClick={() => h.open("coach")}>See diff</button>
            <button className="btn sm primary" onClick={() => h.applyProposal(pending.id)}>✓ Apply</button>
          </>
        ) : <StepButton d={d} />}
      </div>
      {io.right && <Handle type="source" position={Position.Right} className="port" />}
      {io.bottom && <Handle type="source" id={io.bottom} position={Position.Bottom} className={`port ${io.bottom === "loop" ? "loop-port" : ""}`} />}
      {d.isNext && node.state !== "waiting" && <div className="next-flag">next</div>}
    </div>
  );
}

function PhaseHeader({ data }: NodeProps<Node<PhaseData>>) {
  return (
    <div className="phase-head" style={{ width: data.width }}>
      <span className="phase-n">{data.n}</span>
      <span className="phase-name">{data.name}</span>
    </div>
  );
}

const nodeTypes = { step: WorkflowNode, phase: PhaseHeader };

function edgeFor(w: Wire, wf: Workflow): Edge {
  const s = (id: NodeId) => wf.nodes[id].state;
  const base: Edge = {
    id: `${w.from}-${w.to}${w.sh ? `-${w.sh}` : ""}`, source: w.from, target: w.to,
    ...(w.sh ? { sourceHandle: w.sh } : {}), ...(w.th ? { targetHandle: w.th } : {}),
    ...(w.sh || w.th ? { type: "smoothstep", pathOptions: { offset: w.offset ?? 30, borderRadius: 18 } } : {}),
    ...(w.label ? { label: w.label } : {}),
  };
  const to = s(w.to);
  const from = s(w.from);
  if (w.kind === "loop") {
    const hot = s("coach") === "waiting" || s("coach") === "running";
    return { ...base, animated: hot, className: `wire loop ${hot ? "flowing" : ""}` };
  }
  const cls = to === "running" ? "flowing" : to === "stale" ? "stale" : from === "done" && (to === "done" || to === "waiting") ? "done" : from === "done" || from === "optional" ? "armed" : "idle";
  return { ...base, animated: to === "running", className: `wire ${cls} ${w.kind === "config" ? "config" : ""} w-${wf.nodes[w.to].who}` };
}

function Canvas(props: { wf: Workflow; lib: Library; jobs: Job[]; run: Run | null; selected: NodeId | null; h: CanvasHandlers; fitKey: string }) {
  const { wf, lib, jobs, run, selected, h, fitKey } = props;
  const { fitView } = useReactFlow();
  const build = useCallback((): Node<any>[] => {
    const heads: Node<PhaseData>[] = PHASES.map((name, i) => ({
      id: `phase-${i + 1}`, type: "phase", position: { x: X[i], y: -86 }, draggable: false, selectable: false,
      data: { n: i + 1, name, width: 272 },
    }));
    const steps: Node<NodeData>[] = ORDER.map((id) => ({
      id, type: "step", position: LAYOUT[id],
      data: {
        node: wf.nodes[id], job: jobs.find((j) => j.id === wf.nodes[id].job), wf, run, lib,
        selected: selected === id, isNext: wf.next.node === id && !wf.run, h,
      },
    }));
    return [...heads, ...steps];
  }, [wf, lib, jobs, run, selected, h]);
  // Nodes live in state so React Flow's measured sizes stick (fitView ignores unmeasured nodes).
  const [nodes, setNodes] = useState<Node<any>[]>(build);
  useEffect(() => {
    const fresh = build();
    setNodes((ns) => fresh.map((n) => ({ ...(ns.find((x) => x.id === n.id) ?? {}), ...n, position: ns.find((x) => x.id === n.id)?.position ?? n.position })));
  }, [build]);
  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.06 }), 320);
    return () => clearTimeout(t);
  }, [wf.video, fitKey, fitView]);
  useEffect(() => {
    const onResize = () => fitView({ padding: 0.06 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitView]);
  const edges = useMemo(() => WIRES.map((w) => edgeFor(w, wf)), [wf]);
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
      nodesConnectable={false} elementsSelectable={false} colorMode="dark"
      fitView fitViewOptions={{ padding: 0.06 }} minZoom={0.25} maxZoom={1.6} proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--line-2)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

export function WorkflowCanvas(props: Parameters<typeof Canvas>[0]) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
