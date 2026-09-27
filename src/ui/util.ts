import DOMPurify from "dompurify";
import { marked } from "marked";
import type { AgentKey } from "./api";

marked.setOptions({ gfm: true, breaks: true });

export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/** m:ss.mmm (or h:mm:ss.mmm) for measured timings. */
export function tcms(t: number): string {
  const base = tc(t);
  return `${base}.${String(Math.floor((Math.max(0, t) % 1) * 1000)).padStart(3, "0")}`;
}

export function tc(t: number, tenths = false): string {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  return tenths ? `${base}.${Math.floor((t % 1) * 10)}` : base;
}

export const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const bytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
export const usd = (n: number) => (n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

/** A short, recognisable handle for long video names: the [youtube-id] if present. */
export function shortName(stem: string): string {
  const id = stem.match(/\[([\w-]{6,})\]\s*$/)?.[1];
  const title = stem.replace(/\s*\[[\w-]+\]\s*$/, "");
  const head = title.split(/[｜|]/)[0].trim();
  return id ? `${head.slice(0, 18)} [${id}]` : title.slice(0, 32);
}

/** Job kinds as the canvas names them (the tray, job cards and logs use these). */
export const AGENT_LABEL: Record<string, string> = {
  source: "Import", refclip: "Reference clip", transcript: "Transcribe", refstyle: "Reference style", brief: "Brief",
  pick: "Pick clips", design: "Design edits", render: "Render", check: "Check", coach: "Coach", workflow: "▶ Run",
  // the Director's three MCP servers
  transcribe: "Transcriber", plan: "Planner", extract: "Editor",
};

/** Who works on each job kind: the colour it wears everywhere. */
export const AGENT_WHO: Record<string, "you" | "transcriber" | "llm" | "jev" | "code"> = {
  source: "you", refclip: "you", transcript: "transcriber", refstyle: "transcriber", brief: "llm",
  pick: "jev", design: "jev", render: "code", check: "jev", coach: "jev", workflow: "code",
};

export const TOOL_AGENT: Record<string, AgentKey> = {
  list_videos: "transcribe", read_transcript: "transcribe", read_vision: "transcribe", read_reference: "transcribe",
  workflow_status: "plan", run_workflow: "plan", run_step: "plan", read_outline: "plan", update_outline: "plan", read_brief: "plan",
  read_feedback: "plan", read_history: "plan", set_style_reference: "plan", outline_scores: "plan",
  list_takes: "extract", read_take: "extract", adjust_clip: "extract", read_clip_script: "extract",
  job_status: "plan",
};

const KNOWN = Object.keys(TOOL_AGENT).sort((a, b) => b.length - a.length);

/** MCP tools arrive as `tool_<serverId>_<name>`; recover the crew tool name. */
export function crewTool(raw: string): { tool: string; agent?: AgentKey } {
  const tool = KNOWN.find((k) => raw === k || raw.endsWith(`_${k}`)) ?? raw;
  return { tool, agent: TOOL_AGENT[tool] };
}

/** MCP results are `{ content: [{ type: "text", text }] }`; unwrap to text and JSON when possible. */
export function unwrapOutput(output: unknown): { text: string; json?: any; isError?: boolean } {
  if (output == null) return { text: "" };
  if (typeof output === "string") return tryJson(output);
  const o = output as any;
  if (Array.isArray(o.content)) {
    const text = o.content.map((c: any) => c.text ?? "").join("\n");
    return { ...tryJson(text), isError: !!o.isError };
  }
  return { text: JSON.stringify(output, null, 2), json: output };
}

function tryJson(text: string) {
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text };
  }
}
