// Get a checkout ready to run: the helper tools mrClipper uses, into .store/tools/ (gitignored).
//   ffmpeg      cutting, rendering and captions (needs libass and x264)   PATH if it can, else a static build
//   yt-dlp      importing videos from links                               PATH, else the standalone binary
//   face model  OpenCV's YuNet, for 9:16 framing on people's faces
//   faces       Python and OpenCV to run it, installed with uv (downloaded too if it isn't installed)
// The app starts without any of them and says what's missing. Safe to re-run: it only fetches what's
// missing, and `bun dev` runs it first. MRCLIPPER_SKIP_SETUP=1 skips it.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKIP_SETUP, TOOLS_DIR, toolPath } from "../src/server/config";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const PLATFORM = `${process.platform}-${process.arch}`;
export const BIN = join(TOOLS_DIR, "bin");
export const CACHE = join(TOOLS_DIR, "cache");
export const MODEL = join(TOOLS_DIR, "models", "face_detection_yunet_2023mar.onnx");
export const PYTHON = WIN ? join(TOOLS_DIR, "py", "Scripts", "python.exe") : join(TOOLS_DIR, "py", "bin", "python");

const say = (s: string) => process.stdout.write(s);
const mb = (p: string) => `${(statSync(p).size / 1024 / 1024).toFixed(0)} MB`;

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: opts.env ?? process.env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed: ${(r.stderr.toString() || r.stdout.toString()).trim().split(/\r?\n/).slice(-3).join(" ")}`);
  return r.stdout.toString();
}

/** Stream a download to disk, with a percentage as it goes. */
export async function download(url: string, dest: string) {
  mkdirSync(join(dest, ".."), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const part = `${dest}.part`;
  const out = Bun.file(part).writer();
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    if (total && got / total >= shown + 0.2) {
      shown = Math.floor((got / total) * 5) / 5;
      say(` ${Math.round(shown * 100)}%`);
    }
  }
  await out.end();
  renameSync(part, dest);
}

/** Unpack a .zip, .tar.gz or .tar.xz into `dir` (Windows' own tar reads zips; Git Bash's GNU tar can't). */
export function extract(archive: string, dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh([WIN ? "C:\\Windows\\System32\\tar.exe" : "tar", "-xf", archive, "-C", dir]);
}

/** The first file called `name` under `dir`. */
function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

/** Download an archive (cached), unpack it and install the binary `name` from it into .store/tools/bin. */
async function installFromArchive(url: string, name: string) {
  const file = url.split("/").pop()!;
  const archive = join(CACHE, file);
  if (!existsSync(archive)) await download(url, archive);
  const dir = join(CACHE, file.replace(/\.(zip|tar\.gz|tar\.xz)$/, ""));
  extract(archive, dir);
  const bin = findFile(dir, name + EXE);
  if (!bin) throw new Error(`${name} wasn't in ${file}`);
  mkdirSync(BIN, { recursive: true });
  copyFileSync(bin, join(BIN, name + EXE));
  if (!WIN) chmodSync(join(BIN, name + EXE), 0o755);
  // Only the binary is kept; the archive and what else was in it (ffmpeg's alone is 115 MB) go.
  rmSync(dir, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return join(BIN, name + EXE);
}

/** What an ffmpeg lacks of what mrClipper uses (captions, transitions, camera moves, H.264). */
export function ffmpegMissing(bin: string): string[] {
  try {
    const filters = sh([bin, "-hide_banner", "-filters"]);
    const encoders = sh([bin, "-hide_banner", "-encoders"]);
    const missing = ["ass", "xfade", "zoompan"].filter((f) => !new RegExp(`\\s${f}\\s`).test(filters));
    if (!/\blibx264\b/.test(encoders)) missing.push("libx264");
    return missing;
  } catch {
    return ["ffmpeg itself"];
  }
}

const FFMPEG: Record<string, string> = {
  "win32-x64": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  "win32-arm64": "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  "linux-x64": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
  "linux-arm64": "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
};
const YTDLP: Record<string, string> = {
  "win32-x64": "yt-dlp.exe", "win32-arm64": "yt-dlp.exe",
  "darwin-arm64": "yt-dlp_macos", "darwin-x64": "yt-dlp_macos",
  "linux-x64": "yt-dlp_linux", "linux-arm64": "yt-dlp_linux_aarch64",
};
const UV: Record<string, string> = {
  "win32-x64": "uv-x86_64-pc-windows-msvc.zip", "win32-arm64": "uv-aarch64-pc-windows-msvc.zip",
  "darwin-arm64": "uv-aarch64-apple-darwin.tar.gz", "darwin-x64": "uv-x86_64-apple-darwin.tar.gz",
  "linux-x64": "uv-x86_64-unknown-linux-gnu.tar.gz", "linux-arm64": "uv-aarch64-unknown-linux-gnu.tar.gz",
};

