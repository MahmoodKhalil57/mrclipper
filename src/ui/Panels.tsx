import { useEffect, useMemo, useRef, useState } from "react";
import { actions, fileUrl, putText, thumbUrl, type Clip, type ClipEdit, type EdgeCheck, type DesignRun, type Engine, type Job, type JevBrief, type JevScores, type Library, type Note, type Run, type Segment, type Shot } from "./api";
import { Film, JobCard, StateChip, TextEditor, Thread } from "./Common";
import { ENGINE_NAME, type CutOptions } from "./Flow";
import type { Pipeline, StageKey } from "./pipeline";
import { bytes, tc, tcms } from "./util";

export type PanelProps = {
  p: Pipeline;
  lib: Library;
  jobs: Job[];
  refresh: () => void;
  ask: (text: string) => void;
  stop: (id: string) => void;
  selectRun: (id: string) => void;
  run: (stage: "transcribe" | "brief" | "plan" | "design" | "cut" | "watch" | "rubric" | "coach", extra?: Record<string, unknown>) => void;
  approve: (approved?: boolean) => void;
  cutOpts: CutOptions;
  setCutOpts: (o: CutOptions) => void;
  toast: (msg: string, kind?: "err" | "ok") => void;
};

const TITLES: Record<StageKey, [string, string]> = {
  source: ["Source", "The video everything is cut from"],
  outline: ["Outline", "Audience, tone, story and editing rules. It feeds the Planner, which picks clips and edits by it. Each take keeps a copy of the editing settings it was planned with."],
  transcribe: ["Transcript", "What the Transcriber heard. Click a line to play it; pin notes for the Planner."],
  brief: ["Brief", "The LLM step between the Outline and System One. One call turns the outline into the questions Jev asks about every candidate, the tones it sorts by, its safety gates and when to use each camera move and transition. Hybrid takes reuse it until the outline changes."],
  plan: ["Clip plan", "The Planner's picks. Steer the next take with direction, the outline and history."],
  design: ["Edit design", "Between the Planner and the Editor: Jev picks each part's camera move and each gap's transition from what the outline allows. Every choice shows its odds."],
  review: ["Review", "Your checkpoint. Drop or trim clips and comment. Nothing is cut until you approve."],
  cut: ["Cut", "The Editor renders each kept clip with ffmpeg."],
  clips: ["Clips", "Finished files. Comment on what works; the next plan reads it."],
  watch: ["Clip transcript", "The Transcriber, pointed at the finished clips: what the rendered file actually says (Whisper) and shows (a frame every ~3 s, faces measured locally, framing, captions and effects checked). The coach judges this, not the plan."],
  rubric: ["Rubric", "The LLM step before the Jev coach. It turns the outline and your reviews into rules Jev rates every finished clip on, plus two rewrites for each section the evidence says is hurting clips. Jev makes the choices."],
  coach: ["Outline coach", "The loop back into the Outline. Your reviews score each outline version; the coach reads that evidence and proposes the next version, aiming for takes you'd approve as-is."],
};

export function Panel({ stage, onClose, ...props }: PanelProps & { stage: StageKey; onClose: () => void }) {
  const [title, sub] = TITLES[stage];
  const state = (props.p as any)[stage]?.state ?? "done";
  return (
    <aside className="panel pane">
      <div className="panel-head">
        <div style={{ minWidth: 0 }}>
          <div className="pane-kicker">{stage === "review" ? "You" : stage === "source" || stage === "outline" ? "Input" : stage === "transcribe" ? "Transcriber" : stage === "brief" || stage === "rubric" ? "LLM" : stage === "coach" ? (props.p.coach.by === "llm" ? "LLM" : "Jev") : stage === "watch" ? "Transcriber" : stage === "plan" ? "Planner" : stage === "design" ? "Designer" : "Editor"}</div>
          <div className="panel-title">{title}</div>
          <div className="hint">{sub}</div>
        </div>
        <StateChip state={state} />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="scroll panel-body">
        {stage === "source" && <SourcePanel {...props} />}
        {stage === "outline" && <OutlinePanel {...props} />}
        {stage === "transcribe" && <TranscriptPanel {...props} />}
        {stage === "brief" && <BriefPanel {...props} />}
        {stage === "plan" && <PlanPanel {...props} />}
        {stage === "watch" && <WatchPanel {...props} />}
        {stage === "rubric" && <RubricPanel {...props} />}
        {stage === "coach" && <CoachPanel {...props} />}
        {stage === "design" && <DesignPanel {...props} />}
        {stage === "review" && <ReviewPanel {...props} />}
        {stage === "cut" && <CutPanel {...props} />}
        {stage === "clips" && <ClipsPanel {...props} />}
      </div>
    </aside>
  );
}

// ── Vision helpers ─────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  host_closeup: "Host close-up", host_wide: "Host wide", broll_footage: "Footage", archival_photo: "Archive photo",
  map: "Map", graphic: "Graphic", text_card: "Text card", animation: "Animation", other: "Other",
};

/** The vision transcript for a video, loaded once per video (and again when its shot count changes). */
function useShots(video: string, shotCount: number | undefined) {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    if (!shotCount) return setShots([]);
    actions.vision(video).then((v) => setShots(v.shots ?? [])).catch(() => setShots([]));
  }, [video, shotCount]);
  return shots;
}

/** Would a centred 9:16 crop keep the main subject? (It keeps the middle 31.6% of a 16:9 frame.) */
const cropSafe = (x?: number) => x === undefined || Math.abs(x - 0.5) <= 0.158;

const TRANSITION_GLYPH: Record<string, string> = { cut: "|", crossfade: "◐", dip_black: "●", slide: "⇠", zoom: "⊕", whip: "≋", flash: "✦", iris: "◎", blur: "≈" };
const ZOOM_LABEL: Record<string, string> = { punch_in: "punch-in", slow_push: "slow push", ken_burns: "Ken Burns", zoom_out: "pull back", drift: "drift" };

/** The clip's edit decision list: segments in play order, sized by duration, with transitions between them. */
function EditTimeline({ edit, onToggle }: { edit: ClipEdit; onToggle: (on: boolean) => void }) {
  const on = edit.enabled !== false;
  const durs = edit.segments.map((s) => (s.end - s.start) / (s.speed ?? 1));
  const total = durs.reduce((a, b) => a + b, 0);
  const coldOpen = edit.segments.some((s, i) => i > 0 && s.start < edit.segments[i - 1].start);
  return (
    <div className={`edl ${on ? "" : "off"}`}>
      <div className="edl-head">
        <span className="label">Edit</span>
        <span className="hint grow">
          {edit.segments.length} segment{edit.segments.length > 1 ? "s" : ""} · {total.toFixed(1)}s
          {coldOpen ? " · cold open" : ""}
          {edit.transitions.some((t) => t !== "cut") ? ` · ${edit.transitions.filter((t) => t !== "cut").join(", ").replace(/_/g, " ")}` : ""}
        </span>
        <label className="edl-toggle" title="Off = cut the plain range with simple captions">
          <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} /> creative edit
        </label>
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
              {(s as any).look && (s as any).look !== "none" && <i>{(s as any).look === "bw" ? "black & white" : "sepia"}</i>}
            </div>
          </div>
        ))}
      </div>
      {edit.emphasis?.length ? <div className="edl-emph">{edit.emphasis.map((w) => <span key={w} className="ar" dir="auto">{w}</span>)}</div> : null}
    </div>
  );
}

