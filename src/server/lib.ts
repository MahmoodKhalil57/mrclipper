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
export async function probeMedia(path: string): Promise<{ duration: number; width: number; height: number; vcodec?: string }> {
  const r = await run(["ffmpeg", "-hide_banner", "-nostdin", "-i", path]);
  const d = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!d) throw new Error(`ffmpeg couldn't read ${path}: ${r.stderr.trim().split(/\r?\n/).pop()}`);
  const v = r.stderr.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/);
  const codec = r.stderr.match(/Stream #\d+:\d+[^\n]*Video: (\w+)/)?.[1];
  return { duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]), width: v ? Number(v[1]) : 0, height: v ? Number(v[2]) : 0, ...(codec ? { vcodec: codec } : {}) };
}

export async function probeDuration(path: string): Promise<number> {
  return (await probeMedia(path)).duration;
}

/** Integrated loudness (LUFS, EBU R128) of a file's audio, or of a stretch of it. Null for silence. */
export async function measureLoudness(path: string, opts: { ss?: number; t?: number; signal?: AbortSignal } = {}): Promise<number | null> {
  const r = await run([
    "ffmpeg", "-hide_banner", "-nostats", ...(opts.ss !== undefined ? ["-ss", opts.ss.toFixed(3)] : []), ...(opts.t ? ["-t", opts.t.toFixed(3)] : []),
    "-i", path, "-vn", "-af", "ebur128", "-f", "null", "-",
  ], { signal: opts.signal });
  const summary = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const i = Number(summary.match(/I:\s*(-?[\d.]+) LUFS/)?.[1]);
  return Number.isFinite(i) && i > -70 ? i : null;
}

/**
 * POST a chat completion, retrying what's worth retrying: a connection that fails before any response
 * (a dropped network, a slow DNS answer), rate limits and server errors, up to three tries with a pause.
 */
async function post(body: Record<string, unknown>, key: string, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(600_000)]) : AbortSignal.timeout(600_000),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await res.body?.cancel().catch(() => {});
        await sleep(1500 * attempt, signal);
        continue;
      }
      return res;
    } catch (e) {
      if (signal?.aborted || attempt >= 3 || (e instanceof DOMException && e.name === "TimeoutError")) throw e;
      await sleep(1500 * attempt, signal);
    }
  }
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
  const res = await post({ ...(list.length > 1 ? { models: list } : { model: list[0] }), usage: { include: true }, ...body }, key, signal);
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data.choices) throw new Error(`OpenRouter HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return { content: data.choices[0].message.content ?? "", model: data.model ?? list[0], provider: data.provider, usage: data.usage };
}

/**
 * One OpenRouter call to a model that makes audio (music with Lyria). Audio output is only streamed: the
 * base64 pieces arrive in `delta.audio.data` and are joined here. Returns the file's bytes and what it cost.
 */
export async function openrouterAudio(
  body: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<{ audio: Buffer; text: string; model: string; provider?: string; cost?: number }> {
  const key = openrouterKey();
  if (!key) throw new Error(MISSING_KEY);
  // Retried only until a response starts: once audio streams, a retry could be billed twice.
  const res = await post({ model, modalities: ["text", "audio"], stream: true, usage: { include: true }, ...body }, key, signal);
  if (!res.ok || !res.body) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const pieces: Buffer[] = [];
  let text = "", usedModel = model, provider: string | undefined, cost: number | undefined, buf = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:") || line === "data: [DONE]") continue;
      let ev: any;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.error) throw new Error(`OpenRouter: ${JSON.stringify(ev.error).slice(0, 300)}`);
      usedModel = ev.model ?? usedModel;
      provider = ev.provider ?? provider;
      if (ev.usage?.cost !== undefined) cost = ev.usage.cost;
      const d = ev.choices?.[0]?.delta ?? {};
      if (d.audio?.data) pieces.push(Buffer.from(d.audio.data, "base64"));
      if (typeof d.content === "string") text += d.content;
    }
  }
  // An empty answer comes back now and then (only section markers, no audio). It's returned rather than
  // thrown, with whatever it cost, so the caller can count it and try again.
  return { audio: Buffer.concat(pieces), text, model: usedModel, provider, cost };
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
