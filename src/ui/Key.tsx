// The OpenRouter key lives here, in the app's browser storage: the source of truth. The server only
// holds a copy in memory, so this pushes the key to it on load and whenever the server restarts.
import { useEffect, useRef, useState } from "react";
import { actions, type KeyInfo } from "./api";

const LS = "mrclipper.openrouterKey";

export function storedKey(): string {
  try {
    return localStorage.getItem(LS) ?? "";
  } catch {
    return "";
  }
}
function saveLocal(k: string) {
  try {
    k ? localStorage.setItem(LS, k) : localStorage.removeItem(LS);
  } catch {}
}

/** Give the server this browser's key. Returns false if there's none or OpenRouter rejected it. */
export async function pushStoredKey(): Promise<boolean> {
  const k = storedKey();
  if (!k) return false;
  try {
    await actions.setKey(k);
    return true;
  } catch {
    return false;
  }
}

const mask = (k: string) => (k.length > 16 ? `${k.slice(0, 9)}…${k.slice(-4)}` : "••••");

export function KeyButton({ status, onChange, toast }: {
  status: KeyInfo | undefined; onChange: () => void; toast: (m: string, kind?: "err" | "ok") => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const asked = useRef(false);
  const local = storedKey();
  const set = !!status?.set;

  // First run: nothing anywhere, so open the prompt once.
  useEffect(() => {
    if (status && !status.set && !local && !asked.current) {
      asked.current = true;
      setOpen(true);
    }
  }, [status?.set]);
  useEffect(() => {
    if (open && set) actions.keyInfo().then(setInfo).catch(() => setInfo(null));
  }, [open, set, status?.source]);

  const save = async () => {
    setBusy(true);
    try {
      const r = await actions.setKey(draft.trim());
      saveLocal(draft.trim());
      setDraft("");
      setInfo(r);
      toast(r.verified === false ? "Key saved (couldn't reach OpenRouter to check it)" : `Key saved${r.label ? `: ${r.label}` : ""}`);
      onChange();
    } catch (e) {
      toast((e as Error).message, "err");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    saveLocal("");
    await actions.clearKey().catch(() => {});
    setInfo(null);
    toast("Key removed from this app");
    onChange();
  };

  return (
    <div className="keybox" onClick={(e) => e.stopPropagation()}>
      <button className={`btn ghost sm key-btn ${set ? "" : "missing"}`} onClick={() => setOpen(!open)} title="OpenRouter key">
        <span className={`lamp ${set ? "ready" : "down"}`} /> {set ? "Key" : "Add key"}
      </button>
      {open && (
        <div className="key-pop">
          <div className="row"><b className="grow">OpenRouter key</b><button className="btn ghost sm" onClick={() => setOpen(false)} aria-label="Close">✕</button></div>
          <div className="hint">
            Kept in this app's own browser storage, the only place it's saved. mrClipper's server holds a copy in memory while it runs and gets it again from here after a restart. Nothing is written to disk.
          </div>
          {set && (
            <div className="key-now">
              <span className="mono">{status?.source === "browser" ? mask(local) : "from .env"}</span>
              {info?.label && <span className="faint">{info.label}</span>}
              {info?.usage !== undefined && <span className="mono faint">used ${info.usage.toFixed(2)}{info.limit ? ` of $${info.limit}` : ""}</span>}
            </div>
          )}
          {status?.source === "env" && (
            <div className="hint warn-text">Using OPENROUTER_KEY from the environment or .env as a fallback. Save a key here to make this app the source of truth.</div>
          )}
          <div className="row">
            <input className="field grow" type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-v1-…" value={draft}
              onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && draft.trim() && save()} autoFocus />
            <button className="btn primary sm" disabled={busy || !draft.trim()} onClick={save}>{busy ? "Checking…" : set ? "Replace" : "Save"}</button>
          </div>
          <div className="row">
            <a className="hint" href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Get a key at openrouter.ai/settings/keys ↗</a>
            <span className="grow" />
            {status?.source === "browser" && <button className="btn ghost sm" onClick={remove}>Remove</button>}
          </div>
        </div>
      )}
    </div>
  );
}
