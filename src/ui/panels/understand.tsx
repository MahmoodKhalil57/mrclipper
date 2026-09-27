// Phase 2 · Understand: what the source says and shows (Transcript), and what the reference looks like (Reference style).
import { useEffect, useMemo, useRef, useState } from "react";
import { actions, fileUrl, type Note, type Segment } from "../api";
import { JobCard } from "../Common";
import { tc, tcms } from "../util";
import { KIND_LABEL, StepTrigger, cropSafe, nodeJob, useShots, type PanelProps } from "./shared";

export function TranscriptPanel(p: PanelProps & { focus?: "audio" | "vision" }) {
  const [segs, setSegs] = useState<Segment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [q, setQ] = useState("");
  const [now, setNow] = useState(0);
  const [noting, setNoting] = useState<number | null>(null);
  const [track, setTrack] = useState<"audio" | "vision">(p.focus ?? "audio");
  useEffect(() => setTrack(p.focus ?? "audio"), [p.focus]);
  const shots = useShots(p.video.name, p.video.vision?.shots);
  const activeShot = shots.findIndex((s) => now >= s.start && now < s.end);
  const [noteText, setNoteText] = useState("");
  const vid = useRef<HTMLVideoElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const job = nodeJob(p, p.focus === "vision" ? "shots" : "transcript");

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
      p.toast(String((e as Error).message), "err");
    }
  };

  if (!p.video.transcript && job?.status !== "running") {
    return (
      <div className="stack">
        <div className="empty-panel">
          <p>No transcript yet. The Transcriber writes the audio in its original language with measured word timings. What's on screen is the Shots step.</p>
          <button className="btn primary" onClick={() => p.step("transcript")}>▶ Transcribe {tc(p.video.duration)}</button>
        </div>
        {job && <JobCard job={job} onStop={p.stop} />}
      </div>
    );
  }

  return (
    <div className="stack">
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} />}
      <div className="sticky-player">
        <video ref={vid} className="player small" src={fileUrl(p.video.path)} controls preload="metadata" onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} />
        <div className="seg-tabs">
          <button className={track === "audio" ? "on" : ""} onClick={() => setTrack("audio")}>Audio · {segs.length} lines</button>
          <button className={track === "vision" ? "on" : ""} onClick={() => setTrack("vision")}>
            Vision · {shots.length ? `${shots.length} shots` : "not built yet"}
          </button>
        </div>
        <div className="search" style={track === "vision" ? { display: "none" } : undefined}>
          <input dir="auto" placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="mono faint">{q ? `${shown.length} hits` : `${segs.length} lines · ${notes.length} notes`}</span>
        </div>
      </div>
      {track === "vision" && !shots.length && (
        <div className="empty-panel">
          <p>No shots yet. Shots measures every cut in the video, has a vision model describe a frame from each shot, and measures faces for the 9:16 crop.</p>
          {nodeJob(p, "shots")?.status !== "running" && <button className="btn primary" onClick={() => p.step("shots")}>▶ Find shots</button>}
        </div>
      )}
      {track === "vision" && (
        <div className="shots">
          <div className="hint" style={{ padding: "2px 4px 6px" }}>
            Shot changes are measured from the video; labels come from a vision model. The dot is its rough guess at the main
            subject's position.
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

export function RefStylePanel(p: PanelProps) {
  const ref = p.lib.reference;
  const a = ref?.analysis;
  const job = nodeJob(p, "refstyle");
  const node = p.wf.nodes.refstyle;
  if (!ref) return <div className="empty-panel"><p>No reference clip. Add one in the Reference clip node if you want the clips to copy another clip's style.</p></div>;
  const rows: [string, string][] = a ? [
    ["Pacing", a.profile.pacing], ["Structure", a.profile.structure], ["Captions", a.profile.captions], ["Framing", a.profile.framing],
    ["Colour", a.profile.color], ["Effects", a.profile.effects], ["Transitions", a.profile.transitions], ["Titles", a.profile.title], ["Audio", a.profile.audio],
  ] : [];
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{a ? `${a.profile.traits.length} traits to copy` : "Not analysed yet"}</b>
          <div className="hint">{a ? `${a.model.split("/").pop()} · $${a.cost.toFixed(3)}${node.state === "stale" ? " · the copy guide changed since" : ""}` : "Whisper on the audio, cuts measured with ffmpeg, faces locally, then one multimodal call that watches and listens. About $0.01."}</div>
        </div>
        {job?.status === "running" ? <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
          : <StepTrigger p={p} id="refstyle" first="Analyse" again="Re-analyse" />}
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {a && (
        <>
          <div className="watch-metrics">
            <span>⏱ <b>{a.analysed.toFixed(0)}s</b>{a.analysed < a.duration ? ` of ${a.duration.toFixed(0)}s` : ""}</span>
            <span>✂ a cut every <b>{a.avg_shot.toFixed(1)}s</b></span>
            <span>🗣 <b>{a.words_per_min.toFixed(0)}</b> words/min</span>
            <span>⏸ <b>{a.pauses}</b> pauses</span>
            <span>▭ {a.width}×{a.height}</span>
          </div>
          <div className="card stack-sm">
            <div className="hypo" dir="auto">{a.profile.summary}</div>
            {rows.filter(([, v]) => v).map(([k, v]) => <div key={k} className="brief-q-row"><span className="tag">{k}</span><span dir="auto">{v}</span></div>)}
          </div>
          <div className="card stack-sm">
            <div className="label">Traits: the Brief makes these check rules</div>
            {a.profile.traits.map((t) => (
              <div key={t.key} className="brief-q-row">
                <span className="tag">{t.section}</span>
                <b dir="auto">{t.trait}</b>
                <span className="hint" dir="auto">Jev rates: {t.question}</span>
              </div>
            ))}
          </div>
          <div className="watch-frames">
            {a.frames.map((f) => <figure key={f.t}><img src={fileUrl(f.frame)} alt="" loading="lazy" /><figcaption className="mono">{f.t.toFixed(0)}s{f.faces ? ` · ${f.faces}🙂` : ""}</figcaption></figure>)}
          </div>
          {a.transcript && <div className="watch-heard" dir="auto">{a.transcript}</div>}
        </>
      )}
    </div>
  );
}
