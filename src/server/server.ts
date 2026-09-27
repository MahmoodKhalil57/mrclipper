import type { ServerWebSocket, Subprocess } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { APP_DIR, DATA_DIR, MODELS, PORT, ROOT, USE_WRANGLER, WORKER_PORT, ensureWorkspace } from "./config";
import { INTERNAL_TOKEN, keyStatus, openrouterKey } from "./key";
import { workerdBinary, writeWorkerdConfig } from "./workerd";
import { listJobs, onEvent, sysLog } from "./jobs";
import { OUTLINE_FILE, historyPaths, listRuns, listVideos, readText, rel, safePath } from "./library";
import { AGENTS, handleMcp, type McpAgentKey } from "./mcp";
import { handleApi } from "./api";
import { readReview } from "./review";
import { outlineState } from "./agents/outlines";
import { pendingGuide, readReference } from "./agents/reference";

const UI_DIR = join(APP_DIR, "dist", "ui");
const WORKER_BUNDLE = join(APP_DIR, "dist", "worker", "director.js");
const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
const SELF_URL = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// The Director: the prebuilt Think worker bundle, run directly on workerd (or `wrangler dev` as a fallback).

let worker: Subprocess | undefined;
let workerState: "starting" | "ready" | "down" = "starting";
let shuttingDown = false;

const WORKER_PID = join(DATA_DIR, "workerd.pid");

/** A Director runtime left behind by a server that was killed rather than stopped still holds its port.
 *  Stop it first. It's remembered by PID, and only stopped if that PID is still a workerd process. */
function stopLeftoverWorker() {
  let pid = 0;
  try {
    pid = Number(readFileSync(WORKER_PID, "utf8").trim());
  } catch {
    return;
  }
  if (!pid) return;
  const name = process.platform === "win32"
    ? Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).stdout.toString()
    : Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="]).stdout.toString();
  if (!/workerd/i.test(name)) return;
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  else {
    try {
      process.kill(pid);
    } catch {}
  }
  sysLog("Stopped a Director runtime left running by an earlier start", "warn");
}

