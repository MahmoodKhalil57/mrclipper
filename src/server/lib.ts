import { MISSING_KEY, openrouterKey } from "./key";
import { assertCloud } from "./cloud";

/** A transcript line. `words` (measured per-word times) is present when the timing pass aligned it. */
export type Segment = {
  start: number; end: number; text: string;
  words?: { w: string; start: number; end: number }[];
  timing?: "aligned" | "estimated";
};

/** HH:MM:SS, HH:MM:SS.s (tenths) or HH:MM:SS,mmm (srt). */
export function fmt(t: number, mode: "plain" | "tenths" | "srt" = "plain"): string {
  t = Math.max(t, 0);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const base = [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
  if (mode === "tenths") return `${base}.${Math.round((t % 1) * 10) % 10}`;
  if (mode === "srt") return `${base},${String(Math.round((t % 1) * 1000) % 1000).padStart(3, "0")}`;
  return base;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

export async function run(
  cmd: string[],
  opts: { cwd?: string; onStdout?: (line: string) => void; signal?: AbortSignal } = {},
) {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill();
  opts.signal?.addEventListener("abort", kill, { once: true });
  const stderr = new Response(proc.stderr).text();
  let stdout = "";
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    const text = decoder.decode(chunk, { stream: true });
    stdout += text;
    if (opts.onStdout) {
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      lines.forEach(opts.onStdout);
    }
  }
  const code = await proc.exited;
  opts.signal?.removeEventListener("abort", kill);
  opts.signal?.throwIfAborted();
  return { code, stdout, stderr: await stderr };
}

export async function probeDuration(path: string): Promise<number> {
  const r = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  if (r.code !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return Number.parseFloat(r.stdout.trim());
}

export type ChatResult = { content: string; model: string; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };

/** One OpenRouter chat completion. `models` may list fallbacks. */
export async function openrouter(
  body: Record<string, unknown>,
  models: string | string[],
  signal?: AbortSignal,
): Promise<ChatResult> {
  assertCloud("OpenRouter");
  const key = openrouterKey();
  if (!key) throw new Error(MISSING_KEY);
  const list = Array.isArray(models) ? models : [models];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(list.length > 1 ? { models: list } : { model: list[0] }), usage: { include: true }, ...body }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.choices) throw new Error(`OpenRouter HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return { content: data.choices[0].message.content ?? "", model: data.model ?? list[0], usage: data.usage };
}

/** Pull a JSON object out of model output that may be fenced or wrapped in prose. */
export function extractJson<T = any>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
