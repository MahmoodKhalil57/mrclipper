// Pieces several panels share: score bars and odds, the edit timeline, shot strips, diffs, the brief.
import { useEffect, useMemo, useState } from "react";
import { actions, fileUrl, type Brief, type ClipEdit, type EdgeCheck, type Job, type Library, type NodeId, type PickScores, type Run, type Scorecard, type Shot, type StepArgs, type Video, type Workflow } from "../api";
import { tc } from "../util";

export type PanelProps = {
  wf: Workflow; lib: Library; jobs: Job[]; run: Run | null; video: Video;
  refresh: () => void;
  ask: (text: string) => void;
  stop: (id: string) => void;
  toast: (msg: string, kind?: "err" | "ok") => void;
  step: (id: NodeId, args?: StepArgs) => void;
  selectTake: (id: string | null) => void;
};

/** The job currently attached to a node (running, or the last one). */
export const nodeJob = (p: PanelProps, id: NodeId) => p.jobs.find((j) => j.id === p.wf.nodes[id].job);

/** Run an action, toast its result, refresh the workspace. */
export function useGuard(p: Pick<PanelProps, "refresh" | "toast">) {
  return async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) p.toast(ok);
      p.refresh();
    } catch (e) {
      p.toast((e as Error).message, "err");
    }
  };
}

export function Bar({ v, warn = 0.5 }: { v: number; warn?: number }) {
  return <span className={`bar ${v < warn ? "low" : ""}`}><i style={{ width: `${Math.round(v * 100)}%` }} /></span>;
}

export function Odds({ options, chosen }: { options: Record<string, number>; chosen: string }) {
  const top = Object.entries(options).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <span className="odds">
      {top.map(([k, v]) => <span key={k} className={k === chosen ? "on" : ""}>{k.replace(/_/g, " ")} {Math.round(v * 100)}%</span>)}
    </span>
  );
}

// ── Vision helpers ───────────────────────────────────────────────────

export const KIND_LABEL: Record<string, string> = {
  host_closeup: "Host close-up", host_wide: "Host wide", broll_footage: "Footage", archival_photo: "Archive photo",
  map: "Map", graphic: "Graphic", text_card: "Text card", animation: "Animation", other: "Other",
};

/** The vision transcript for a video, loaded once per video (and again when its shot count changes). */
export function useShots(video: string, shotCount: number | undefined) {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    if (!shotCount) return setShots([]);
    actions.vision(video).then((v) => setShots(v.shots ?? [])).catch(() => setShots([]));
  }, [video, shotCount]);
  return shots;
}

/** Would a centred 9:16 crop keep the main subject? (It keeps the middle 31.6% of a 16:9 frame.) */
export const cropSafe = (x?: number) => x === undefined || Math.abs(x - 0.5) <= 0.158;

export function ShotStrip({ shots, start, end }: { shots: Shot[]; start: number; end: number }) {
  const inClip = shots.filter((s) => s.end > start && s.start < end && !s.cont);
  if (!inClip.length) return null;
  return (
    <div className="shotstrip">
      <div className="shotstrip-row">
        {inClip.slice(0, 10).map((s) => (
          <span key={s.id} className={`shot-thumb ${cropSafe(s.subject_x) ? "" : "unsafe"}`}
            title={`${tc(s.start, true)} ${KIND_LABEL[s.kind ?? ""] ?? s.kind ?? ""}: ${s.desc ?? ""}${s.text ? ` | ${s.text}` : ""}`}>
            <img src={fileUrl(s.frame)} alt="" loading="lazy" />
          </span>
        ))}
        {inClip.length > 10 && <span className="faint mono">+{inClip.length - 10}</span>}
      </div>
    </div>
  );
}

// ── The edit ─────────────────────────────────────────────────────────

const TRANSITION_GLYPH: Record<string, string> = { cut: "|", crossfade: "◐", dip_black: "●", slide: "⇠", zoom: "⊕", whip: "≋", flash: "✦", iris: "◎", blur: "≈" };
const ZOOM_LABEL: Record<string, string> = { punch_in: "punch-in", slow_push: "slow push", ken_burns: "Ken Burns", zoom_out: "pull back", drift: "drift" };

