// Phase 4 · Make, one take at a time: Pick clips → Design edits → Render → Check.
import { useState } from "react";
import { actions, fileUrl, type Clip } from "../api";
import { JobCard } from "../Common";
import { tc } from "../util";
import { Bar, EdgeQa, EditTimeline, Odds, PickBreakdown, nodeJob, useGuard, type PanelProps } from "./shared";

// ── Pick clips ───────────────────────────────────────────────────────

export function PickPanel(p: PanelProps) {
  const [direction, setDirection] = useState("");
  const [count, setCount] = useState("");
  const job = nodeJob(p, "pick");
  const node = p.wf.nodes.pick;
  const run = p.run;
  const running = job?.status === "running";
  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="label">A new take</div>
        <textarea className="field" rows={3} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)}
          placeholder="Optional direction for Jev, e.g. focus on the buffalo section; more jokes; avoid the intro" />
        <div className="row">
          <label className="label" style={{ margin: 0 }}>Clips</label>
          <input className="field num" type="number" min={1} max={20} placeholder="outline" value={count} onChange={(e) => setCount(e.target.value)} />
          <span className="grow" />
          {running ? (
            <button className="btn danger" onClick={() => p.stop(job!.id)}>■ Stop</button>
          ) : (
            <>
              <button className="btn" disabled={node.state === "locked"} onClick={() => p.step("pick", { notes: direction, count: count ? Number(count) : undefined })}>Pick only</button>
              <button className="btn primary" disabled={node.state === "locked"}
                onClick={() => actions.run(p.video.name, null, direction, true).then(() => p.toast("Making a new take: pick → design → render → check")).catch((e) => p.toast(e.message, "err"))}>
                ▶ Make a new take
              </button>
            </>
          )}
        </div>
        <div className="hint">Jev scores every opening line, closing line and candidate clip with the brief's questions, then the best clips that don't overlap win. It also reads your transcript notes and earlier reviews.</div>
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      <div className="label">Takes of this video</div>
      {p.wf.takes.map((t, i) => {
        const r = p.lib.runs.find((x) => x.id === t.id);
        const on = p.wf.take?.id === t.id;
        return (
          <button key={t.id} className={`take ${on ? "on" : ""}`} onClick={() => p.selectTake(i === 0 ? null : t.id)}>
            <div className="row">
              <b>Take {p.wf.takes.length - i}</b>
              <span className="mono faint">{t.created}</span>
              <span className="grow" />
              {t.current ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>current inputs</span> : <span className="tag">older inputs</span>}
              {t.reviewed ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>reviewed · {t.score ?? "–"}</span> : <span className="tag">not reviewed</span>}
            </div>
            {r?.jev && <div className="hint mono">{r.jev.stats.calls} decisions · {r.jev.stats.candidates} candidates · ${r.jev.stats.cost.toFixed(3)}{r.jev.direction ? ` · direction: "${r.jev.direction}"` : ""}</div>}
            <div className="take-clips">
              {r?.clips.map((c) => <span key={c.id} dir="auto" className={r.review.clips[c.id]?.status ?? ""}>{c.id}. {c.title}</span>)}
            </div>
          </button>
        );
      })}
      {run?.jev && (
        <>
          {run.jev.alternatives.length > 0 && (
            <details className="runners">
              <summary>Runner-ups Jev also liked ({run.jev.alternatives.length})</summary>
              {run.jev.alternatives.map((a, i) => (
                <div key={i} className="runner">
                  <span className="mono">{tc(a.start)}–{tc(a.end)}</span>
                  <Bar v={a.overall} />
                  <span className="ar" dir="rtl">{a.opening}</span>
                </div>
              ))}
            </details>
          )}
          <details className="runners">
            <summary>Why Jev picked each clip</summary>
            {run.clips.map((c) => run.jev!.clips[c.id] && (
              <div key={c.id} className="stack-sm" style={{ marginTop: 8 }}>
                <div className="clip-title" dir="auto">{c.id}. {c.title}</div>
                <PickBreakdown s={run.jev!.clips[c.id]} />
              </div>
            ))}
          </details>
        </>
      )}
    </div>
  );
}

// ── Design edits ─────────────────────────────────────────────────────

