// Phase 1 · Inputs: the source video, the outline, and the style reference (a clip + what to copy from it).
import { useEffect, useState } from "react";
import { actions, fileUrl, putText, thumbUrl, uploadVideo } from "../api";
import { JobCard, TextEditor } from "../Common";
import { bytes, tc } from "../util";
import { nodeJob, useGuard, type PanelProps } from "./shared";

export function SourcePanel(p: PanelProps) {
  const v = p.video;
  return (
    <div className="stack">
      <video className="player" src={fileUrl(v.path)} controls preload="metadata" poster={thumbUrl(v.name, v.duration * 0.18)} />
      <div className="card kv">
        <div><span>Title</span><b dir="auto">{v.stem}</b></div>
        <div><span>Length</span><b className="mono">{tc(v.duration)}</b></div>
        <div><span>Size</span><b>{bytes(v.size)}</b></div>
        <div><span>File</span><b className="mono" dir="auto">{v.path}</b></div>
        <div><span>Takes</span><b>{p.wf.takes.length}</b></div>
      </div>
      <div className="hint">Add another video with <b>+ Add video</b> in the top bar; each video is its own project.</div>
    </div>
  );
}

export function OutlinePanel(p: PanelProps) {
  const o = p.lib.outlines;
  const cur = o.versions.find((v) => v.hash === o.current);
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{cur ? `${cur.label}${cur.source === "coach" ? ", written by the coach" : ""}` : "Outline"}</b>
          <div className="hint">
            {cur?.mean !== null && cur?.mean !== undefined ? `One-shot ${cur.mean} over ${cur.rated} reviewed take${cur.rated === 1 ? "" : "s"}. ` : "Not scored yet: review a take made with it. "}
            {o.pending ? "The coach has a proposal for it (see Coach)." : ""}
          </div>
        </div>
      </div>
      <TextEditor path="clip_outline.md" initial={p.lib.outline} onSaved={p.refresh} save={(t) => putText("/api/outline", t)}
        hint={<>Who the clips are for and how to cut them. The Brief turns it into what Jev asks, and the renderer reads the bold settings like <code>**Number of clips:**</code> literally. A change makes the Brief and the next take out of date; takes already made keep the outline they were made with.</>} />
    </div>
  );
}

const GUIDE_IDEAS = ["the caption style", "the pacing and how fast it cuts", "the colour grade and effects", "how it hooks in the first seconds and how it ends", "the framing and zooms"];

/** The style reference: a finished clip to copy (Reference clip) and what to copy from it (Copy guide). */
export function ReferencePanel(p: PanelProps & { focus: "refclip" | "guide" }) {
  const ref = p.lib.reference;
  const guideNow = ref?.guide ?? p.lib.pendingGuide ?? "";
  const [guide, setGuideText] = useState(guideNow);
  const [url, setUrl] = useState("");
  const [up, setUp] = useState<number | null>(null);
  const guard = useGuard(p);
  const job = nodeJob(p, "refclip");
  useEffect(() => setGuideText(guideNow), [guideNow]);
  const upload = (f: File) => {
    setUp(0);
    uploadVideo(f, setUp, "/api/reference/upload").then(() => (p.toast(`Reference added: ${f.name}`), p.refresh())).catch((e) => p.toast(e.message, "err")).finally(() => setUp(null));
  };
  const guideCard = (
    <div className={`card stack-sm ${p.focus === "guide" ? "focus" : ""}`}>
      <div className="label">Copy guide: what to copy from the reference</div>
      <textarea className="field" rows={4} dir="auto" value={guide} onChange={(e) => setGuideText(e.target.value)} autoFocus={p.focus === "guide"}
        placeholder="e.g. copy the captions (big, two words at a time, yellow highlight) and how fast it cuts. Keep my own colour grade." />
      <div className="design-chips">
        {GUIDE_IDEAS.map((g) => <button key={g} className="chip-btn" onClick={() => setGuideText((t) => (t.trim() ? `${t.trim()}, ${g}` : `Copy ${g}`))}>+ {g}</button>)}
      </div>
      <div className="row">
        <span className="hint grow">Reference style analyses the clip with this in mind, and the Brief writes it into what Jev checks.</span>
        <button className="btn primary sm" disabled={guide.trim() === guideNow.trim()} onClick={() => guard(() => actions.refGuide(guide), "Copy guide saved")}>Save guide</button>
      </div>
    </div>
  );
  return (
    <div className="stack">
      {p.focus === "guide" && guideCard}
      <div className={`card stack-sm ${p.focus === "refclip" ? "focus" : ""}`}>
        <div className="label">Reference clip (optional)</div>
        {ref ? (
          <>
            <div className="ref-player"><video src={fileUrl(ref.file)} controls preload="metadata" /></div>
            <div className="row">
              <span className="grow" dir="auto">{ref.name}</span>
              {ref.source && <a className="hint" href={ref.source} target="_blank" rel="noreferrer">source ↗</a>}
              <button className="btn ghost sm" onClick={() => guard(() => actions.refClear(), "Reference removed")}>Remove</button>
            </div>
          </>
        ) : (
          <div className="hint">A finished short whose style you want your clips to copy. Without one, the workflow follows the outline alone.</div>
        )}
        <div className="row">
          <input className="field grow" placeholder="Paste a link: TikTok, Reels, Shorts, YouTube…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn sm" disabled={!url.trim() || job?.status === "running"} onClick={() => guard(() => actions.refImport(url.trim()), "Downloading the reference…").then(() => setUrl(""))}>Import</button>
        </div>
        <label className="btn sm file-btn">
          {up !== null ? `Uploading ${Math.round(up * 100)}%` : ref ? "Replace with a file…" : "Choose a video file…"}
          <input type="file" accept="video/*" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      </div>
      {p.focus === "refclip" && guideCard}
    </div>
  );
}