/** The clip's edit: parts in play order, sized by duration, with the transitions between them. */
export function EditTimeline({ edit, onToggle }: { edit: ClipEdit; onToggle?: (on: boolean) => void }) {
  const on = edit.enabled !== false;
  const durs = edit.segments.map((s) => (s.end - s.start) / (s.speed ?? 1));
  const total = durs.reduce((a, b) => a + b, 0);
  const coldOpen = edit.segments.some((s, i) => i > 0 && s.start < edit.segments[i - 1].start);
  return (
    <div className={`edl ${on ? "" : "off"}`}>
      <div className="edl-head">
        <span className="label">Edit</span>
        <span className="hint grow">
          {edit.segments.length} part{edit.segments.length > 1 ? "s" : ""} · {total.toFixed(1)}s{coldOpen ? " · cold open" : ""}
        </span>
        {onToggle && (
          <label className="edl-toggle" title="Off = render the plain range with simple captions">
            <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /> creative edit
          </label>
        )}
      </div>
      {edit.title && <div className="edl-title ar" dir="auto">▣ {edit.title}</div>}
      <div className="edl-track">
        {edit.segments.map((s, i) => (
          <div key={i} className="edl-piece" style={{ flexGrow: durs[i] }}>
            {i > 0 && <span className={`edl-tr t-${edit.transitions[i - 1]}`} title={edit.transitions[i - 1]}>{TRANSITION_GLYPH[edit.transitions[i - 1]] ?? "|"}</span>}
            <div className={`edl-seg r-${s.role ?? "none"}`} title={`${tc(s.start, true)}–${tc(s.end, true)}${s.speed && s.speed !== 1 ? ` at ${s.speed}×` : ""}`}>
              <b>{i + 1}</b>
              <span>{s.role ?? tc(s.start)}</span>
              {s.zoom && s.zoom !== "none" && <i>{ZOOM_LABEL[s.zoom] ?? s.zoom}</i>}
              {s.look && s.look !== "none" && <i>{s.look === "bw" ? "black & white" : "sepia"}</i>}
            </div>
          </div>
        ))}
      </div>
      {edit.emphasis?.length ? <div className="edl-emph">{edit.emphasis.map((w) => <span key={w} className="ar" dir="auto">{w}</span>)}</div> : null}
    </div>
  );
}

// ── Scores ───────────────────────────────────────────────────────────

/** Why Jev picked a clip: every brief question's answer, tone, and the adjustments. */
export function PickBreakdown({ s }: { s: PickScores }) {
  return (
    <div className="jev-box">
      <div className="jev-head">
        <span className="engine-tag jev">Pick</span>
        <b>{Math.round(s.overall * 100)}</b><span className="faint">overall</span>
        <span className="grow" />
        <span className="tone">{s.tone.key.replace(/_/g, " ")} {Math.round(s.tone.p * 100)}%</span>
      </div>
      <div className="scores">
        {(s.rows ?? []).map((r) => <div key={r.key} className="score"><span dir="auto">{r.label}</span><Bar v={r.value} /><span className="mono">{Math.round(r.value * 100)}</span></div>)}
        {s.visual !== undefined && <div className="score"><span>Visuals</span><Bar v={s.visual} /><span className="mono">{Math.round(s.visual * 100)}</span></div>}
        {s.vertical !== undefined && <div className="score"><span>9:16-safe</span><Bar v={s.vertical} /><span className="mono">{Math.round(s.vertical * 100)}</span></div>}
        {s.direction !== undefined && <div className="score"><span>Your direction</span><Bar v={s.direction} /><span className="mono">{Math.round(s.direction * 100)}</span></div>}
        {s.against !== undefined && s.against > 0.3 && <div className="score warn"><span>Against feedback</span><Bar v={s.against} warn={2} /><span className="mono">{Math.round(s.against * 100)}</span></div>}
      </div>
      {s.repeat && <div className="hint">Overlaps a moment from an earlier take (scored down 30%).</div>}
    </div>
  );
}

