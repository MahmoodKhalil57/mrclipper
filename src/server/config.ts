import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Where mrClipper keeps things. A checkout keeps everything it writes in .store/ (gitignored):
//   .store/workspace/   videos/, transcripts/, clips/, outlines/, references/, clip_outline.md
//   .store/state/       settings, thumbnails, jobs, the Director's storage
//   .store/tools/       ffmpeg, yt-dlp, the face model and its Python (downloaded by `bun run setup`)
// The desktop app uses the user's folders instead (see src/desktop/index.ts). Either way the workspace
// can be pointed at another folder in the app (project menu → Change…), saved in state/workspace.json.

/** Walk up from this file until we find the app's package.json (works from src/ and dist/). */
function findAppDir(): string {
  let dir = import.meta.dir;
  while (!existsSync(join(dir, "package.json"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error("Could not locate app directory");
    dir = up;
  }
  return dir;
}

/** The app folder (dist/, templates/, tools/, node_modules). The desktop build sets MRCLIPPER_HOME. */
export const APP_DIR = process.env.MRCLIPPER_HOME ? resolve(process.env.MRCLIPPER_HOME) : findAppDir();

/** Optional settings for a checkout (see .env.example); the environment wins over the file. */
export const ENV_FILE = join(APP_DIR, ".env");

function loadEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(ENV_FILE), ...process.env } as Record<string, string | undefined>;

/** Everything a checkout writes. */
export const STORE = resolve(APP_DIR, env.MRCLIPPER_STORE ?? ".store");
/** App state: settings, thumbnails, jobs, the Director's storage. */
export const DATA_DIR = resolve(APP_DIR, env.MRCLIPPER_DATA ?? join(STORE, "state"));
/** Helper tools downloaded for a checkout: ffmpeg, yt-dlp, the face model and its Python. */
export const TOOLS_DIR = resolve(APP_DIR, env.MRCLIPPER_TOOLS ?? join(STORE, "tools"));
/** The workspace chosen in the app, if any. */
export const WORKSPACE_CONFIG = join(DATA_DIR, "workspace.json");

// Before the rename, a checkout (Clipdesk) kept its state in .data/ and used the folder above it as its
// workspace. Starting it moves that state into .store/ and keeps using the same workspace. What's left
// in .data/ (old logs and settings) isn't used any more. Each piece moves once: it's gone from .data/ after.
function adoptLegacyCheckout() {
  const legacy = join(APP_DIR, ".data");
  if (!existsSync(legacy) || env.MRCLIPPER_DATA || env.MRCLIPPER_STORE) return;
  const moves: [string, string][] = [
    ["workerd", join(DATA_DIR, "workerd")], ["thumbs", join(DATA_DIR, "thumbs")], ["jobs.json", join(DATA_DIR, "jobs.json")],
    ["py", join(TOOLS_DIR, "py")], ["models", join(TOOLS_DIR, "models")], ["pyi", join(TOOLS_DIR, "pyi")],
    [join("cache", "ffmpeg-essentials.zip"), join(TOOLS_DIR, "cache", "ffmpeg-release-essentials.zip")],
  ].filter(([from, to]) => existsSync(join(legacy, from)) && !existsSync(to)) as [string, string][];
  if (!moves.length) return;
  mkdirSync(DATA_DIR, { recursive: true });
  const parent = resolve(APP_DIR, "..");
  if (!existsSync(WORKSPACE_CONFIG) && existsSync(join(parent, "clip_outline.md"))) {
    writeFileSync(WORKSPACE_CONFIG, JSON.stringify({ root: parent }, null, 2));
  }
  // A running Clipdesk holds its Director's files open, so .data/workerd won't move. Then move nothing
  // (it's tried again next start) rather than pull its tools out from under it.
  if (moves[0][0] === "workerd") {
    try {
      renameSync(join(legacy, "workerd"), moves.shift()![1]);
    } catch {
      console.warn("  Clipdesk seems to be running from this folder (its files are in use). Stop it, then start mrClipper again.");
      return;
    }
  }
  for (const [from, to] of moves) {
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(join(legacy, from), to);
    } catch (e) {
      console.warn(`  Couldn't move .data/${from} to ${to}: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`  Moved this checkout's state from .data/ to ${STORE}${existsSync(WORKSPACE_CONFIG) ? `; the workspace stays ${savedWorkspace() ?? parent}` : ""}. You can delete .data/.`);
}
adoptLegacyCheckout();

function savedWorkspace(): string | undefined {
  try {
    return JSON.parse(readFileSync(WORKSPACE_CONFIG, "utf8")).root || undefined;
  } catch {
    return undefined;
  }
}

/** The workspace: videos/, transcripts/, clips/, outlines/, references/, clip_outline.md. */
export const ROOT = resolve(APP_DIR, env.MRCLIPPER_WORKSPACE ?? savedWorkspace() ?? env.MRCLIPPER_DEFAULT_WORKSPACE ?? join(STORE, "workspace"));
/** Set by MRCLIPPER_WORKSPACE, which wins over the in-app choice. */
export const WORKSPACE_FIXED = !!env.MRCLIPPER_WORKSPACE;
/** New source videos (uploads and link imports) go here. */
export const VIDEOS_DIR = join(ROOT, "videos");

/** Create the workspace on first use: its folders, and the starter outline. */
export function ensureWorkspace() {
  for (const d of [ROOT, VIDEOS_DIR, join(ROOT, "clips"), join(ROOT, "transcripts"), DATA_DIR]) mkdirSync(d, { recursive: true });
  const outline = join(ROOT, "clip_outline.md");
  const template = join(APP_DIR, "templates", "clip_outline.md");
  if (!existsSync(outline) && existsSync(template)) copyFileSync(template, outline);
}

/** A helper binary: bundled with the desktop app (runtime/), downloaded into .store/tools/bin, or on PATH. */
export function toolPath(name: string): string {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  return [join(APP_DIR, "runtime", exe), join(TOOLS_DIR, "bin", exe)].find(existsSync) ?? Bun.which(name) ?? name;
}

/** Fallback only (headless use). The browser is the source of truth for the key: see key.ts. */
export const OPENROUTER_ENV_KEY = env.OPENROUTER_KEY ?? env.OPENROUTER_API_KEY ?? "";
export const PORT = Number(env.MRCLIPPER_PORT ?? 4477);
export const WORKER_PORT = Number(env.MRCLIPPER_WORKER_PORT ?? 8799);
/** Run the Director with `wrangler dev` instead of workerd directly. */
export const USE_WRANGLER = !!env.MRCLIPPER_WRANGLER;
/** `bun dev` skips `bun run setup` (offline, or tools managed elsewhere). */
export const SKIP_SETUP = !!env.MRCLIPPER_SKIP_SETUP;

// Cheap models only. OpenRouter falls back through the list in order.
export const MODELS = {
  director: env.DIRECTOR_MODEL ?? "z-ai/glm-5.3-flash",
  transcribe: env.TRANSCRIBE_MODEL ?? "google/gemini-2.5-flash",
  // Speech-to-text used only for word timings; Gemini's text is aligned onto its timeline.
  timing: env.TIMING_MODEL ?? "openai/whisper-large-v3",
  // Vision model that labels one frame per shot for the vision transcript.
  vision: env.VISION_MODEL ?? "google/gemini-2.5-flash-lite",
  plan: (env.PLAN_MODELS ?? "z-ai/glm-5.3-flash").split(","),
  // Reasoning effort for the writing steps (Brief, hook options, outline rewrites). GLM flash can't turn
  // reasoning off; "low" wrote an equally good brief for $0.0015, vs 202 s and $0.0088 by default.
  planReasoning: env.PLAN_REASONING ?? "low",
  // System One decision model used by the Planner and Editor in Jev mode.
  jev: env.JEV_MODEL ?? "~typesafe/jev-latest",
};

/** Request options for the writing steps: little reasoning, and the fastest provider of the same model.
 *  Providers of one model differ a lot in speed (the same brief took 10 s to 150 s); sorting by throughput
 *  gave 11-13 s at the same price. */
export const WRITER = { reasoning: { effort: MODELS.planReasoning }, provider: { sort: "throughput" } };

export const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v"]);
