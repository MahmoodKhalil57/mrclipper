import { useState } from "react";
import { AGENT_BRIEF, TOOLS, callTool, useCallLog, webmcpAvailable } from "./webmcp";
import { clock } from "./util";

/** WebMCP mode's replacement for the Director chat: the browser agent drives, this panel shows what it does. */
export function AgentDock({ registered }: { registered: number }) {
  const calls = useCallLog();
  const [open, setOpen] = useState<number | null>(null);
  const [tool, setTool] = useState(TOOLS[0].name);
  const [input, setInput] = useState("{}");
  const [copied, setCopied] = useState(false);
  const available = webmcpAvailable();
  const def = TOOLS.find((t) => t.name === tool)!;

  return (
    <div className="agentdock">
      <div className={`wm-status ${available && registered ? "ok" : "off"}`}>
        <span className={`lamp ${available && registered ? "ready" : "down"}`} />
        <div>
          <b>{available ? (registered ? `${registered} WebMCP tools registered` : "Registering tools…") : "WebMCP isn't available in this browser"}</b>
          <div className="hint">
            {available
              ? <>A WebMCP-capable agent in this tab can call them. Today that's Chrome's <a href="https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd" target="_blank" rel="noreferrer">Model Context Tool Inspector</a> extension, or your own agent. Gemini in Chrome's side panel doesn't call page tools yet (Google says "soon"). Clipdesk makes no OpenRouter calls in this mode.</>
              : <>Open Clipdesk in Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled. The desktop app's WebView2 doesn't expose it yet. The manual runner below still works.</>}
          </div>
        </div>
      </div>

      <details className="wm-brief">
        <summary>Brief for your agent</summary>
        <pre>{AGENT_BRIEF}</pre>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(AGENT_BRIEF).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
          {copied ? "Copied" : "Copy brief"}
        </button>
      </details>

      <div className="section-label" style={{ margin: "4px 0" }}>Tool calls</div>
      <div className="wm-calls">
        {calls.length === 0 && <div className="hint">No calls yet. When your agent uses a tool, it shows up here with its input and output.</div>}
        {calls.map((c) => (
          <div key={c.id} className={`wm-call ${c.error ? "err" : c.output === undefined ? "busy" : "ok"}`}>
            <button className="wm-call-head" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <span className="mono">{clock(c.at)}</span>
              <span className={`tag ${c.by}`}>{c.by === "agent" ? "agent" : "you"}</span>
              <b className="mono">{c.tool}</b>
              <span className="grow faint mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{JSON.stringify(c.input)}</span>
              <span className="mono faint">{c.output === undefined && !c.error ? <i className="spin" /> : `${c.ms}ms`}</span>
            </button>
            {open === c.id && (
              <div className="wm-call-body">
                <div className="label">Input</div>
                <pre className="codebox">{JSON.stringify(c.input, null, 1)}</pre>
                <div className="label">{c.error ? "Error" : "Output"}</div>
                <pre className="codebox">{c.error ?? c.output?.slice(0, 6000)}</pre>
              </div>
            )}
          </div>
        ))}
      </div>

      <details className="wm-runner">
        <summary>Run a tool yourself</summary>
        <div className="stack-sm">
          <select className="field" value={tool} onChange={(e) => (setTool(e.target.value), setInput("{}"))}>
            {TOOLS.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
          <div className="hint">{def.description}</div>
          <textarea className="field mono" rows={4} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
          <button className="btn sm" onClick={() => {
            let parsed: unknown = {};
            try { parsed = JSON.parse(input || "{}"); } catch { return alert("Input must be JSON"); }
            callTool(tool, parsed, "you");
          }}>Run {tool}</button>
        </div>
      </details>
    </div>
  );
}
