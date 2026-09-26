import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/** The app folder (dist/, node_modules/wrangler, wrangler.jsonc). The desktop build sets CLIPDESK_HOME. */
export const APP_DIR = process.env.CLIPDESK_HOME ? resolve(process.env.CLIPDESK_HOME) : findAppDir();
/** The clipping project root: videos, transcripts/, clips/, clip_outline.md, .env */
export const ROOT = resolve(process.env.CLIP_ROOT ?? join(APP_DIR, ".."));
export const DATA_DIR = join(APP_DIR, ".data");
export const ENV_FILE = join(ROOT, ".env");

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

/** Fallback only (headless CLI). The browser is the source of truth for the key: see key.ts. */
export const OPENROUTER_ENV_KEY = env.OPENROUTER_KEY ?? env.OPENROUTER_API_KEY ?? "";
export const PORT = Number(env.CLIPDESK_PORT ?? 4477);
export const WORKER_PORT = Number(env.CLIPDESK_WORKER_PORT ?? 8799);

// Cheap models only. OpenRouter falls back through the list in order.
export const MODELS = {
  director: env.DIRECTOR_MODEL ?? "z-ai/glm-5.3-flash",
  transcribe: env.TRANSCRIBE_MODEL ?? "google/gemini-2.5-flash",
  // Speech-to-text used only for word timings; Gemini's text is aligned onto its timeline.
  timing: env.TIMING_MODEL ?? "openai/whisper-large-v3",
  // Vision model that labels one frame per shot for the vision transcript.
  vision: env.VISION_MODEL ?? "google/gemini-2.5-flash-lite",
  plan: (env.PLAN_MODELS ?? "z-ai/glm-5.3-flash").split(","),
  // System One decision model used by the Planner and Editor in Jev mode.
  jev: env.JEV_MODEL ?? "~typesafe/jev-latest",
};

export const VIDEO_EXTS = new Set([".mp4", ".mkv", ".webm", ".mov", ".m4v"]);
