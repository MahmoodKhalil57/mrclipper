// Gather everything the standalone Windows app runs, into vendor/ (packaged by electrobun.config.ts):
//   vendor/runtime/workerd.exe   the Director's runtime (from bun install; replaces Node + wrangler)
//   vendor/runtime/ffmpeg.exe    gyan.dev "essentials" build: libass/fribidi/harfbuzz for Arabic captions, x264
//   vendor/runtime/yt-dlp.exe    link imports
//   vendor/runtime/faces/        tools/faces.py compiled with PyInstaller (OpenCV YuNet, no Python needed)
//   vendor/models/               the YuNet face model
// Downloads are shared with `bun run setup` (.store/tools/cache). Re-running only redoes what's missing or out of date.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { workerdBinary } from "../src/server/workerd";
import { TOOLS_DIR } from "../src/server/config";
import { CACHE, PYTHON, UV_ENV, download, ensureFaceModel, ensureFaces, ensureUv, extract } from "./setup";

if (process.platform !== "win32") throw new Error("The standalone build is Windows-only for now (see README).");

const APP = join(import.meta.dir, "..");
const RT = join(APP, "vendor", "runtime");
const MODELS = join(APP, "vendor", "models");
for (const d of [RT, MODELS, CACHE]) mkdirSync(d, { recursive: true });
const step = (s: string) => console.log(`\n▸ ${s}`);
const mb = (p: string) => `${(statSync(p).size / 1024 / 1024).toFixed(0)} MB`;
const newer = (a: string, b: string) => !existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs;
function sh(cmd: string[], cwd = APP) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} failed (${r.exitCode})`);
}

step("workerd");
const workerd = workerdBinary();
if (!workerd) throw new Error("workerd isn't in node_modules. Run `bun install`.");
if (newer(workerd, join(RT, "workerd.exe"))) copyFileSync(workerd, join(RT, "workerd.exe"));
console.log(`  workerd.exe  ${mb(join(RT, "workerd.exe"))}`);

step("ffmpeg (gyan.dev essentials)");
if (!existsSync(join(RT, "ffmpeg.exe"))) {
  // Always this build (not whatever is on PATH): it's redistributable and has what captions need.
  const zip = join(CACHE, "ffmpeg-release-essentials.zip");
  if (!existsSync(zip)) await download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", zip);
  const dir = join(CACHE, "ffmpeg-release-essentials");
  extract(zip, dir);
  const build = readdirSync(dir).find((d) => /^ffmpeg-.*essentials_build$/.test(d));
  if (!build) throw new Error("The ffmpeg download didn't unpack as expected.");
  copyFileSync(join(dir, build, "bin", "ffmpeg.exe"), join(RT, "ffmpeg.exe"));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`  ffmpeg.exe   ${mb(join(RT, "ffmpeg.exe"))}`);

step("yt-dlp");
if (!existsSync(join(RT, "yt-dlp.exe"))) await download("https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", join(RT, "yt-dlp.exe"));
console.log(`  yt-dlp.exe   ${mb(join(RT, "yt-dlp.exe"))}`);

step("face detection (PyInstaller)");
const faces = join(RT, "faces", "faces.exe");
if (newer(join(APP, "tools", "faces.py"), faces)) {
  await ensureFaces();
  const r = Bun.spawnSync([await ensureUv(), "pip", "install", "--python", PYTHON, "--quiet", "pyinstaller"], { env: UV_ENV, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) throw new Error("Installing PyInstaller failed");
  const work = join(TOOLS_DIR, "pyi");
  sh([PYTHON, "-m", "PyInstaller", "--noconfirm", "--onedir", "--console", "--name", "faces",
    "--distpath", RT, "--workpath", join(work, "work"), "--specpath", work, join(APP, "tools", "faces.py")]);
}
// OpenCV's video I/O plugin isn't used (frames are decoded from JPEG bytes); it's 30 MB.
for (const f of readdirSync(join(RT, "faces", "_internal", "cv2")).filter((f) => /^opencv_videoio_ffmpeg.*\.dll$/.test(f))) {
  rmSync(join(RT, "faces", "_internal", "cv2", f));
}
console.log(`  faces.exe    ok`);

step("face model");
copyFileSync(await ensureFaceModel(), join(MODELS, "face_detection_yunet_2023mar.onnx"));
console.log("  face_detection_yunet_2023mar.onnx");

console.log("\nVendored into vendor/.");
