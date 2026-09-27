// Gather everything the standalone desktop app runs, into vendor/ (packaged by electrobun.config.ts):
//   vendor/runtime/workerd.exe   the Director's runtime (from wrangler's install; replaces Node + wrangler)
//   vendor/runtime/ffmpeg.exe    gyan.dev "essentials" build: libass/fribidi/harfbuzz for Arabic captions, x264
//   vendor/runtime/yt-dlp.exe    YouTube imports and captions
//   vendor/runtime/faces/        tools/faces.py compiled with PyInstaller (OpenCV YuNet, no Python needed)
//   vendor/models/               the YuNet face model
// Downloads are cached in .data/cache. Re-running only redoes what's missing or out of date.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const RT = join(APP, "vendor", "runtime");
const MODELS = join(APP, "vendor", "models");
const CACHE = join(APP, ".data", "cache");
for (const d of [RT, MODELS, CACHE]) mkdirSync(d, { recursive: true });
const step = (s: string) => console.log(`\n▸ ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1024 / 1024).toFixed(0)} MB`;
const newer = (a: string, b: string) => !existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs;
function sh(cmd: string[], cwd = APP) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode})`);
}
function need(p: string, hint: string) {
  if (!existsSync(p)) throw new Error(`Missing ${p}. ${hint}`);
  return p;
}

step("workerd");
const workerd = need(join(APP, "node_modules", "@cloudflare", "workerd-windows-64", "bin", "workerd.exe"), "Run `bun install`.");
if (newer(workerd, join(RT, "workerd.exe"))) copyFileSync(workerd, join(RT, "workerd.exe"));
console.log(`  workerd.exe  ${mb(join(RT, "workerd.exe"))}`);

step("ffmpeg (gyan.dev essentials)");
if (!existsSync(join(RT, "ffmpeg.exe"))) {
  const zip = join(CACHE, "ffmpeg-essentials.zip");
  if (!existsSync(zip)) sh(["curl", "-sL", "-o", zip, "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"]);
  // Windows' own bsdtar reads zips (Git Bash's GNU tar can't).
  const tar = process.platform === "win32" ? "C:\\Windows\\System32\\tar.exe" : "tar";
  sh([tar, "-xf", zip], CACHE);
  const dir = readdirSync(CACHE).find((d) => /^ffmpeg-.*essentials_build$/.test(d));
  copyFileSync(need(join(CACHE, dir ?? "", "bin", "ffmpeg.exe"), "The ffmpeg download didn't unpack as expected."), join(RT, "ffmpeg.exe"));
}
console.log(`  ffmpeg.exe   ${mb(join(RT, "ffmpeg.exe"))}`);

step("yt-dlp");
if (!existsSync(join(RT, "yt-dlp.exe"))) {
  const local = [join(APP, "..", "tools", "yt-dlp.exe"), join(APP, "tools", "yt-dlp.exe")].find(existsSync);
  if (local) copyFileSync(local, join(RT, "yt-dlp.exe"));
  else sh(["curl", "-sL", "-o", join(RT, "yt-dlp.exe"), "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"]);
}
console.log(`  yt-dlp.exe   ${mb(join(RT, "yt-dlp.exe"))}`);

step("face detection (PyInstaller)");
const faces = join(RT, "faces", "faces.exe");
if (newer(join(APP, "tools", "faces.py"), faces)) {
  const py = need(join(APP, ".data", "py", "Scripts", "python.exe"), "Set up the venv first (README: Vertical framing).");
  sh(["uv", "pip", "install", "--python", py, "pyinstaller"]);
  sh([py, "-m", "PyInstaller", "--noconfirm", "--onedir", "--console", "--name", "faces",
    "--distpath", RT, "--workpath", join(APP, ".data", "pyi", "work"), "--specpath", join(APP, ".data", "pyi"), join(APP, "tools", "faces.py")]);
}
// OpenCV's video I/O plugin isn't used (frames are decoded from JPEG bytes); it's 30 MB.
for (const f of readdirSync(join(RT, "faces", "_internal", "cv2")).filter((f) => /^opencv_videoio_ffmpeg.*\.dll$/.test(f))) {
  rmSync(join(RT, "faces", "_internal", "cv2", f));
}
console.log(`  faces.exe    ok`);

step("face model");
const model = need(join(APP, ".data", "models", "face_detection_yunet_2023mar.onnx"), "Download it (README: Vertical framing).");
copyFileSync(model, join(MODELS, "face_detection_yunet_2023mar.onnx"));
console.log("  face_detection_yunet_2023mar.onnx");

console.log("\nVendored into vendor/.");
