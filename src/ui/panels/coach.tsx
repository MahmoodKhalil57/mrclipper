// Phase 6 · Learn: the Coach's proposal for the next outline version, its scorecard, and every version's score.
import { useState } from "react";
import { actions } from "../api";
import { JobCard, UP_TO_DATE } from "../Common";
import { Bar, LineDiff, ScorecardView, nodeJob, useGuard, type PanelProps } from "./shared";

export function CoachPanel(p: PanelProps) {
  const o = p.lib.outlines;
  const [direction, setDirection] = useState("");
  const guard = useGuard(p);
  const job = nodeJob(p, "coach");
  const node = p.wf.nodes.coach;
  const pending = o.pending;
  const cur = o.versions.find((v) => v.hash === o.current);
  // Idempotent: on the same evidence, outline and reference the Coach would say the same again. A new
  // direction is a new input.
  const newDirection = !!direction.trim() && direction.trim() !== (o.scorecard?.direction ?? "");
  const upToDate = node.state === "done" && !newDirection;
  return (
    <div className="stack">
      {pending ? (
        <div className="card stack-sm proposal">
          <div className="row">
            <b className="grow">Proposed: the next outline version</b>
            <span className="mono faint">{pending.model.split("/").pop()} · ${pending.cost.toFixed(3)}</span>
          </div>
          <div className="hypo" dir="auto">{pending.hypothesis}</div>
          {pending.keep && <div className="hint" dir="auto">Kept: {pending.keep}</div>}
          {pending.warnings.map((w) => <div key={w} className="hint warn-text">⚠ {w}</div>)}
          <div className="changes">
            {pending.changes.map((ch, i) => (
              <div key={i} className="change">
                <span className="tag">{ch.section}</span>
                <span dir="auto">{ch.change}</span>
                {ch.evidence && <span className="hint" dir="auto">because {ch.evidence}</span>}
              </div>
            ))}
          </div>
          <LineDiff a={p.lib.outline} b={pending.outline} />
          <div className="row">
            <button className="btn" onClick={() => guard(() => actions.discardProposal(pending.id), "Proposal discarded")}>Discard</button>
            <span className="grow" />
            <button className="btn" onClick={() => guard(() => actions.applyProposal(pending.id), "Outline updated")}>✓ Apply</button>
            <button className="btn primary" onClick={() => guard(async () => { await actions.applyProposal(pending.id); const r = await actions.run(p.video.name, null); p.toast(r.skipped ?? "Outline updated. ▶ Run is making a new take with it."); })}>✓ Apply and make a new take</button>
          </div>
        </div>
      ) : (
        <div className="card stack-sm">
          <div className="label">Coach the outline</div>
          <div className="hint">
            The LLM writes two rewrites for each outline section the evidence says should change; Jev picks keep or a rewrite, per section, with odds.
            Evidence: your reviews (keep, drop, nudges, comments), each clip's Check scores, and the style reference.
          </div>
          <textarea className="field" rows={2} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="Optional direction, e.g. the endings keep cutting mid-laugh" />
          <div className="row">
            <span className="hint grow">{newDirection ? "A new direction: it can coach again." : upToDate ? "Up to date: no new reviews or checks, and no outline or reference changes, since it last ran. Review a take or give it a new direction to coach again." : node.reason ?? ""}</span>
            {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
              : upToDate ? <button className="btn up-to-date" disabled title={UP_TO_DATE}>✓ Up to date</button>
              : <button className="btn primary" disabled={node.state === "locked"} onClick={() => p.step("coach", { video: p.video.name, direction })}>▶ Coach</button>}
          </div>
        </div>
      )}
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {o.scorecard && o.scorecard.outline_hash === o.current && <ScorecardView sc={o.scorecard} />}

      <div className="card stack-sm">
        <div className="label">Outline versions</div>
        <div className="hint">One-shot score per version: the share of clips you kept, ×0.85 if you didn't finish the review, ×0.9 per nudged clip, ×0.95 per comment. Takes you haven't reviewed don't count.</div>
        {[...o.versions].reverse().map((v) => (
          <div key={v.hash} className={`ver-row ${v.hash === cur?.hash ? "on" : ""}`}>
            <b>{v.label}</b>
            <span className={`engine-tag ${v.source === "coach" ? "coach" : ""}`}>{v.source === "coach" ? "coach" : "you"}</span>
            <span className="faint">{v.rated}/{v.takes} reviewed</span>
            <span className="grow" />
            <Bar v={(v.mean ?? 0) / 100} />
            <span className="mono">{v.mean ?? "–"}</span>
            {v.hash === cur?.hash ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>current</span>
              : <button className="btn sm" onClick={() => guard(() => actions.restoreVersion(v.hash), `Restored ${v.label}`)}>Restore</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
