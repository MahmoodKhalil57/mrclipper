// Phase 5 · Review (you): the finished clips, with what Check found. Keep or drop each, nudge its
// edges (Render then redoes just that clip), comment, and finish. Your review is the Coach's reward.
import { actions, fileUrl } from "../api";
import { Thread } from "../Common";
import { EditTimeline } from "./shared";
import { CheckCard } from "./make";
import { EdgeQa, Nudge, useGuard, type PanelProps } from "./shared";

export function ReviewPanel(p: PanelProps) {
  const run = p.run;
  const guard = useGuard(p);
  if (!run) return <div className="empty-panel"><p>No take yet. Press ▶ Run: it transcribes, briefs, picks, designs, renders and checks, then stops here for you.</p></div>;
  const verdict = (id: number) => run.review.clips[id]?.status ?? (run.review.clips[id]?.rating === 1 ? "keep" : run.review.clips[id]?.rating === -1 ? "drop" : undefined);
  const kept = run.clips.filter((c) => verdict(c.id) === "keep").length;
  const dropped = run.clips.filter((c) => verdict(c.id) === "drop").length;
  const undecided = run.clips.length - kept - dropped;
  const done = run.review.approved;
  const vertical = run.aspect !== "16:9";
  const staleClips = new Set((p.wf.nodes.render.facts.find(([k]) => k === "Changed since")?.[1] ?? "").replace(/[^\d,]/g, "").split(",").filter(Boolean).map(Number));

  return (
    <div className="stack">
      <div className={`gate-card ${done ? "ok" : "wait"}`}>
        <div>
          <b>{done ? "Review finished" : "Your turn"}</b>
          <div className="hint">
            {done
              ? `${kept} kept, ${dropped} dropped. One-shot ${p.wf.take?.score ?? "–"}: the Coach learns from this.`
              : `${kept} kept · ${dropped} dropped · ${undecided} undecided. Undecided clips count as kept when you finish.`}
          </div>
        </div>
        {done ? (
          <button className="btn" onClick={() => guard(() => actions.finish(run.id, false))}>Reopen</button>
        ) : (
          <button className="btn primary" onClick={() => guard(() => actions.finish(run.id, true), "Review finished. ▶ Run now lets the Coach learn from it.")}>✓ Finish review</button>
        )}
      </div>

      <div className="card stack-sm">
        <div className="label">Notes on this whole take</div>
        <Thread comments={run.review.comments} placeholder="e.g. too many sad clips; want one that's pure comedy"
          onAdd={(text) => guard(() => actions.comment(run.id, text))}
          onDelete={(id) => guard(() => actions.uncomment(run.id, id))}
          onSendToDirector={(text) => p.ask(`About take "${run.id}": ${text}`)} />
      </div>

      {run.clips.map((c) => {
        const r = run.review.clips[c.id];
        const v = verdict(c.id);
        const set = (patch: Parameters<typeof actions.clip>[2], ok?: string) => guard(() => actions.clip(run.id, c.id, patch), ok);
        const edges = run.check?.clips[c.id]?.edges;
        return (
          <div key={c.id} className={`card rclip ${v === "drop" ? "dropped" : ""}`}>
            <div className={`rclip-top ${vertical ? "tall" : ""}`}>
              {c.file ? (
                <video className={`rclip-video ${vertical ? "tall" : ""}`} src={fileUrl(c.file)} controls preload="metadata" playsInline />
              ) : (
                <div className="rclip-video empty">not rendered yet</div>
              )}
              <div className="rclip-info">
                <div className="row">
                  <span className="clip-num">{c.id}</span>
                  <span className="grow" />
                  <div className="keepdrop">
                    <button className={v === "keep" ? "on keep" : ""} onClick={() => set({ status: v === "keep" ? null : "keep" })}>Keep</button>
                    <button className={v === "drop" ? "on drop" : ""} onClick={() => set({ status: v === "drop" ? null : "drop" })}>Drop</button>
                  </div>
                </div>
                <div className="clip-title" dir="auto">{c.title}</div>
                <div className="clip-time">{(c.end - c.start).toFixed(1)}s{staleClips.has(c.id) ? " · edited since rendering" : ""}</div>
                {c.edit?.title && <div className="clip-ost" dir="auto">{c.edit.title}</div>}
                <CheckCard run={run} c={c} compact />
                {c.file && <a className="linkish" href={fileUrl(c.file)} download>download</a>}
              </div>
            </div>
            {v !== "drop" && (
              <>
                {edges && <EdgeQa q={edges} clip={c} apply={(patch) => set(patch, "Edge moved. ▶ Run re-renders this clip.")} />}
                <div className="nudges">
                  <Nudge label="In" value={c.edit && c.edit.enabled !== false ? c.edit.segments[0].start : c.start} onChange={(x) => set({ start: Math.max(0, x) })} />
                  <Nudge label="Out" value={c.edit && c.edit.enabled !== false ? c.edit.segments[c.edit.segments.length - 1].end : c.end} onChange={(x) => set({ end: x })} />
                  {(r?.nudges ?? 0) > 0 && <div className="hint">Nudged {r!.nudges}×. ▶ Run re-renders this clip.</div>}
                </div>
                {c.edit && <EditTimeline edit={c.edit} timeline={c.timeline} onToggle={(on) => set({ edit_enabled: on })} />}
              </>
            )}
            <Thread compact comments={r?.comments ?? []} placeholder="What works, what doesn't…"
              onAdd={(text) => guard(() => actions.comment(run.id, text, c.id))}
              onDelete={(id) => guard(() => actions.uncomment(run.id, id))}
              onSendToDirector={(text) => p.ask(`About clip ${c.id} ("${c.title}") of take "${run.id}": ${text}`)} />
          </div>
        );
      })}

      <div className="sticky-foot">
        <button className="btn" onClick={() => p.ask(`Look at my review of take "${run.id}" and explain what the Coach should learn from it.`)}>Ask the Director</button>
        <span className="grow" />
        {!done && <button className="btn primary" onClick={() => guard(() => actions.finish(run.id, true), "Review finished")}>✓ Finish review</button>}
      </div>
    </div>
  );
}
