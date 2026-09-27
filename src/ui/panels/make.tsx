// Phase 4 · Make, one take at a time: Pick clips → Design edits → Render → Check.
import { useEffect, useState } from "react";
import { actions, fileUrl, uploadVideo, type AssetInfo, type Clip, type DesignConcept, type EffectInfo, type EffectsLibrary, type FxKind, type Started } from "../api";
import { JobCard, UP_TO_DATE } from "../Common";
import { tc } from "../util";
import { Bar, EdgeQa, EditTimeline, Odds, PickBreakdown, StepTrigger, gapName, nodeJob, useGuard, type PanelProps } from "./shared";

// ── Pick clips ───────────────────────────────────────────────────────

export function PickPanel(p: PanelProps) {
  // Pick's settings are its inputs, saved per video: the take is up to date while they (and the brief,
  // your notes and the transcript) are what it was picked with.
  const saved = p.wf.pick;
  const [direction, setDirection] = useState(saved.direction);
  const [count, setCount] = useState(saved.count ? String(saved.count) : "");
  useEffect(() => {
    setDirection(saved.direction);
    setCount(saved.count ? String(saved.count) : "");
  }, [saved.direction, saved.count]);
  const guard = useGuard(p);
  const job = nodeJob(p, "pick");
  const node = p.wf.nodes.pick;
  const run = p.run;
  const running = job?.status === "running";
  const draft = { direction: direction.trim(), count: Number(count) > 0 ? Math.min(20, Math.round(Number(count))) : null };
  const edited = draft.direction !== saved.direction || draft.count !== saved.count;
  // Idempotent: on the same inputs Pick would pick the same take again, and a take already picked from
  // the edited settings (with the current brief, notes and transcript) comes back instead of a new one.
  const upToDate = node.state === "done" && !edited;
  const reuse = edited ? p.wf.takes.find((t) => t.otherInputsCurrent && t.settings.direction === draft.direction && t.settings.count === draft.count) : undefined;
  const reuseName = reuse ? `take ${p.wf.takes.length - p.wf.takes.indexOf(reuse)}` : "";
  const go = (start: () => Promise<Started>, ok: string) =>
    guard(async () => {
      if (edited) await actions.pickSettings(p.video.name, draft);
      const r = await start();
      p.toast(r.skipped ?? ok);
    });
  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="label">Pick's settings</div>
        <textarea className="field" rows={3} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)}
          placeholder="Optional direction for Jev, e.g. focus on the buffalo section; more jokes; avoid the intro" />
        <div className="row">
          <label className="label" style={{ margin: 0 }}>Clips</label>
          <input className="field num" type="number" min={1} max={20} placeholder="outline" value={count} onChange={(e) => setCount(e.target.value)} />
          <span className="grow" />
          {running ? (
            <button className="btn danger" onClick={() => p.stop(job!.id)}>■ Stop</button>
          ) : upToDate ? (
            <button className="btn up-to-date" disabled title={UP_TO_DATE}>✓ Up to date</button>
          ) : reuse ? (
            <button className="btn primary" onClick={() => guard(async () => {
              await actions.pickSettings(p.video.name, draft);
              p.selectTake(null);
            }, `Back to ${reuseName}: it was picked with these settings.`)}>↩ Back to {reuseName}</button>
          ) : (
            <>
              {edited && <button className="btn" onClick={() => guard(() => actions.pickSettings(p.video.name, draft), "Saved. ▶ Run makes a new take with them.")}>Save</button>}
              <button className="btn" disabled={node.state === "locked"} onClick={() => go(() => actions.step("pick", { video: p.video.name }), "Picking clips")}>Pick only</button>
              <button className="btn primary" disabled={node.state === "locked"} onClick={() => go(() => actions.run(p.video.name, null), "Making a new take: pick → design → render → check")}>
                ▶ Make a new take
              </button>
            </>
          )}
        </div>
        <div className="hint">
          {reuse
            ? `${reuseName[0].toUpperCase()}${reuseName.slice(1)} was picked with exactly these inputs, so these settings bring it back instead of making a new take.`
            : edited
            ? "Changed from what the current take was picked with. A new take uses these."
            : upToDate
              ? "The current take was picked with these settings, the current brief, your notes and the transcript, so picking again would give the same take. Change one of them to make another."
              : node.reason ?? "Jev scores every opening line, closing line and candidate clip with the brief's questions, then the best clips that don't overlap win. It also reads your transcript notes."}
        </div>
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      <div className="label">Takes of this video</div>
      {p.wf.takes.map((t, i) => {
        // With nothing selected, the canvas shows the latest take made from the current inputs.
        const auto = p.wf.takes.find((x) => x.current) ?? p.wf.takes[0];
        const r = p.lib.runs.find((x) => x.id === t.id);
        const on = p.wf.take?.id === t.id;
        return (
          <button key={t.id} className={`take ${on ? "on" : ""}`} onClick={() => p.selectTake(t.id === auto?.id ? null : t.id)}>
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

const KIND_TITLE: Record<FxKind, string> = {
  segment: "Camera moves and looks (per part)", transition: "Transitions", video: "Video effects (over a time range)", graphic: "Graphics",
  text: "Text and shapes", asset: "Your files over the picture", sound: "Sounds", voice: "The clip's own audio", music: "Music",
};
const FOLDER_LABEL: Record<AssetInfo["kind"], string> = { sfx: "Sound effects", music: "Music", overlay: "Overlays (GIF, WebM, MOV)", image: "Images", lut: "LUTs", font: "Fonts" };

/** The effects library the planner draws from, and your files in assets/: browse, add, open the folder. */
function LibraryCard({ p }: { p: PanelProps }) {
  const [lib, setLib] = useState<EffectsLibrary | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<AssetInfo["kind"]>("sfx");
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => actions.effects().then(setLib).catch(() => setLib(null));
  useEffect(() => {
    load();
  }, []);
  if (!lib) return null;
  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      for (const f of Array.from(files)) await uploadVideo(f, setBusy, `/api/assets/upload?kind=${kind}`);
      p.toast(`Added ${files.length} file${files.length > 1 ? "s" : ""} to ${lib.folders[kind]}/. Design is out of date now, so the next Run plans with them.`);
    } catch (e) {
      p.toast((e as Error).message, "err");
    }
    setBusy(null);
    load();
    p.refresh();
  };
  const needle = q.trim().toLowerCase();
  const match = (e: EffectInfo) => !needle || e.name.includes(needle.replace(/\s+/g, "_")) || e.description.toLowerCase().includes(needle) || e.tags.some((t) => t.includes(needle));
  const xfades = lib.effects.filter((e) => e.kind === "transition" && e.tags.includes("xfade"));
  const shown = lib.effects.filter((e) => !xfades.includes(e) || needle);
  return (
    <div className="card stack-sm lib-card">
      <div className="row">
        <b className="grow">Effects library</b>
        <span className="mono faint">{lib.effects.length} effects · {lib.assets.length} file{lib.assets.length === 1 ? "" : "s"}</span>
        <button className="btn sm" onClick={() => actions.openAssets().catch((e) => p.toast(e.message, "err"))}>Open assets folder</button>
      </div>
      <div className="hint">
        Put sound effects, music, GIFs, stickers, LUTs and fonts in <span className="mono">{lib.assetsDir}/</span> and name them for what they are ("whoosh_long", "sad_piano"): the planner reads the names.
        Your own effects go in <span className="mono">{lib.effectsDir}/</span> as JSON. New files put Design out of date, so the next Run plans with them.
      </div>
      <div className="row">
        <select className="field" value={kind} onChange={(e) => setKind(e.target.value as AssetInfo["kind"])}>
          {Object.entries(FOLDER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="btn sm">
          ＋ Add files<input type="file" multiple hidden onChange={(e) => add(e.target.files)} />
        </label>
        {busy !== null && <span className="mono faint">{Math.round(busy * 100)}%</span>}
      </div>
      {lib.assets.length > 0 && (
        <div className="asset-groups">
          {(Object.keys(FOLDER_LABEL) as AssetInfo["kind"][]).filter((k) => lib.assets.some((a) => a.kind === k)).map((k) => (
            <div key={k} className="asset-group">
              <span className="label">{FOLDER_LABEL[k]}</span>
              <div className="design-chips">
                {lib.assets.filter((a) => a.kind === k).map((a) => (
                  <a key={a.file} href={fileUrl(a.file)} target="_blank" rel="noreferrer" title={a.file}>{a.name}{a.duration ? <span className="faint"> {a.duration.toFixed(1)}s</span> : null}</a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {lib.notes.map((n) => <div key={n} className="hint warn-text">{n}</div>)}
      <details className="runners">
        <summary>Browse the effects</summary>
        <input className="field" placeholder="Search: glitch, sad, anime, text, border, whoosh…" value={q} onChange={(e) => setQ(e.target.value)} />
        {(Object.keys(KIND_TITLE) as FxKind[]).map((k) => {
          const list = shown.filter((e) => e.kind === k && match(e));
          if (!list.length) return null;
          return (
            <div key={k} className="fx-group">
              <div className="label">{KIND_TITLE[k]} <span className="faint">{list.length}</span></div>
              {list.map((e) => (
                <div key={`${e.kind}:${e.name}`} className="fx-item">
                  <b className="mono">{e.name}</b>
                  <span className="tag">{e.timing === "instant" ? `at a moment${e.duration ? ` · ${e.duration}s` : ""}` : e.timing === "range" ? "over a range" : "a whole part"}</span>
                  {e.origin === "workspace" && <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>yours</span>}
                  <span className="fx-desc">{e.description}</span>
                  {e.params && <span className="fx-params mono">{Object.entries(e.params).map(([pk, ps]) => `${pk}${ps.type === "number" ? ` ${ps.min}–${ps.max}` : ps.type === "enum" ? ` ${ps.values.join("|")}` : ps.type === "asset" ? " (a file)" : ""}`).join(" · ")}</span>}
                </div>
              ))}
              {k === "transition" && !needle && <div className="hint">Plus every ffmpeg transition: {xfades.map((e) => e.name).join(", ")}.</div>}
            </div>
          );
        })}
      </details>
    </div>
  );
}

/** The LLM's plans for one clip, with Jev's odds. */
function Concepts({ list }: { list: DesignConcept[] }) {
  return (
    <div className="concepts">
      {list.map((c) => (
        <div key={c.key} className={`concept ${c.chosen ? "on" : ""} ${c.ok ? "" : "broken"}`}>
          <div className="row">
            <span className="concept-key mono">{c.key.toUpperCase()}</span>
            <b className="grow" dir="auto">{c.name}</b>
            {c.ok ? <span className="mono">{Math.round(c.p * 100)}%</span> : <span className="tag" style={{ ["--c" as any]: "var(--err)" }}>didn't render</span>}
            {c.chosen && <span className="tag" style={{ ["--c" as any]: "var(--who-jev)" }}>Jev's pick</span>}
          </div>
          {c.ok && <Bar v={c.p} warn={0} />}
          {c.idea && <div className="concept-idea" dir="auto">{c.idea}</div>}
          {c.plan.length > 0 && (
            <details>
              <summary>The plan</summary>
              <ul className="concept-plan">{c.plan.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul>
            </details>
          )}
          {c.notes.length > 0 && (
            <details>
              <summary className="warn-text">{c.notes.length} note{c.notes.length > 1 ? "s" : ""} from the checks</summary>
              <ul className="concept-plan">{c.notes.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

export function DesignPanel(p: PanelProps) {
  const run = p.run;
  const job = nodeJob(p, "design");
  const node = p.wf.nodes.design;
  if (!run) return <div className="empty-panel"><p>No take yet. Pick clips first.</p></div>;
  const d = run.design;
  const planned = d ? Object.values(d.clips).filter((c) => c.mode === "concepts").length : 0;
  const effects = run.clips.reduce((n, c) => n + (c.edit?.fx?.length ?? 0), 0);
  const decisions = d ? Object.values(d.clips).reduce((n, c) => n + c.zooms.length + c.transitions.length + (c.hook ? 1 : 0) + (c.emphasis?.length ?? 0), 0) : 0;
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{!d ? "Not designed yet" : planned ? `${planned} clip${planned === 1 ? "" : "s"} planned · ${effects} effect${effects === 1 ? "" : "s"}` : `${decisions} Jev choices`}</b>
          <div className="hint">
            {!d
              ? "The LLM plans two edits per clip from the effects library and your files, code checks and test-renders them, and Jev picks one. Then the hook card and emphasis words."
              : `${planned ? "The LLM planned two edits per clip; Jev picked" : "Jev picked a move per part and a transition per join"} · the LLM wrote hook-card options, Jev picked · $${d.cost.toFixed(3)}`}
          </div>
          {node.state === "stale" && node.reason && <div className="hint warn-text">{node.reason}</div>}
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <StepTrigger p={p} id="design" first="Design" again="Redesign" args={{ take: run.id }} />}
      </div>
      {run.review.approved && d && <div className="hint warn-text">This take is reviewed; redesigning sends it back to review.</div>}
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      <LibraryCard p={p} />
      {d && run.clips.map((c) => {
        const cd = d.clips[c.id];
        if (!cd || !c.edit) return null;
        return (
          <div key={c.id} className="card stack-sm design-clip">
            <div className="row"><span className="clip-num">{c.id}</span><span className="clip-title grow" dir="auto">{c.title}</span></div>
            {cd.concepts?.length ? <Concepts list={cd.concepts} /> : null}
            <EditTimeline edit={c.edit} timeline={c.timeline} />
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
            {cd.mode !== "concepts" && c.edit.segments.map((s, i) => {
              const z = cd.zooms.find((x) => x.piece === i + 1);
              const t = i > 0 ? cd.transitions.find((x) => x.gap === i) : undefined;
              return (
                <div key={i} className="design-row-wrap">
                  {i > 0 && (
                    <div className="design-gap">
                      <span className="mono">↓ {gapName(c.edit!.transitions[i - 1])}</span>
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
          <div className="hint">ffmpeg renders each kept clip in one pass: face-tracked 9:16 framing, the designed edit with its effects, overlays, sounds and music, the outline's look, captions and the hook card. Only clips whose edit (or an effect or file it uses) changed are rendered again.</div>
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <StepTrigger p={p} id="render" first="Render" again="Render changed clips" args={{ take: run.id }} />}
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
            {!dropped && (c.file && !stale.has(c.id)
              ? <button className="btn sm up-to-date" disabled title={UP_TO_DATE}>✓ Up to date</button>
              : <button className="btn sm" disabled={node.state === "locked" || job?.status === "running"} onClick={() => p.step("render", { take: run.id, only: [c.id] })}>{c.file ? "Re-render" : "Render"}</button>)}
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
          : <StepTrigger p={p} id="check" first="Check" again="Check changed clips" args={{ take: run.id }} />}
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