export function EdgeQa({ q, clip, apply }: { q: EdgeCheck; clip: { start: number; end: number }; apply: (patch: { start?: number; end?: number }) => void }) {
  const stale = Math.abs(q.start - clip.start) > 0.05 || Math.abs(q.end - clip.end) > 0.05;
  if (stale) return <div className="qa stale hint">Edges changed since the last check.</div>;
  return (
    <div className="qa">
      <div className="qa-row">
        <span className={q.start_clean < 0.5 ? "warn" : "ok"}>In: {q.start_clean < 0.5 ? "may be mid-thought" : "clean"} {Math.round(q.start_clean * 100)}%</span>
        <span className={q.end_clean < 0.5 ? "warn" : "ok"}>Out: {q.end_clean < 0.5 ? "may cut off" : "clean"} {Math.round(q.end_clean * 100)}%</span>
      </div>
      {q.suggest_start && (
        <div className="suggest">
          <span>Start at <b className="mono">{tc(q.suggest_start.t, true)}</b> <span className="faint">({Math.round(q.suggest_start.p * 100)}%)</span></span>
          <span className="ar grow" dir="rtl">{q.suggest_start.line}</span>
          <button className="btn xs" onClick={() => apply({ start: q.suggest_start!.t })}>Apply</button>
        </div>
      )}
      {q.suggest_end && (
        <div className="suggest">
          <span>End at <b className="mono">{tc(q.suggest_end.t, true)}</b> <span className="faint">({Math.round(q.suggest_end.p * 100)}%)</span></span>
          <span className="ar grow" dir="rtl">{q.suggest_end.line}</span>
          <button className="btn xs" onClick={() => apply({ end: q.suggest_end!.t })}>Apply</button>
        </div>
      )}
    </div>
  );
}

export function Nudge({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="nudge">
      <span className="label">{label}</span>
      <button onClick={() => onChange(value - 2)}>−2</button>
      <button onClick={() => onChange(value - 0.5)}>−½</button>
      <b className="mono">{tc(value, true)}</b>
      <button onClick={() => onChange(value + 0.5)}>+½</button>
      <button onClick={() => onChange(value + 2)}>+2</button>
    </div>
  );
}