function startWorker() {
  workerState = "starting";
  // MCP_BASE points the worker back at this server. It has no key of its own: it asks this server
  // for the browser's key on every model call, with a per-launch token (see key.ts).
  const vars = { MCP_BASE: SELF_URL, INTERNAL_TOKEN, DIRECTOR_MODEL: MODELS.director };
  const workerd = USE_WRANGLER ? null : workerdBinary();
  if (workerd) {
    // workerd directly: one binary, no Node or wrangler (what the desktop app ships).
    const dir = join(DATA_DIR, "workerd");
    const config = writeWorkerdConfig({ bundle: WORKER_BUNDLE, dir, port: WORKER_PORT, vars });
    stopLeftoverWorker();
    worker = Bun.spawn([workerd, "serve", config, "--experimental"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    writeFileSync(WORKER_PID, String(worker.pid));
  } else {
    const envFile = join(DATA_DIR, "worker.env");
    writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(""));
    worker = Bun.spawn(
      [
        process.execPath, join(APP_DIR, "node_modules", "wrangler", "bin", "wrangler.js"), "dev", WORKER_BUNDLE,
        "--no-bundle", "--config", join(APP_DIR, "wrangler.jsonc"), "--env-file", envFile,
        "--ip", "127.0.0.1", "--port", String(WORKER_PORT), "--persist-to", join(DATA_DIR, "wrangler"),
        "--show-interactive-dev-session=false", "--log-level", "warn",
      ],
      { cwd: APP_DIR, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
  }
  for (const stream of [worker.stdout, worker.stderr] as ReadableStream<Uint8Array>[]) pipeLines(stream);
  worker.exited.then((code) => {
    workerState = "down";
    if (shuttingDown) return;
    sysLog(`Director worker exited (${code}); restarting in 2s`, "error");
    setTimeout(startWorker, 2000);
  });
  waitForWorker();
}

/** Kill wrangler and its workerd children; on Windows a plain kill leaves workerd running. */
function killWorker() {
  if (!worker || worker.exitCode !== null) return;
  if (process.platform === "win32") Bun.spawnSync(["taskkill", "/pid", String(worker.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
  else worker.kill();
}

async function pipeLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trim();
      if (!line) continue;
      console.log(`[director] ${line}`);
      sysLog(line, /error|✘/i.test(line) ? "error" : /warn|▲/i.test(line) ? "warn" : "info");
    }
  }
}

async function waitForWorker() {
  for (let i = 0; i < 120 && !shuttingDown; i++) {
    try {
      await fetch(WORKER_URL, { signal: AbortSignal.timeout(1000) });
      workerState = "ready";
      sysLog("Director worker ready");
      return;
    } catch {
      await Bun.sleep(500);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Serve a file with Range support so <video> can seek. */
function serveFile(path: string, req: Request): Response {
  const file = Bun.file(path);
  const size = file.size;
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  const headers: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": file.type || "application/octet-stream" };
  if (!range) return new Response(file, { headers: { ...headers, "Content-Length": String(size) } });
  let start = range[1] ? Number(range[1]) : size - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
  });
}

function sse(req: Request): Response {
  let off = () => {};
  let ping: Timer;
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: unknown) => {
        try {
          controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
        } catch {}
      };
      off = onEvent(send);
      ping = setInterval(() => send({ type: "ping", worker: workerState }), 15000);
      send({ type: "hello", worker: workerState });
      req.signal.addEventListener("abort", () => {
        off();
        clearInterval(ping);
      });
    },
    cancel() {
      off();
      clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

async function library() {
  const outline = readText(OUTLINE_FILE);
  return {
    root: ROOT,
    videos: await listVideos(),
    runs: listRuns().map((r) => ({ ...r, review: readReview(r.id) })),
    outline,
    history: historyPaths(outline).map((p) => ({ path: rel(p), text: readText(p) })),
    outlines: outlineState(),
    reference: readReference(),
    pendingGuide: pendingGuide(),
  };
}

// ---------------------------------------------------------------------------
// Server

type WsData = { target: string; upstream?: WebSocket; queue: (string | Buffer)[]; closed?: boolean };

/** Close both legs exactly once; re-entrant closes from either side's handlers are ignored. */
function closeBoth(ws: ServerWebSocket<WsData>, code = 1000, reason = "") {
  if (ws.data.closed) return;
  ws.data.closed = true;
  // 1005/1006 are reserved and can't be sent in a close frame.
  const safe = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011;
  try {
    ws.data.upstream?.close();
  } catch {}
  try {
    ws.close(safe, reason);
  } catch {}
}

/** Bun.serve, with a clear message when the port is taken (often another mrClipper). */
function serve(options: Parameters<typeof Bun.serve<WsData>>[0]) {
  try {
    return Bun.serve<WsData>(options);
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE" || /EADDRINUSE|in use/i.test(String(e))) {
      throw new Error(`Port ${PORT} is already in use (is mrClipper already running?). Stop it, or start with MRCLIPPER_PORT set to another port.`);
    }
    throw e;
  }
}

/** Start the mrClipper server and the Think worker. Shared by the CLI and the desktop app. */
export function startMrClipper() {
  for (const f of [UI_DIR, WORKER_BUNDLE]) {
    if (!existsSync(f)) throw new Error(`Missing ${f}. Run \`bun run build\` first.`);
  }
  ensureWorkspace();
  if (!keyStatus().set) console.log("  OpenRouter key: none yet; the app asks for it on first open");

  const server = serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 255, // SSE streams and MCP status calls that wait up to 50s
    maxRequestBodySize: 32 * 1024 ** 3, // video uploads
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname);

      // Think agent traffic (chat WebSocket + callable RPC) goes to the worker.
      if (path.startsWith("/agents/")) {
        const target = WORKER_URL + url.pathname + url.search;
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          // The client reconnects on its own; don't open sockets to a worker that isn't listening yet.
          if (workerState !== "ready") return new Response("Director starting", { status: 503 });
          if (srv.upgrade(req, { data: { target: target.replace(/^http/, "ws"), queue: [] } })) return;
          return new Response("Upgrade failed", { status: 400 });
        }
        const headers = new Headers(req.headers);
        headers.delete("host");
        headers.delete("accept-encoding");
        const res = await fetch(target, { method: req.method, headers, body: req.body, redirect: "manual" }).catch(() => null);
        if (!res) return new Response("Director starting", { status: 503 });
        // Bun's fetch already decoded the body; passing the encoding headers on would corrupt it.
        const out = new Headers(res.headers);
        out.delete("content-encoding");
        out.delete("content-length");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
      }

      // The Director worker's key lookup. Local only, and only with this launch's token.
      if (path === "/internal/key") {
        if (req.headers.get("x-mrclipper-token") !== INTERNAL_TOKEN) return new Response("Forbidden", { status: 403 });
        return json({ key: openrouterKey() });
      }

      const mcp = path.match(/^\/mcp\/(transcribe|plan|extract)\/?$/);
      if (mcp) return handleMcp(mcp[1] as McpAgentKey, req);

      if (path === "/api/status")
        return json({
          worker: workerState,
          key: keyStatus(),
          models: MODELS,
          root: ROOT,
          agents: Object.entries(AGENTS).map(([key, a]) => ({ key, title: a.title, blurb: a.blurb, url: `${SELF_URL}/mcp/${key}` })),
        });
      if (path.startsWith("/api/")) {
        const res = await handleApi(req, url, path);
        if (res) return res;
      }
      if (path === "/api/library") return json(await library());
      if (path === "/api/jobs") return json(listJobs());
      if (path === "/api/events") return sse(req);
      if (path === "/api/outline" && req.method === "PUT") {
        writeFileSync(OUTLINE_FILE, await req.text(), "utf8");
        return json({ ok: true });
      }
      if (path === "/api/file" && url.searchParams.get("path")) {
        const p = url.searchParams.get("path")!;
        if (req.method === "PUT") {
          if (!/\.(md|txt)$/i.test(p)) return json({ error: "Only .md/.txt files are editable" }, 400);
          writeFileSync(safePath(p), await req.text(), "utf8");
          return json({ ok: true });
        }
        return new Response(readText(safePath(p)), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      if (path.startsWith("/files/")) {
        try {
          const full = safePath(path.slice("/files/".length));
          if (existsSync(full)) return serveFile(full, req);
        } catch {}
        return new Response("Not found", { status: 404 });
      }

      // Static UI (single-page app fallback).
      const asset = join(UI_DIR, path === "/" ? "index.html" : path);
      if (asset.startsWith(UI_DIR) && existsSync(asset) && extname(asset)) return new Response(Bun.file(asset));
      return new Response(Bun.file(join(UI_DIR, "index.html")));
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const up = new WebSocket(ws.data.target);
        ws.data.upstream = up;
        up.binaryType = "arraybuffer";
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m);
          ws.data.queue = [];
        };
        up.onmessage = (e) => {
          if (!ws.data.closed) ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
        };
        up.onclose = (e) => closeBoth(ws, e.code, e.reason);
        up.onerror = () => closeBoth(ws, 1011, "Director unreachable");
      },
      message(ws: ServerWebSocket<WsData>, msg) {
        const up = ws.data.upstream;
        if (ws.data.closed) return;
        if (up?.readyState === WebSocket.OPEN) up.send(msg);
        else ws.data.queue.push(msg);
      },
      close(ws: ServerWebSocket<WsData>) {
        closeBoth(ws);
      },
    },
  });

  startWorker();
  console.log(`\n  mrClipper  ${SELF_URL}\n  workspace  ${ROOT}\n  director   ${MODELS.director}\n`);
  return {
    url: SELF_URL,
    ready: () => workerState === "ready",
    stop() {
      shuttingDown = true;
      killWorker();
      server.stop(true);
    },
  };
}
