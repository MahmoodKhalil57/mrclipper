import { useRef, useState } from "react";
import { actions, uploadVideo, type Job } from "./api";
import { Film } from "./Common";

/** Upload a file or import a link. Used as the empty-canvas hero and inside the "Add video" dialog. */
export function AddVideo({ onAdded, importJob, hero }: {
  onAdded: (video: string | null, jobId?: string) => void; importJob?: Job; hero?: boolean;
}) {
  const [url, setUrl] = useState("");
  const [upload, setUpload] = useState<{ name: string; p: number } | null>(null);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const send = async (file: File) => {
    setErr("");
    setUpload({ name: file.name, p: 0 });
    try {
      const r = await uploadVideo(file, (p) => setUpload({ name: file.name, p }));
      onAdded(r.video);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUpload(null);
    }
  };
  const importLink = async () => {
    setErr("");
    try {
      const r = await actions.importUrl(url.trim());
      setUrl("");
      onAdded(null, r.job_id);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const importing = importJob?.status === "running" ? importJob : undefined;

  return (
    <div className={`addvideo ${hero ? "hero" : ""}`}>
      {hero && (
        <div className="hero-copy">
          <div className="pane-kicker">Start a project</div>
          <h1>Bring in a long video.<br /><em>Leave with clips.</em></h1>
          <p>Each video becomes a pipeline you can watch, pause and steer. Transcribe it, let the Planner pick moments, review them yourself, then cut.</p>
        </div>
      )}
      <button
        className={`drop ${over ? "over" : ""}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files[0];
          if (f) send(f);
        }}
        disabled={!!upload}
      >
        {upload ? (
          <div className="drop-progress">
            <div dir="auto">Uploading {upload.name}</div>
            <Film value={upload.p} status="running" agent="transcribe" />
            <div className="mono faint">{Math.round(upload.p * 100)}%</div>
          </div>
        ) : (
          <>
            <div className="drop-icon">⤓</div>
            <div><b>Drop a video here</b> or click to choose one</div>
            <div className="faint">mp4 · mkv · webm · mov. Saved to downloads/</div>
          </>
        )}
      </button>
      <input ref={input} type="file" accept="video/*,.mkv" hidden onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
      <div className="or"><span>or paste a link</span></div>
      <div className="row">
        <input className="field grow" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && importLink()} />
        <button className="btn primary" disabled={!url.trim() || !!importing} onClick={importLink}>Import</button>
      </div>
      {importing && (
        <div className="stack-sm">
          <Film value={importing.progress} status="running" agent="transcribe" />
          <div className="row">
            <span className="hint grow">{importing.stage}</span>
            <button className="btn sm danger" onClick={() => actions.cancel(importing.id)}>■ Stop</button>
          </div>
        </div>
      )}
      {importJob?.status === "failed" && <div className="err-box">{importJob.error}</div>}
      {err && <div className="err-box">{err}</div>}
    </div>
  );
}