function ShotStrip({ shots, start, end, onPick }: { shots: Shot[]; start: number; end: number; onPick?: (t: number) => void }) {
  const inClip = shots.filter((s) => s.end > start && s.start < end && !s.cont);
  if (!inClip.length) return null;
  const unsafe = inClip.filter((s) => !cropSafe(s.subject_x)).length;
  return (
    <div className="shotstrip">
      <div className="shotstrip-row">
        {inClip.slice(0, 10).map((s) => (
          <button key={s.id} className={`shot-thumb ${cropSafe(s.subject_x) ? "" : "unsafe"}`} onClick={() => onPick?.(s.start)}
            title={`${tc(s.start, true)} ${KIND_LABEL[s.kind ?? ""] ?? s.kind ?? ""}: ${s.desc ?? ""}${s.text ? ` | ${s.text}` : ""}`}>
            <img src={fileUrl(s.frame)} alt="" loading="lazy" />
            <i className="crop" style={{ left: `${34.2}%`, width: `${31.6}%` }} />
          </button>
        ))}
        {inClip.length > 10 && <span className="faint mono">+{inClip.length - 10}</span>}
      </div>
      <div className="hint">
        {inClip.length} shots: {[...new Set(inClip.map((s) => KIND_LABEL[s.kind ?? ""] ?? s.kind).filter(Boolean))].slice(0, 4).join(", ")}
        {unsafe > 0 && <span className="warn-text"> · {unsafe} with the subject outside a centred 9:16 crop</span>}
      </div>
    </div>
  );
}

// ── Outline ────────────────────────────────────────────────────────