export async function ensureFfmpeg(): Promise<string> {
  const found = toolPath("ffmpeg");
  const missing = ffmpegMissing(found);
  if (!missing.length) return found;
  const url = FFMPEG[PLATFORM];
  if (!url) throw new Error(`install one with libass and x264 (macOS: brew install ffmpeg); ${found === "ffmpeg" ? "none found" : `${found} lacks ${missing.join(", ")}`}`);
  say(`downloading ${url.includes("gyan") ? "gyan.dev essentials" : "BtbN static"} build…`);
  const bin = await installFromArchive(url, "ffmpeg");
  const still = ffmpegMissing(bin);
  if (still.length) throw new Error(`the downloaded build lacks ${still.join(", ")}`);
  return bin;
}

export async function ensureYtDlp(): Promise<string> {
  const found = toolPath("yt-dlp");
  if (found !== "yt-dlp") return found;
  const file = YTDLP[PLATFORM];
  if (!file) throw new Error(`no standalone build for ${PLATFORM}; install yt-dlp on your PATH`);
  say("downloading…");
  const dest = join(BIN, "yt-dlp" + EXE);
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${file}`, dest);
  if (!WIN) chmodSync(dest, 0o755);
  return dest;
}

export async function ensureFaceModel(): Promise<string> {
  if (existsSync(MODEL) && statSync(MODEL).size > 100_000) return MODEL;
  say("downloading…");
  await download("https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx", MODEL);
  if (statSync(MODEL).size < 100_000) throw new Error("the download wasn't the model");
  return MODEL;
}

const facesReady = () => existsSync(PYTHON) && Bun.spawnSync([PYTHON, "-c", "import cv2, numpy"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

/** uv, the Python installer: the one on PATH, else its standalone binary in .store/tools/bin. */
export async function ensureUv(): Promise<string> {
  const found = Bun.which("uv") ?? (existsSync(join(BIN, "uv" + EXE)) ? join(BIN, "uv" + EXE) : null);
  if (found) return found;
  const file = UV[PLATFORM];
  if (!file) throw new Error(`no uv build for ${PLATFORM}`);
  say("getting uv…");
  return installFromArchive(`https://github.com/astral-sh/uv/releases/latest/download/${file}`, "uv");
}

/** uv's settings: the Python it installs and its cache stay in .store/tools. */
export const UV_ENV = { ...process.env, UV_PYTHON_INSTALL_DIR: join(TOOLS_DIR, "python"), UV_CACHE_DIR: join(CACHE, "uv") };

/** Python with OpenCV for tools/faces.py, made with uv. */
export async function ensureFaces(): Promise<string> {
  if (facesReady()) return PYTHON;
  const uv = await ensureUv();
  const env = UV_ENV;
  say(" Python 3.12…");
  rmSync(join(TOOLS_DIR, "py"), { recursive: true, force: true });
  sh([uv, "venv", join(TOOLS_DIR, "py"), "--python", "3.12", "--python-preference", "only-managed", "--quiet"], { env });
  say(" OpenCV…");
  sh([uv, "pip", "install", "--python", PYTHON, "--quiet", "opencv-python-headless", "numpy"], { env });
  if (!facesReady()) throw new Error("OpenCV didn't import after installing");
  return PYTHON;
}

/** Run every step; a failed step is reported and skipped, never fatal. */
export async function setup() {
  if (SKIP_SETUP) return;
  mkdirSync(CACHE, { recursive: true });
  const steps: [string, () => Promise<string>, string][] = [
    ["ffmpeg", ensureFfmpeg, "cutting and rendering won't work"],
    ["yt-dlp", ensureYtDlp, "importing from links won't work"],
    ["face model", ensureFaceModel, "9:16 crops stay centred"],
    ["faces", ensureFaces, "9:16 crops stay centred"],
  ];
  console.log(`\nmrClipper setup · ${TOOLS_DIR}`);
  for (const [name, step, without] of steps) {
    say(`  ${name.padEnd(11)}`);
    try {
      const got = await step();
      console.log(` ✓ ${got.startsWith(TOOLS_DIR) ? got.slice(TOOLS_DIR.length + 1) : got}${existsSync(got) && statSync(got).isFile() && statSync(got).size > 5e6 ? ` (${mb(got)})` : ""}`);
    } catch (e) {
      console.log(` ✗ ${e instanceof Error ? e.message : e}`);
      console.log(`  ${"".padEnd(11)}   Without it ${without}. Fix it and re-run \`bun run setup\`.`);
    }
  }
}

if (import.meta.main) await setup();