export function DesignPanel(p: PanelProps) {
  const run = p.run;
  const job = nodeJob(p, "design");
  if (!run) return <div className="empty-panel"><p>No take yet. Pick clips first.</p></div>;
  const d = run.design;
  const decisions = d ? Object.values(d.clips).reduce((n, c) => n + c.zooms.length + c.transitions.length + (c.hook ? 1 : 0) + (c.emphasis?.length ?? 0), 0) : 0;
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{d ? `${decisions} Jev choices` : "Not designed yet"}</b>
          <div className="hint">
            {d
              ? `${d.guide === "llm" ? "Guidance from the brief" : "Built-in guidance"} · $${d.cost.toFixed(3)} · the LLM wrote hook-card options, Jev picked`
              : "Jev picks each part's camera move and each gap's transition from what the outline allows, then the hook card from the LLM's options."}
          </div>
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <button className="btn primary" onClick={() => p.step("design", { take: run.id })}>{d ? "↻ Redesign" : "▶ Design"}</button>}
      </div>
      {run.review.approved && d && <div className="hint warn-text">This take is reviewed; redesigning sends it back to review.</div>}
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {d && run.clips.map((c) => {
        const cd = d.clips[c.id];
        if (!cd || !c.edit) return null;
        return (
          <div key={c.id} className="card stack-sm design-clip">
            <div className="row"><span className="clip-num">{c.id}</span><span className="clip-title grow" dir="auto">{c.title}</span></div>
            {cd.hook && (
              <div className="hooks">
                {Object.entries(cd.hook.texts).map(([k, text]) => (
                  <div key={k} className={`hook-opt ${k === cd.hook!.chosen ? "on" : ""}`}>
                    <span className="mono">{Math.round((cd.hook!.options[k] ?? 0) * 100)}%</span>
                    <span dir="auto">{text}</span>
                  </div>
                ))}
              </div>
            )}
            {c.edit.segments.map((s, i) => {
              const z = cd.zooms.find((x) => x.piece === i + 1);
              const t = i > 0 ? cd.transitions.find((x) => x.gap === i) : undefined;
              return (
                <div key={i} className="design-row-wrap">
                  {i > 0 && (
                    <div className="design-gap">
                      <span className="mono">↓ {c.edit!.transitions[i - 1] ?? "cut"}</span>
                      {t && <Odds options={t.options} chosen={t.transition} />}
                    </div>
                  )}
                  <div className="design-row">
                    <span className="mono">Part {i + 1}</span>
                    <span className="mono faint">{tc(s.start, true)}–{tc(s.end, true)}</span>
                    <b>{(s.zoom ?? "none").replace(/_/g, " ")}</b>
                    {s.look && <span className="tag">{s.look}</span>}
                    {z?.ending && <span className="tag" title="Jev judged this the final beat, so the camera pulls back">final beat</span>}
                    {z?.varied && <span className="tag" title="Same move as the part before; Jev's runner-up was used for variety">for variety</span>}
                    <span className="grow" />
                    {z && <Odds options={z.options} chosen={z.zoom} />}
                    {z?.flashback !== undefined && <span className="mono faint" title="Jev: this part is a memory or flashback">↺ {Math.round(z.flashback * 100)}%</span>}
                  </div>
                </div>
              );
            })}
            {cd.emphasis?.length ? (
              <div className="design-chips">
                {cd.emphasis.map((w) => <span key={w.w} className={w.kept ? "pref" : ""} dir="auto" title={`Jev ${Math.round(w.p * 100)}%`}>{w.w} {Math.round(w.p * 100)}%</span>)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Render ───────────────────────────────────────────────────────────

export function RenderPanel(p: PanelProps) {
  const run = p.run;
  const job = nodeJob(p, "render");
  const node = p.wf.nodes.render;
  if (!run) return <div className="empty-panel"><p>No take yet.</p></div>;
  const stale = new Set((node.facts.find(([k]) => k === "Changed since")?.[1] ?? "").replace(/[^\d,]/g, "").split(",").filter(Boolean).map(Number));
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{node.facts.find(([k]) => k === "Rendered")?.[1] ?? "0"} rendered</b>
          <div className="hint">ffmpeg renders each kept clip: face-tracked 9:16 framing, the designed moves and transitions, the outline's look, karaoke captions and the hook card. Only clips whose edit changed are rendered again.</div>
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <button className="btn primary" disabled={node.state === "locked"} onClick={() => p.step("render", { take: run.id })}>{node.state === "done" ? "↻ Re-render changed" : "▶ Render"}</button>}
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {run.clips.map((c) => {
        const dropped = run.review.clips[c.id]?.status === "drop";
        return (
          <div key={c.id} className={`cut-line ${dropped ? "dropped" : ""}`}>
            <span className="clip-num">{c.id}</span>
            <div className="grow">
              <div className="clip-title" dir="auto">{c.title}</div>
              <div className="clip-time">{tc(c.start)} → {tc(c.end)} · {(c.end - c.start).toFixed(1)}s</div>
            </div>
            {dropped ? <span className="tag">dropped</span> : c.file ? (stale.has(c.id) ? <span className="tag" style={{ ["--c" as any]: "var(--warn)" }}>edit changed</span> : <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>rendered</span>) : <span className="tag">not yet</span>}
            {c.file && <a className="btn sm" href={fileUrl(c.file)} download>Download</a>}
            <button className="btn sm" disabled={node.state === "locked" || job?.status === "running"} onClick={() => p.step("render", { take: run.id, only: [c.id], force: true })}>{c.file ? "Re-render" : "Render"}</button>
          </div>
        );
      })}
    </div>
  );
}

// ── Check ────────────────────────────────────────────────────────────

export function CheckCard({ run, c, compact }: { run: NonNullable<PanelProps["run"]>; c: Clip; compact?: boolean }) {
  const ck = run.check?.clips[c.id];
  const rules = run.check?.rules ?? [];
  const w = c.watch;
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  if (!ck) return <div className="hint">Not checked yet.</div>;
  const missed = rules.filter((r) => (ck.rules[r.key] ?? 1) < 0.5);
  return (
    <div className="check-card stack-sm">
      <div className="row">
        <span className="engine-tag jev">Check</span>
        <b className="mono">{Math.round(ck.followed * 100)}%</b><span className="faint">of the rules followed</span>
        <span className="grow" />
        {w && <span className="mono faint" title="Faces fully inside the frame">🙂 {pc(w.metrics.faces_ok)}</span>}
        {w && <span className="mono faint" title="Frames with someone cut off">✂ {w.metrics.cut_off}</span>}
      </div>
      {compact ? (
        missed.length > 0 && <div className="hint" dir="auto">Misses: {missed.slice(0, 3).map((r) => r.rule).join("; ")}</div>
      ) : (
        <div className="scores">
          {rules.map((r) => (
            <div key={r.key} className="score" title={r.question}><span dir="auto">{r.key.startsWith("ref_") ? "◇ " : ""}{r.rule}</span><Bar v={ck.rules[r.key] ?? 0} /><span className="mono">{Math.round((ck.rules[r.key] ?? 0) * 100)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CheckPanel(p: PanelProps) {
  const run = p.run;
  const job = nodeJob(p, "check");
  const node = p.wf.nodes.check;
  const guard = useGuard(p);
  if (!run) return <div className="empty-panel"><p>No take yet.</p></div>;
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{node.facts.find(([k]) => k === "Checked")?.[1] ?? "0"} checked</b>
          <div className="hint">Every finished clip is heard (Whisper) and watched (a frame every ~3 s, faces measured locally), then Jev rates it on the brief's check rules and checks its in and out points. ◇ = a rule from the style reference.</div>
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <button className="btn primary" disabled={node.state === "locked"} onClick={() => p.step("check", { take: run.id })}>{node.state === "done" ? "↻ Re-check" : "▶ Check"}</button>}
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {run.clips.filter((c) => c.file).map((c) => {
        const x = c.watch;
        const ck = run.check?.clips[c.id];
        return (
          <div key={c.id} className="card stack-sm watch-clip">
            <div className="row"><span className="clip-num">{c.id}</span><span className="clip-title grow" dir="auto">{c.title}</span>{x && !x.fresh && <span className="tag">re-rendered since</span>}</div>
            <CheckCard run={run} c={c} />
            {ck?.edges && <EdgeQa q={ck.edges} clip={c} apply={(patch) => guard(() => actions.clip(run.id, c.id, patch), "Edge moved; Render redoes this clip")} />}
            {x && (
              <>
                <div className="watch-metrics">
                  <span title="Word overlap between Whisper on the finished clip and the source transcript; 45-70% is normal for dialect, under 30% suggests lost audio">🔊 overlap <b>{pc(x.metrics.script_match)}</b></span>
                  <span>🙂 faces in frame <b>{pc(x.metrics.faces_ok)}</b></span>
                  <span>✂ cut off <b>{x.metrics.cut_off}</b></span>
                  <span>💬 captions ok <b>{pc(x.metrics.captions_ok)}</b></span>
                </div>
                <div className="watch-frames">
                  {x.frames.map((f, i) => {
                    const bad = f.face_cut || f.framing === "cut_off" || f.framing === "empty" || f.caption_ok === false;
                    return (
                      <figure key={i} className={bad ? "bad" : ""} title={[f.desc, f.effect && `effect: ${f.effect}`, f.captions && `captions: ${f.captions}`, f.face_cut && "a face is cut by the edge"].filter(Boolean).join("\n")}>
                        <img src={fileUrl(f.frame)} alt="" loading="lazy" />
                        <figcaption className="mono">{f.t.toFixed(0)}s{f.effect ? ` · ${f.effect}` : ""}</figcaption>
                      </figure>
                    );
                  })}
                </div>
                {x.audio && <details className="runners"><summary>What it says</summary><div className="watch-heard" dir="auto">{x.audio.text}</div></details>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}


