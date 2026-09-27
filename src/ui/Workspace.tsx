// Where the workspace lives (videos, transcripts, clips, the outline), with Open and, in the desktop
// app, a way to point Clipdesk at another folder (applies on the next launch).
import { useEffect, useState } from "react";
import { call, getJSON } from "./api";

type Ws = { root: string; data: string; desktop: boolean };

export function WorkspaceLine({ toast }: { toast: (m: string, kind?: "err" | "ok") => void }) {
  const [ws, setWs] = useState<Ws | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    getJSON<Ws>("/api/workspace").then(setWs).catch(() => {});
  }, []);
  if (!ws) return null;
  const change = async () => {
    const root = window.prompt("Folder for videos, transcripts, clips and the outline (created if missing):", pending ?? ws.root);
    if (!root || root.trim() === (pending ?? ws.root)) return;
    try {
      const r = await call<{ root: string }>("/api/workspace", "POST", { root });
      setPending(r.root);
      toast("Saved. Restart Clipdesk to open that folder.");
    } catch (e) {
      toast((e as Error).message, "err");
    }
  };
  return (
    <div className="ws-line" onClick={(e) => e.stopPropagation()}>
      <span className="faint">Workspace</span>
      <span className="mono ws-path" title={ws.root}>{ws.root}</span>
      <button className="linkish" onClick={() => call("/api/workspace/open").catch(() => {})}>Open</button>
      {ws.desktop && <button className="linkish" onClick={change}>Change…</button>}
      {pending && <span className="warn-text">→ {pending} after restart</span>}
    </div>
  );
}