function OutlinePanel({ lib, refresh }: PanelProps) {
  return (
    <TextEditor path="clip_outline.md" initial={lib.outline} onSaved={refresh} save={(t) => putText("/api/outline", t)}
      hint={<>Keep the bold labels like <code>**Number of clips:**</code> and <code>**Caption style:**</code>: the Planner reads them. Changes apply to the next take; takes you've already planned keep the settings they were planned with.</>} />
  );
}

// ── Source ─────────────────────────────────────────────────────────

function SourcePanel({ p }: PanelProps) {
  const v = p.video;
  return (
    <div className="stack">
      <video className="player" src={fileUrl(v.path)} controls preload="metadata" poster={thumbUrl(v.name, v.duration * 0.18)} />
      <div className="card kv">
        <div><span>Title</span><b dir="auto">{v.stem}</b></div>
        <div><span>Length</span><b className="mono">{tc(v.duration)}</b></div>
        <div><span>Size</span><b>{bytes(v.size)}</b></div>
        <div><span>File</span><b className="mono" dir="auto">{v.path}</b></div>
        <div><span>Takes</span><b>{p.runs.length}</b></div>
      </div>
    </div>
  );
}

// ── Transcript ─────────────────────────────────────────────────────

function TranscriptPanel({ p, jobs, run, stop, toast }: PanelProps) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [q, setQ] = useState("");
  const [now, setNow] = useState(0);
  const [noting, setNoting] = useState<number | null>(null);
  const [track, setTrack] = useState<"audio" | "vision">("audio");
  const shots = useShots(p.video.name, p.video.vision?.shots);
  const activeShot = shots.findIndex((s) => now >= s.start && now < s.end);
  const [noteText, setNoteText] = useState("");
  const vid = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const job = p.transcribe.job;

  // timeupdate only fires ~4x a second, which makes the highlight trail the voice; poll every frame while playing.
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      setNow(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    const start = () => (cancelAnimationFrame(raf), (raf = requestAnimationFrame(tick)));
    const stopLoop = () => cancelAnimationFrame(raf);
    v.addEventListener("play", start);
    v.addEventListener("pause", stopLoop);
    v.addEventListener("ended", stopLoop);
    return () => {
      stopLoop();
      v.removeEventListener("play", start);
      v.removeEventListener("pause", stopLoop);
      v.removeEventListener("ended", stopLoop);
    };
  }, [segs.length > 0]);

  const load = () => actions.transcript(p.video.name).then((d) => (setSegs(d.segments), setNotes(d.notes))).catch(() => {});
  useEffect(() => {
    load();
  }, [p.video.name, p.video.transcript?.segments]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return segs.map((s, i) => ({ s, i })).filter(({ s }) => !needle || s.text.toLowerCase().includes(needle));
  }, [segs, q]);
  const active = segs.findIndex((s) => now >= s.start && now < s.end);

  useEffect(() => {
    if (!follow.current || active < 0) return;
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const play = (t: number) => {
    const v = vid.current;
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
    follow.current = true;
  };
  const saveNote = async (t: number) => {
    if (!noteText.trim()) return;
    try {
      const n = await actions.note(p.video.name, t, noteText);
      setNotes((prev) => [...prev, n].sort((a, b) => a.t - b.t));
      setNoting(null);
      setNoteText("");
    } catch (e) {
      toast(String((e as Error).message), "err");
    }
  };

  if (!p.video.transcript && !job) {
    return (
      <div className="stack">
        <div className="empty-panel">
          <p>No transcript yet. The Transcriber splits the audio into two-minute chunks and transcribes each in its original language.</p>
          <button className="btn primary" onClick={() => run("transcribe")}>▶ Transcribe {tc(p.video.duration)} of audio</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {job && (job.status === "running" || job.status !== "done") && <JobCard job={job} onStop={stop} />}
      <div className="sticky-player">
        <video ref={vid} className="player small" src={fileUrl(p.video.path)} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
        <div className="seg-tabs">
          <button className={track === "audio" ? "on" : ""} onClick={() => setTrack("audio")}>Audio · {segs.length} lines</button>
          <button className={track === "vision" ? "on" : ""} onClick={() => setTrack("vision")} disabled={!shots.length}>
            Vision · {shots.length ? `${shots.length} shots` : "not built yet"}
          </button>
        </div>
        <div className="search" style={track === "vision" ? { display: "none" } : undefined}>
          <input dir="auto" placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="mono faint">{q ? `${shown.length} hits` : `${segs.length} lines · ${notes.length} notes`}</span>
        </div>
      </div>
      {track === "vision" && (
        <div className="shots">
          <div className="hint" style={{ padding: "2px 4px 6px" }}>
            Shot changes are measured from the video. Labels come from a vision model. The dot is its rough guess at the main
            subject's position, and the dashed band is what a centred 9:16 crop keeps.
          </div>
          {shots.map((s, i) => (
            <button key={s.id} className={`shot-line ${i === activeShot ? "now" : ""} ${s.cont ? "cont" : ""}`} onClick={() => play(s.start)}
              ref={i === activeShot ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}>
              <span className="shot-img">
                <img src={fileUrl(s.frame)} alt="" loading="lazy" />
                {s.subject_x !== undefined && <i className="subject" style={{ left: `${s.subject_x * 100}%` }} />}
              </span>
              <span className="shot-info">
                <span className="row">
                  <span className="mono faint">{tcms(s.start)}</span>
                  <span className={`kind k-${s.kind ?? "other"}`}>{KIND_LABEL[s.kind ?? ""] ?? s.kind ?? "unlabelled"}</span>
                  {!cropSafe(s.subject_x) && <span className="warn-text" title="Main subject sits outside a centred 9:16 crop">off-centre</span>}
                </span>
                <span className="shot-desc">{s.desc}</span>
                {s.text && <span className="shot-text ar" dir="auto">“{s.text}”</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="lines" ref={listRef} onWheel={() => (follow.current = false)} style={track === "vision" ? { display: "none" } : undefined}>
        {shown.map(({ s, i }) => {
          const pinned = notes.filter((n) => n.t >= s.start && n.t < s.end);
          return (
            <div key={i} data-i={i} className={`line ${i === active ? "now" : ""}`}>
              <button className={`line-t mono ${s.timing === "aligned" ? "measured" : ""}`} onClick={() => play(s.start)}
                title={s.timing === "aligned" ? `Measured: ${tcms(s.start)} → ${tcms(s.end)}` : "Estimated time"}>
                {s.timing === "aligned" ? tcms(s.start) : tc(s.start)}
              </button>
              <div className="line-body">
                <div className="line-text ar" dir="rtl" onClick={() => play(s.start)}>
                  {i === active && s.words?.length
                    ? s.words.map((w, k) => (
                        <span key={k} className={`word ${now >= w.start && now < w.end ? "on" : now >= w.end ? "past" : ""}`}
                          onClick={(e) => (e.stopPropagation(), play(w.start))}>{w.w} </span>
                      ))
                    : s.text}
                </div>
                {pinned.map((n) => (
                  <div key={n.id} className="note">
                    <span dir="auto">📌 {n.text}</span>
                    <button className="linkish" onClick={() => actions.unnote(p.video.name, n.id).then(load)}>remove</button>
                  </div>
                ))}
                {noting === i ? (
                  <div className="comment-input">
                    <textarea autoFocus rows={1} dir="auto" value={noteText} placeholder="e.g. great hook here, or: skip this tangent"
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveNote(s.start); }
                        if (e.key === "Escape") setNoting(null);
                      }} />
                    <button className="btn sm" onClick={() => saveNote(s.start)}>Pin</button>
                  </div>
                ) : (
                  <button className="add-note linkish" onClick={() => (setNoting(i), setNoteText(""))}>+ note</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Plan ───────────────────────────────────────────────────────────

function PlanPanel({ p, lib, run, stop, selectRun, refresh }: PanelProps) {
  const [tab, setTab] = useState<"takes" | "history">("takes");
  const [direction, setDirection] = useState("");
  const [count, setCount] = useState<string>("");
  const [engine, setEngine] = useState<Engine>(p.engine);
  useEffect(() => setEngine(p.engine), [p.engine]);
  const job = p.plan.job;
  const history = lib.history[0];
  const [historyText, setHistoryText] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "history") return;
    fetch(`/api/file?path=${encodeURIComponent(history?.path ?? "clips/history.md")}`).then((r) => r.text()).then(setHistoryText);
  }, [tab, history?.path]);

  return (
    <div className="stack">
      <div className="seg-tabs">
        {(["takes", "history"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t === "takes" ? `Takes (${p.runs.length})` : "History"}</button>
        ))}
      </div>

      {tab === "takes" && (
        <>
          <div className="card stack-sm">
            <div className="label">Direction for the next take</div>
            <textarea className="field" rows={3} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)}
              placeholder="Optional. e.g. focus on the buffalo section; more jokes, fewer statistics; shorter clips" />
            <div className="engine-pick">
              {(["classic", "hybrid", "jev", "webmcp"] as const).map((e) => (
                <button key={e} className={`${engine === e ? "on" : ""} e-${e}`} onClick={() => setEngine(e)}>
                  <b>{e === "classic" ? "LLM planner" : ENGINE_NAME[e]}</b>
                  <span>{e === "webmcp"
                    ? "No OpenRouter. The agent in your browser reads the transcripts through WebMCP tools and calls submit_plan; Clipdesk validates it."
                    : e === "classic"
                    ? "An LLM reads the whole transcript and writes titles, hooks and reasons."
                    : e === "hybrid"
                    ? "An LLM reads your outline once and writes Jev's questions, weights, tones and edit guidance. Jev scores every candidate and designs the edits; the LLM titles the winners."
                    : "Code proposes every opening, ending and window; Jev scores each with fixed questions; the best non-overlapping clips win. About 1,000 decisions for a few cents, with reasons shown as scores."}</span>
                </button>
              ))}
            </div>
            <div className="row">
              <label className="label" style={{ margin: 0 }}>Clips</label>
              <input className="field num" type="number" min={1} max={20} placeholder="outline" value={count} onChange={(e) => setCount(e.target.value)} />
              <span className="grow" />
              {engine === "webmcp" ? (
                <span className="hint">Your browser agent submits plans with <code>submit_plan</code>. Open the Agent panel to watch.</span>
              ) : p.plan.state === "running" && job ? (
                <button className="btn danger" onClick={() => stop(job.id)}>■ Stop planning</button>
              ) : (
                <button className="btn primary" disabled={p.plan.state === "locked"}
                  onClick={() => run("plan", { engine, ...(direction.trim() ? { notes: direction.trim() } : {}), ...(count ? { count: Number(count) } : {}) })}>
                  ▶ {p.runs.length ? "Plan a new take" : "Plan clips"}
                </button>
              )}
            </div>
            <div className="hint">The Planner also reads your transcript notes and every comment, keep and drop from earlier takes.</div>
          </div>
          {job && <JobCard job={job} onStop={stop} defaultOpen={job.status !== "done"} />}
          {p.runs.map((r, i) => (
            <button key={r.id} className={`take ${p.run?.id === r.id ? "on" : ""}`} onClick={() => selectRun(r.id)}>
              <div className="row">
                <b>Take {p.runs.length - i}</b>
                <span className="mono faint">{r.created}</span>
                <span className="grow" />
                <span className={`engine-tag ${r.engine}`}>{r.engine === "jev" ? "Jev" : r.engine === "hybrid" ? "Hybrid" : r.engine === "webmcp" ? "Agent" : "LLM"}</span>
                {r.review.approved ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>approved</span> : <span className="tag">in review</span>}
              </div>
              {r.jev && (
                <div className="hint mono">
                  {r.jev.stats.calls} decisions · {r.jev.stats.candidates} candidates judged · ${r.jev.stats.cost.toFixed(3)}{r.jev.direction ? ` · direction: "${r.jev.direction}"` : ""}
                </div>
              )}
              <div className="take-clips">
                {r.clips.map((c) => <span key={c.id} dir="auto" className={r.review.clips[c.id]?.status ?? ""}>{c.id}. {c.title}</span>)}
              </div>
              {r.jev?.brief?.source === "llm" && p.run?.id === r.id && <BriefView b={r.jev.brief} />}
              {r.jev && p.run?.id === r.id && r.jev.alternatives.length > 0 && (
                <details className="runners" onClick={(e) => e.stopPropagation()}>
                  <summary>Runner-ups Jev also liked ({r.jev.alternatives.length})</summary>
                  {r.jev.alternatives.map((a, i) => (
                    <div key={i} className="runner">
                      <span className="mono">{tc(a.start)}–{tc(a.end)}</span>
                      <Bar v={a.overall} />
                      <span className="ar" dir="rtl">{a.opening}</span>
                    </div>
                  ))}
                </details>
              )}
            </button>
          ))}
        </>
      )}

      {tab === "history" && historyText !== null && (
        <TextEditor path={history?.path ?? "clips/history.md"} initial={historyText} onSaved={refresh}
          save={(t) => putText(`/api/file?path=${encodeURIComponent(history?.path ?? "clips/history.md")}`, t)}
          hint={<>Every cut is logged here. Fill in <code>Performance</code> after posting; the Planner learns from it.</>} />
      )}
    </div>
  );
}

/** What the Hybrid LLM compiled from the outline for Jev. */
function BriefView({ b, open }: { b: JevBrief; open?: boolean }) {
  const sections: [string, JevBrief["opener"]][] = [["Every opening line", b.opener], ["Every closing line", b.ending], ["Every candidate clip", b.window]];
  const gate = (k: string) => b.gates.find((g) => g.key === k)?.min;
  return (
    <details className="runners brief" open={open} onClick={(e) => e.stopPropagation()}>
      <summary>The brief the LLM wrote for Jev{b.model ? ` · ${b.model.split("/")[1]}` : ""}</summary>
      <div className="hint" dir="auto">{b.summary}</div>
      {sections.map(([title, qs]) => (
        <div key={title} className="brief-sec">
          <div className="label">{title}</div>
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
        <div className="label">Tones</div>
        <div className="design-chips">
          {Object.entries(b.tones).map(([k, v]) => <span key={k} title={v} className={b.preferredTones.includes(k) ? "pref" : ""}>{k.replace(/_/g, " ")}</span>)}
        </div>
      </div>
      {Object.keys(b.zoomGuide).length + Object.keys(b.transitionGuide).length > 0 && (
        <div className="brief-sec">
          <div className="label">Edit guidance for the Designer</div>
          {[...Object.entries(b.zoomGuide), ...Object.entries(b.transitionGuide)].map(([k, v]) => (
            <div key={k} className="brief-q"><b>{k.replace("_", " ")}</b><span dir="auto">{v}</span></div>
          ))}
        </div>
      )}
    </details>
  );
}

// ── Brief (LLM) ────────────────────────────────────────────────────

function BriefPanel({ p, run: runStage, stop }: PanelProps) {
  const info = p.video.brief;
  const [cache, setCache] = useState<{ at: number; cost: number; brief: JevBrief } | null>(null);
  useEffect(() => {
    actions.briefOf(p.video.name).then(setCache).catch(() => setCache(null));
  }, [p.video.name, info?.at]);
  const job = p.brief.job;
  const running = p.brief.state === "running";
  return (
    <div className="stack">
      {!p.brief.active && (
        <div className="card hint">
          The brief is used by the <b>Hybrid</b> engine (top bar). In {p.engine === "classic" ? "LLM" : p.engine === "jev" ? "System One" : "WebMCP"} mode the outline goes to the Planner unchanged. You can still compile it here to see what Jev would be asked.
        </div>
      )}
      <div className="card row">
        <div className="grow">
          <b>{info ? `${info.questions} questions for Jev` : "No brief for this video yet"}</b>
          <div className="hint">
            {info
              ? `${info.fresh ? "Compiled from the current outline" : "The outline changed since; the next Hybrid take recompiles it"} · ${info.model?.split("/")[1] ?? "default"} · $${info.cost.toFixed(3)} · ${new Date(info.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
              : "One LLM call reads the outline, your feedback and a sample of the transcript."}
          </div>
        </div>
        {running && job?.agent === "brief" ? (
          <button className="btn danger" onClick={() => stop(job.id)}>■ Stop</button>
        ) : (
          <button className="btn primary" disabled={running || !p.video.transcript} onClick={() => runStage("brief")}>{info ? "↻ Recompile" : "▶ Compile brief"}</button>
        )}
      </div>
      {job && <JobCard job={job} onStop={stop} defaultOpen={job.status === "running"} />}
      {cache?.brief && <BriefView b={cache.brief} open />}
    </div>
  );
}

// ── Clip transcript ────────────────────────────────────────────────

function WatchPanel({ p, run: runStage, stop }: PanelProps) {
  const w = p.watch;
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${Math.round(v * 100)}%`);
  if (!w.clips.length) return <div className="empty-panel"><p>No finished clips in this take yet. Cut them first.</p></div>;
  const job = w.job;
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{w.watched}/{w.clips.length} finished clips watched</b>
          <div className="hint">Whisper on the audio (about $0.001 a clip), a frame every ~3 s with local face detection, and one cheap vision check per clip. The coach runs this itself for its evidence.</div>
        </div>
        {w.state === "running" && job?.agent === "watch" ? (
          <button className="btn danger" onClick={() => stop(job.id)}>■ Stop</button>
        ) : (
          <button className="btn primary" disabled={w.state === "running"} onClick={() => runStage("watch", w.state === "done" ? { force: true } : {})}>{w.state === "done" ? "↻ Re-watch" : "▶ Watch clips"}</button>
        )}
      </div>
      {job && <JobCard job={job} onStop={stop} defaultOpen={job.status === "running"} />}
      {w.clips.map((c) => {
        const x = c.watch;
        return (
          <div key={c.id} className="card stack-sm watch-clip">
            <div className="row"><span className="clip-num">{c.id}</span><span className="clip-title grow" dir="auto">{c.title}</span>{x && !x.fresh && <span className="tag">re-cut since</span>}</div>
            {!x ? <div className="hint">Not watched yet.</div> : (
              <>
                <div className="watch-metrics">
                  <span title="Word overlap between Whisper on the finished clip and the source transcript. Two transcribers rarely agree on dialect, so 45-70% is normal; under 30% suggests lost or cut audio.">🔊 overlap <b>{pc(x.metrics.script_match)}</b></span>
                  <span title="Frames where every detected face is fully inside the frame">🙂 faces in frame <b>{pc(x.metrics.faces_ok)}</b></span>
                  <span title="Frames with someone cut off by the edge">✂ cut off <b>{x.metrics.cut_off}</b></span>
                  <span title="Frames where captions are readable and don't cover a face">💬 captions ok <b>{pc(x.metrics.captions_ok)}</b></span>
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
                {x.audio && <div className="watch-heard" dir="auto">{x.audio.text}</div>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Rubric (LLM) ───────────────────────────────────────────────────

function RubricPanel({ p, run: runStage, stop }: PanelProps) {
  const r = p.rubric;
  const rb = r.rubric;
  const [direction, setDirection] = useState("");
  const job = r.job;
  return (
    <div className="stack">
      {!r.active && (
        <div className="card hint">
          The rubric is the <b>Hybrid</b> coach's LLM step. In {p.coach.by === "llm" ? "LLM mode the coach is one LLM call that reads the evidence itself" : p.coach.by === "jev" ? "System One mode Jev rates one rule per outline section and proposes no rewrites" : "WebMCP mode the coach isn't available"}.
        </div>
      )}
      {r.active && (
        <div className="card stack-sm">
          <div className="label">Direction for the rubric (optional)</div>
          <textarea className="field" rows={2} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)} placeholder="e.g. focus on the endings; captions feel too busy" />
          <div className="row">
            <span className="hint grow">The coach rewrites the rubric every time it runs. Writing it here lets you inspect it first.</span>
            {r.state === "running" && job?.agent === "rubric" ? (
              <button className="btn danger" onClick={() => stop(job.id)}>■ Stop</button>
            ) : (
              <button className="btn primary" disabled={r.state === "running" || r.state === "locked"} onClick={() => runStage("rubric", direction.trim() ? { direction: direction.trim() } : {})}>{rb?.source === "llm" ? "↻ Rewrite rubric" : "▶ Write rubric"}</button>
            )}
          </div>
        </div>
      )}
      {job && <JobCard job={job} onStop={stop} defaultOpen={job.status === "running"} />}
      {rb && (
        <>
          <div className="card stack-sm">
            <div className="row">
              <b className="grow">{rb.source === "llm" ? "Rules the LLM wrote for Jev" : "System One rules (one per section)"}</b>
              <span className="mono faint">{rb.model?.split("/")[1] ?? "no LLM"} · {rb.fresh ? "current outline" : "older outline"}</span>
            </div>
            {rb.diagnosis && <div className="hypo" dir="auto">{rb.diagnosis}</div>}
            {rb.rules.map((q) => (
              <div key={q.key} className="brief-q-row">
                <span className="tag">{q.section || "general"}</span>
                <b dir="auto">{q.rule}</b>
                <span className="hint" dir="auto">Jev rates: {q.question}</span>
              </div>
            ))}
          </div>
          {rb.sections.map((s) => (
            <div key={s.section} className="card stack-sm">
              <div className="row"><b className="grow">Rewrites for “{s.section}”</b></div>
              <div className="hint" dir="auto">{s.why}</div>
              {s.variants.map((v) => (
                <details key={v.key} className="variant">
                  <summary><span className="mono">{v.key}</span> <span dir="auto">{v.summary}</span></summary>
                  <pre dir="auto">{v.text}</pre>
                </details>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** Jev's judgement of the current outline: rules followed, and the rewrites it chose. */
function ScorecardView({ sc }: { sc: import("./api").Scorecard }) {
  const pc = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}`);
  return (
    <div className="card stack-sm">
      <div className="row">
        <b className="grow">Jev scorecard</b>
        <span className="mono faint">{sc.calls} decisions · {sc.clips.length} clips ({sc.clips.filter((c) => c.watched).length} watched) · ${sc.cost.toFixed(3)}</span>
      </div>
      <div className="hint">How often the clips follow each rule, and the average on clips you kept or liked vs dropped or disliked. A rule the good clips follow and the bad ones don't is one that works.</div>
      <div className="sc-head"><span>Rule</span><span>followed</span><span>kept</span><span>dropped</span></div>
      {[...sc.rules].sort((a, b) => a.followed - b.followed).map((r) => (
        <div key={r.key} className="sc-row">
          <span dir="auto" title={r.section}>{r.rule}</span>
          <span className="sc-bar"><Bar v={r.followed} /><span className="mono">{pc(r.followed)}</span></span>
          <span className="mono">{pc(r.good)}</span>
          <span className="mono">{pc(r.bad)}</span>
        </div>
      ))}
      {sc.decisions.length > 0 && (
        <>
          <div className="label">Jev's choices between the rubric's rewrites</div>
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

// ── Outline coach ──────────────────────────────────────────────────

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
function LineDiff({ a, b }: { a: string; b: string }) {
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

function CoachPanel({ p, lib, run: runStage, stop, refresh, toast }: PanelProps) {
  const c = p.coach;
  const [direction, setDirection] = useState("");
  const guard = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const job = c.job;
  const pending = c.pending;
  const outcomes = lib.coach?.outcomes ?? {};
  return (
    <div className="stack">
      {pending ? (
        <div className="card stack-sm proposal">
          <div className="row">
            <b className="grow">Proposed outline{pending.mode === "hybrid" ? " · rewrites chosen by Jev" : pending.mode === "jev" ? " · Jev" : ""}</b>
            <span className="mono faint">{pending.model.split("/")[1]} · ${pending.cost.toFixed(3)}</span>
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
          <LineDiff a={lib.outline} b={pending.outline} />
          <div className="row">
            <button className="btn" onClick={() => guard(() => actions.discardProposal(pending.id), "Proposal discarded")}>Discard</button>
            <span className="grow" />
            <button className="btn" onClick={() => guard(() => actions.applyProposal(pending.id), "Outline updated")}>✓ Apply</button>
            <button className="btn primary" disabled={p.plan.state === "running"} onClick={() => guard(async () => { await actions.applyProposal(pending.id); runStage("plan"); }, "Outline updated. Planning a new take with it.")}>✓ Apply and plan a new take</button>
          </div>
        </div>
      ) : (
        <div className="card stack-sm">
          <div className="label">Direction for the coach (optional)</div>
          <textarea className="field" rows={2} dir="auto" value={direction} onChange={(e) => setDirection(e.target.value)}
            placeholder="e.g. the endings keep cutting mid-laugh; I want quieter clips" />
          <div className="row">
            <span className="hint grow">{c.by === "llm"
              ? "LLM mode: one LLM call reads this video's takes, a few reviewed takes from other videos, the clip transcripts, the best earlier outline versions and what earlier edits did."
              : c.by === "hybrid"
              ? "Hybrid: watches the finished clips, the LLM writes a rubric and rewrites, Jev rates every clip on every rule and picks the rewrites."
              : "System One: watches the finished clips and Jev rates them on one rule per outline section. A scorecard, no rewrites."}</span>
            {c.state === "running" && job ? (
              <button className="btn danger" onClick={() => stop(job.id)}>■ Stop</button>
            ) : (
              <button className="btn primary" disabled={c.state === "locked"} onClick={() => runStage("coach", direction.trim() ? { direction: direction.trim() } : {})}>{c.by === "jev" ? "▶ Score the outline" : "▶ Propose a better outline"}</button>
            )}
          </div>
        </div>
      )}
      {job && <JobCard job={job} onStop={stop} defaultOpen={job.status !== "done"} />}
      {c.scorecard && c.scorecard.outline_hash === c.current?.hash && <ScorecardView sc={c.scorecard} />}

      <div className="card stack-sm">
        <div className="label">Outline versions</div>
        <div className="hint">One-shot score per version: share of clips kept (👎 on a finished clip counts as a drop), ×0.85 if the take wasn't approved, ×0.9 per clip you nudged, ×0.95 per comment on a clip you didn't 👍. Unreviewed takes don't count. Rating finished clips in the Clips panel is the strongest signal.</div>
        {[...c.versions].reverse().map((v) => (
          <div key={v.hash} className={`ver-row ${v.hash === c.current?.hash ? "on" : ""}`}>
            <b>{v.label}</b>
            <span className={`engine-tag ${v.source === "coach" ? "coach" : ""}`}>{v.source === "coach" ? "coach" : "you"}</span>
            <span className="faint">{v.rated}/{v.takes} reviewed</span>
            <span className="grow" />
            <Bar v={(v.mean ?? 0) / 100} />
            <span className="mono">{v.mean ?? "–"}</span>
            {v.hash === c.current?.hash ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>current</span>
              : <button className="btn sm" onClick={() => guard(() => actions.restoreVersion(v.hash), `Restored ${v.label}`)}>Restore</button>}
          </div>
        ))}
      </div>

      <div className="card stack-sm">
        <div className="label">This video's takes</div>
        {p.runs.map((r, i) => {
          const o = outcomes[r.id];
          const v = c.versions.find((x) => x.hash === o?.hash);
          return (
            <div key={r.id} className="ver-row">
              <b>Take {p.runs.length - i}</b>
              <span className="mono faint">{r.created}</span>
              <span className="faint">{v ? `outline ${v.label}` : "outline not recorded"}</span>
              <span className="grow" />
              <span className="mono">{o?.score ?? "not reviewed"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Edit design ────────────────────────────────────────────────────

function Odds({ options, chosen }: { options: Record<string, number>; chosen: string }) {
  const top = Object.entries(options).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return (
    <span className="odds">
      {top.map(([k, v]) => <span key={k} className={k === chosen ? "on" : ""}>{k.replace("_", " ")} {Math.round(v * 100)}%</span>)}
    </span>
  );
}

function DesignPanel({ p, run: runStage, stop }: PanelProps) {
  const run = p.run;
  if (!run) return <div className="empty-panel"><p>No plan yet. The Designer works on a take once the Planner has one.</p></div>;
  if (p.design.by !== "jev") {
    return (
      <div className="empty-panel">
        <p>{p.design.by === "llm" ? "This take was planned by the LLM, which wrote its edits (cuts, moves, transitions) in the same pass." : "Your browser agent wrote this take's edits when it submitted the plan."}</p>
        <p className="hint">Plan a take with Hybrid or System One to have Jev design edits here. You can still inspect and toggle each clip's edit in Review.</p>
      </div>
    );
  }
  const d: DesignRun | null = run.design;
  const job = p.design.job;
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{d ? `${p.design.decisions} decisions` : "Not designed yet"}</b>
          <div className="hint">
            {d
              ? `${d.guide === "llm" ? "Guidance compiled from your outline" : "Standard guidance"} · ${new Date(d.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · $${d.cost.toFixed(3)}${d.mode === "hybrid" ? " · titles by the LLM" : ""}`
              : "The take has the automatic edit (pauses removed, standard moves). Jev can choose moves and transitions per part."}
          </div>
        </div>
        {p.design.state === "running" && job?.agent === "design" ? (
          <button className="btn danger" onClick={() => stop(job.id)}>■ Stop</button>
        ) : (
          <button className="btn primary" disabled={p.design.state === "running" || p.design.state === "locked"} onClick={() => runStage("design")}>{d ? "↻ Redesign" : "▶ Design edits"}</button>
        )}
      </div>
      {run.review.approved && <div className="hint warn-text">Redesigning an approved take sends it back to review.</div>}
      {job && <JobCard job={job} onStop={stop} defaultOpen={job.status === "running"} />}
      {d && run.clips.map((c) => {
        const cd = d.clips[c.id];
        if (!cd || !c.edit) return null;
        return (
          <div key={c.id} className="card stack-sm design-clip">
            <div className="row"><span className="clip-num">{c.id}</span><span className="clip-title grow" dir="auto">{c.title}</span>{cd.titles && <span className="engine-tag hybrid">LLM title</span>}</div>
            {c.edit.title && <div className="clip-ost" dir="auto">{c.edit.title}</div>}
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
                    <b>{(s.zoom ?? "none").replace("_", " ")}</b>
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
            {c.edit.emphasis?.length ? <div className="hint" dir="auto">Emphasis: {c.edit.emphasis.join("، ")}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Review ─────────────────────────────────────────────────────────

function ClipPreview({ video, clip, vertical }: { video: Pipeline["video"]; clip: Clip; vertical: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [t, setT] = useState(0);
  const start = () => {
    setOn(true);
    requestAnimationFrame(() => {
      const v = ref.current;
      if (!v) return;
      v.currentTime = clip.start;
      v.play().catch(() => {});
    });
  };
  return (
    <div className={`preview ${vertical ? "tall" : ""}`}>
      {on ? (
        <video
          ref={ref}
          src={fileUrl(video.path)}
          controls
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            setT(v.currentTime);
            if (v.currentTime >= clip.end) { v.pause(); v.currentTime = clip.start; }
          }}
        />
      ) : (
        <button className="poster" style={{ backgroundImage: `url("${thumbUrl(video.name, clip.start + 1)}")` }} onClick={start} title="Play this clip from the source">
          <span>▶</span>
        </button>
      )}
      {on && <div className="preview-bar"><i style={{ width: `${Math.min(100, Math.max(0, ((t - clip.start) / (clip.end - clip.start)) * 100))}%` }} /></div>}
    </div>
  );
}

function Nudge({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
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

function ReviewPanel({ p, refresh, ask, approve, toast }: PanelProps) {
  const run = p.run;
  if (!run) return <div className="empty-panel"><p>No plan yet. Plan clips first, then review them here.</p></div>;
  return <ReviewBody key={run.id} run={run} p={p} refresh={refresh} ask={ask} approve={approve} toast={toast} />;
}

function Bar({ v, warn = 0.5 }: { v: number; warn?: number }) {
  return <span className={`bar ${v < warn ? "low" : ""}`}><i style={{ width: `${Math.round(v * 100)}%` }} /></span>;
}

const SCORE_ROWS: [keyof JevScores, string][] = [
  ["hook", "Hook"], ["cold", "Works cold"], ["payoff", "Lands"], ["complete", "Ends clean"],
  ["fit", "Fits outline"], ["standalone", "Stands alone"], ["respectful", "Respectful"],
];

function JevBreakdown({ s }: { s: JevScores }) {
  return (
    <div className="jev-box">
      <div className="jev-head">
        <span className="engine-tag jev">Jev</span>
        <b>{Math.round(s.overall * 100)}</b><span className="faint">overall</span>
        <span className="grow" />
        <span className="tone">{s.tone.key.replace("_", " ")} {Math.round(s.tone.p * 100)}%</span>
      </div>
      <div className="scores">
        {s.rows
          ? s.rows.map((r) => (
            <div key={r.key} className="score"><span dir="auto">{r.label}</span><Bar v={r.value} /><span className="mono">{Math.round(r.value * 100)}</span></div>
          ))
          : SCORE_ROWS.map(([k, label]) => (
            <div key={k} className="score"><span>{label}</span><Bar v={s[k] as number} /><span className="mono">{Math.round((s[k] as number) * 100)}</span></div>
          ))}
        {s.visual !== undefined && <div className="score"><span>Visuals</span><Bar v={s.visual} /><span className="mono">{Math.round(s.visual * 100)}</span></div>}
        {s.vertical !== undefined && <div className="score"><span>9:16-safe</span><Bar v={s.vertical} /><span className="mono">{Math.round(s.vertical * 100)}</span></div>}
        {s.direction !== undefined && <div className="score"><span>Your direction</span><Bar v={s.direction} /><span className="mono">{Math.round(s.direction * 100)}</span></div>}
        {s.against !== undefined && s.against > 0.3 && <div className="score warn"><span>Against feedback</span><Bar v={s.against} warn={2} /><span className="mono">{Math.round(s.against * 100)}</span></div>}
      </div>
      {s.repeat && <div className="hint">Overlaps a moment from an earlier take (scored down 30%).</div>}
    </div>
  );
}

function EdgeQa({ q, clip, apply }: { q: EdgeCheck; clip: Clip; apply: (patch: { start?: number; end?: number }) => void }) {
  const stale = Math.abs(q.start - clip.start) > 0.05 || Math.abs(q.end - clip.end) > 0.05;
  if (stale) return <div className="qa stale hint">Edges changed since the last Jev check. Run it again to refresh.</div>;
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

function ReviewBody({ run, p, refresh, ask, approve, toast }: { run: Run } & Pick<PanelProps, "p" | "refresh" | "ask" | "approve" | "toast">) {
  const vertical = run.aspect !== "16:9";
  const shots = useShots(p.video.name, p.video.vision?.shots);
  const guard = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  const kept = run.clips.filter((c) => run.review.clips[c.id]?.status !== "drop");
  const approved = run.review.approved;

  return (
    <div className="stack">
      <div className={`gate-card ${approved ? "ok" : p.gate ? "wait" : ""}`}>
        <div>
          <b>{approved ? "Approved" : p.gate ? "Waiting for your approval" : "Gate is off"}</b>
          <div className="hint">
            {approved
              ? "The Editor may cut these clips. Unapprove to stop further cuts."
              : p.gate
                ? `${kept.length} of ${run.clips.length} clips will be cut. The Director can't cut anything until you approve.`
                : "Plans go straight to cutting. Turn the gate on in the top bar to review first."}
          </div>
        </div>
        {approved ? (
          <button className="btn" onClick={() => approve(false)}>Unapprove</button>
        ) : (
          <button className="btn primary" disabled={!kept.length} onClick={() => approve(true)}>✓ Approve {kept.length}</button>
        )}
      </div>

      <div className="row check-row">
        <span className={`engine-tag ${run.engine}`}>{run.engine === "jev" ? "Planned by Jev" : run.engine === "hybrid" ? "Planned by LLM + Jev" : run.engine === "webmcp" ? "Planned by your browser agent" : "Planned by LLM"}</span>
        <span className="hint grow">{run.qa ? `Jev edge check at ${new Date(run.qa.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : p.engine === "webmcp" ? "" : "Jev can check each clip's in and out points."}</span>
        {p.engine !== "webmcp" && <button className="btn sm" onClick={() => guard(() => actions.check(run.id))}>{run.qa ? "Re-check edges" : "Run Jev edge check"}</button>}
      </div>

      <div className="card stack-sm">
        <div className="label">Notes on this whole take</div>
        <Thread
          comments={run.review.comments}
          placeholder="e.g. too many sad clips; want one that's pure comedy"
          onAdd={(text) => guard(() => actions.comment(run.id, text))}
          onDelete={(id) => guard(() => actions.uncomment(run.id, id))}
          onSendToDirector={(text) => ask(`About take "${run.id}": ${text}`)}
        />
      </div>

      {run.clips.map((c) => {
        const r = run.review.clips[c.id];
        const dropped = r?.status === "drop";
        const set = (patch: Parameters<typeof actions.clip>[2]) => guard(() => actions.clip(run.id, c.id, patch));
        return (
          <div key={c.id} className={`card rclip ${dropped ? "dropped" : ""}`}>
            <div className="rclip-top">
              <ClipPreview video={p.video} clip={c} vertical={vertical} />
              <div className="rclip-info">
                <div className="row">
                  <span className="clip-num">{c.id}</span>
                  <span className="grow" />
                  <div className="keepdrop">
                    <button className={r?.status === "keep" ? "on keep" : ""} onClick={() => set({ status: r?.status === "keep" ? null : "keep" })}>Keep</button>
                    <button className={dropped ? "on drop" : ""} onClick={() => set({ status: dropped ? null : "drop" })}>Drop</button>
                  </div>
                </div>
                <div className="clip-title" dir="auto">{c.title}</div>
                <div className="clip-time">{tc(c.start, true)} → {tc(c.end, true)} · {(c.end - c.start).toFixed(1)}s{c.file ? " · cut" : ""}</div>
                {c.on_screen_text && <div className="clip-ost" dir="auto">{c.on_screen_text}</div>}
                {c.reason && <div className="clip-why" dir="auto">{c.reason}</div>}
              </div>
            </div>
            <ShotStrip shots={shots} start={c.start} end={c.end} />
            {c.edit && <EditTimeline edit={c.edit} onToggle={(on) => set({ edit_enabled: on })} />}
            {run.jev?.clips[c.id] && <JevBreakdown s={run.jev.clips[c.id]} />}
            {!dropped && run.qa?.clips[c.id] && <EdgeQa q={run.qa.clips[c.id]} clip={c} apply={(patch) => set(patch)} />}
            {!dropped && (
              <div className="nudges">
                <Nudge label="In" value={c.edit && c.edit.enabled !== false ? c.edit.segments[0].start : c.start} onChange={(v) => set({ start: Math.max(0, v) })} />
                <Nudge label="Out" value={c.edit && c.edit.enabled !== false ? c.edit.segments[c.edit.segments.length - 1].end : c.end} onChange={(v) => set({ end: v })} />
              </div>
            )}
            <Thread
              compact
              comments={r?.comments ?? []}
              placeholder="Comment on this clip…"
              onAdd={(text) => guard(() => actions.comment(run.id, text, c.id))}
              onDelete={(id) => guard(() => actions.uncomment(run.id, id))}
              onSendToDirector={(text) => ask(`About clip ${c.id} ("${c.title}") of take "${run.id}": ${text}`)}
            />
          </div>
        );
      })}

      <div className="sticky-foot">
        <button className="btn" onClick={() => ask(`Read my feedback on take "${run.id}" and plan a revised take that addresses it.`)}>Ask Director to revise</button>
        <span className="grow" />
        {!approved && <button className="btn primary" disabled={!kept.length} onClick={() => approve(true)}>✓ Approve {kept.length} clips</button>}
      </div>
    </div>
  );
}

// ── Cut ────────────────────────────────────────────────────────────

function CutPanel({ p, run, stop, cutOpts, setCutOpts }: PanelProps) {
  const job = p.cut.job;
  const r = p.run;
  return (
    <div className="stack">
      <div className="card stack-sm">
        <div className="toggles big">
          <label><input type="checkbox" checked={cutOpts.subs} onChange={(e) => setCutOpts({ ...cutOpts, subs: e.target.checked })} /> Burn in Arabic captions</label>
          <label><input type="checkbox" checked={cutOpts.vertical} onChange={(e) => setCutOpts({ ...cutOpts, vertical: e.target.checked })} /> Crop to 9:16</label>
        </div>
        <div className="row">
          <span className="hint grow">{p.cut.state === "locked" ? "Approve the plan in Review first." : `${p.cut.cut}/${p.cut.total} kept clips cut.`}</span>
          {p.cut.state === "running" && job ? (
            <button className="btn danger" onClick={() => stop(job.id)}>■ Stop cutting</button>
          ) : (
            <button className="btn primary" disabled={p.cut.state === "locked"} onClick={() => run("cut")}>▶ {p.cut.cut ? "Re-cut all" : "Cut all"}</button>
          )}
        </div>
      </div>
      {job && <JobCard job={job} onStop={stop} defaultOpen />}
      {r?.clips.filter((c) => r.review.clips[c.id]?.status !== "drop").map((c) => (
        <div key={c.id} className={`cut-line ${p.cut.current === c.id ? "busy" : ""}`}>
          <span className="clip-num">{c.id}</span>
          <div className="grow">
            <div className="clip-title" dir="auto">{c.title}</div>
            <div className="clip-time">{tc(c.start)} → {tc(c.end)}</div>
            {p.cut.current === c.id && job && <Film value={job.progress} status="running" agent="extract" />}
          </div>
          {c.file ? <span className="tag" style={{ ["--c" as any]: "var(--ok)" }}>cut</span> : <span className="tag">pending</span>}
          <button className="btn sm" disabled={p.cut.state === "locked" || p.cut.state === "running"} onClick={() => run("cut", { only: [c.id] })}>{c.file ? "Re-cut" : "Cut"}</button>
        </div>
      ))}
    </div>
  );
}

// ── Clips ──────────────────────────────────────────────────────────

function ClipsPanel({ p, refresh, ask, run, toast }: PanelProps) {
  const r = p.run;
  if (!r || !p.clips.files.length) return <div className="empty-panel"><p>No clips cut yet for this take.</p></div>;
  const vertical = r.aspect !== "16:9";
  const guard = async (fn: () => Promise<unknown>) => {
    try { await fn(); refresh(); } catch (e) { toast((e as Error).message, "err"); }
  };
  return (
    <div className={`clip-wall ${vertical ? "tall" : ""}`}>
      {r.clips.filter((c) => c.file).map((c) => (
        <div key={c.id} className="card wall-item">
          <video src={fileUrl(c.file!)} controls preload="metadata" playsInline />
          <div className="clip-title" dir="auto">{c.id}. {c.title}</div>
          <div className="clip-time">{(c.end - c.start).toFixed(1)}s</div>
          <div className="row">
            <div className="keepdrop" title="Your verdict after watching. The Outline coach learns from it.">
              {([1, -1] as const).map((v) => {
                const on = r.review.clips[c.id]?.rating === v;
                return <button key={v} className={on ? `on ${v === 1 ? "keep" : "drop"}` : ""} onClick={() => guard(() => actions.clip(r.id, c.id, { rating: on ? null : v }))}>{v === 1 ? "👍" : "👎"}</button>;
              })}
            </div>
            <span className="grow" />
            <a className="btn sm" href={fileUrl(c.file!)} download>Download</a>
            <button className="btn sm ghost" onClick={() => run("cut", { only: [c.id] })}>Re-cut</button>
          </div>
          <Thread
            compact
            comments={r.review.clips[c.id]?.comments ?? []}
            placeholder="How did it land?"
            onAdd={(text) => guard(() => actions.comment(r.id, text, c.id))}
            onDelete={(id) => guard(() => actions.uncomment(r.id, id))}
            onSendToDirector={(text) => ask(`About finished clip ${c.id} ("${c.title}"): ${text}`)}
          />
        </div>
      ))}
    </div>
  );
}