/** Jev's judgement across reviewed takes: which check rules the clips follow, kept vs dropped, and its rewrite choices. */
export function ScorecardView({ sc }: { sc: Scorecard }) {
  const pc = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}`);
  return (
    <div className="card stack-sm">
      <div className="row">
        <b className="grow">Jev scorecard</b>
        <span className="mono faint">{sc.calls} decisions · ${sc.cost.toFixed(3)}</span>
      </div>
      {sc.diagnosis && <div className="hypo" dir="auto">{sc.diagnosis}</div>}
      {sc.rules.length > 0 && (
        <>
          <div className="hint">How often reviewed clips follow each check rule, and on the clips you kept vs dropped. A rule kept clips follow and dropped ones don't is working.</div>
          <div className="sc-head"><span>Rule</span><span>followed</span><span>kept</span><span>dropped</span></div>
          {[...sc.rules].sort((a, b) => a.followed - b.followed).map((r) => (
            <div key={r.key} className="sc-row">
              <span dir="auto" title={r.section}>{r.rule}</span>
              <span className="sc-bar"><Bar v={r.followed} /><span className="mono">{pc(r.followed)}</span></span>
              <span className="mono">{pc(r.good)}</span>
              <span className="mono">{pc(r.bad)}</span>
            </div>
          ))}
        </>
      )}
      {sc.decisions.length > 0 && (
        <>
          <div className="label">Jev's choices between the rewrites</div>
          {sc.decisions.map((d) => (
            <div key={d.section} className="design-row">
              <b>{d.section}</b>
              <span className="grow" dir="auto">{d.applied ? d.summary : "kept as it is"}</span>
              <Odds options={d.options} chosen={d.chosen} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ── Diffs ────────────────────────────────────────────────────────────

type DiffRow = { t: " " | "-" | "+"; s: string };
function diffLines(x: string[], y: string[]): DiffRow[] {
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ t: " ", s: x[i] }), i++, j++);
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: "-", s: x[i++] });
    else out.push({ t: "+", s: y[j++] });
  }
  while (i < n) out.push({ t: "-", s: x[i++] });
  while (j < m) out.push({ t: "+", s: y[j++] });
  return out;
}

/** Changed lines with two lines of context; long unchanged stretches fold away. */
export function LineDiff({ a, b }: { a: string; b: string }) {
  const rows = useMemo(() => diffLines(a.trim().split(/\r?\n/), b.trim().split(/\r?\n/)), [a, b]);
  const near = rows.map((_, i) => rows.slice(Math.max(0, i - 2), i + 3).some((r) => r.t !== " "));
  const out: React.ReactNode[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) {
      out.push(<div key={i} className={`dl d${rows[i].t === "+" ? "add" : rows[i].t === "-" ? "del" : "ctx"}`} dir="auto"><span>{rows[i].t}</span>{rows[i].s || " "}</div>);
      continue;
    }
    let k = i;
    while (k < rows.length && !near[k]) k++;
    out.push(<div key={i} className="dl fold">… {k - i} unchanged line{k - i === 1 ? "" : "s"}</div>);
    i = k - 1;
  }
  return <div className="diff">{out}</div>;
}

// ── The brief ────────────────────────────────────────────────────────

export function BriefView({ b }: { b: Brief }) {
  const sections: [string, Brief["pick"]["opener"]][] = [["Every opening line", b.pick.opener], ["Every closing line", b.pick.ending], ["Every candidate clip", b.pick.window]];
  const gate = (k: string) => b.pick.gates.find((g) => g.key === k)?.min;
  const guides = [...Object.entries(b.design.zoomGuide), ...Object.entries(b.design.transitionGuide)];
  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="label">For every judge</div>
        <div className="hypo" dir="auto">{b.summary}</div>
      </div>
      <div className="card stack-sm brief">
        <div className="label">Pick clips: what Jev is asked</div>
        {sections.map(([title, qs]) => (
          <div key={title} className="brief-sec">
            <div className="hint">{title}</div>
            {qs.map((q) => (
              <div key={q.key} className="brief-q">
                <b dir="auto">{q.label}</b>
                <span className="mono faint">{q.type} · ×{q.weight}{gate(q.key) !== undefined ? ` · must be ≥${Math.round(gate(q.key)! * 100)}` : ""}</span>
                <span dir="auto">{q.instructions}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="brief-sec">
          <div className="hint">Tones it sorts clips into</div>
          <div className="design-chips">
            {Object.entries(b.pick.tones).map(([k, v]) => <span key={k} title={v} className={b.pick.preferredTones.includes(k) ? "pref" : ""}>{k.replace(/_/g, " ")}</span>)}
          </div>
        </div>
      </div>
      <div className="card stack-sm brief">
        <div className="label">Design edits: when to use each move</div>
        {guides.length ? guides.map(([k, v]) => <div key={k} className="brief-q"><b>{k.replace(/_/g, " ")}</b><span dir="auto">{v}</span></div>) : <div className="hint">Built-in guidance.</div>}
        <div className="brief-q"><b>hook cards</b><span dir="auto">{b.design.titleGuide}</span></div>
      </div>
      <div className="card stack-sm">
        <div className="label">Check: rules every finished clip is rated on</div>
        {b.check.map((r) => (
          <div key={r.key} className="brief-q-row">
            <span className="tag">{r.key.startsWith("ref_") ? "reference" : r.section || "general"}</span>
            <b dir="auto">{r.rule}</b>
            <span className="hint" dir="auto">Jev rates: {r.question}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
