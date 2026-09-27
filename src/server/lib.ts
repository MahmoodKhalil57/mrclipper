import { MISSING_KEY, openrouterKey } from "./key";
import { toolPath } from "./config";

const BUNDLED = new Set(["ffmpeg", "yt-dlp"]);

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
  // The desktop app ships its own ffmpeg and yt-dlp, and a checkout downloads them into .store/tools;
  // use those over whatever is (or isn't) on PATH.
  const exe = BUNDLED.has(cmd[0]) ? toolPath(cmd[0]) : cmd[0];
  const spawn = () => Bun.spawn([exe, ...cmd.slice(1)], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (e) {
    if (BUNDLED.has(cmd[0])) throw new Error(`${cmd[0]} isn't installed. Run \`bun run setup\` to download it, or install it on your PATH.`);
    throw e;
  }
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

/**
 * Duration and frame size from ffmpeg's own header dump (`ffmpeg -i`), so the app ships one binary
 * instead of ffmpeg + ffprobe. ffmpeg exits non-zero without an output file; the header is still printed.
 */
export async function probeMedia(path: string): Promise<{ duration: number; width: number; height: number }> {
  const r = await run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path]);
  const d = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!d) throw new Error(`ffmpeg couldn't read ${path}: ${r.stderr.trim().split(/\r?\n/).pop()}`);
  const v = r.stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  return { duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), width: v ? Number(v[1]) : 0, height: v ? Number(v[2]) : 0 };
}

export async function probeDuration(path: string): Promise<number> {
  return (await probeMedia(path)).duration;
}

export type ChatResult = { content: string; model: string; provider?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };

/** One OpenRouter chat completion. `models` may list fallbacks. */
export async function openrouter(
  body: Record<string, unknown>,
  models: string | string[],
  signal?: AbortSignal,
): Promise<ChatResult> {
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
  return { content: data.choices[0].message.content ?? "", model: data.model ?? list[0], provider: data.provider, usage: data.usage };
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
