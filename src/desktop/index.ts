// Electrobun main process (Bun runtime): runs the Clipdesk server in-process and shows it in a native window.
//
// Installed (standalone): everything ships inside the app, under Resources/app next to this bundle:
//   dist/       UI, server assets and the Director bundle
//   runtime/    workerd (the Director's runtime), ffmpeg, yt-dlp, faces/ (face detection)
//   models/     the face detection model
//   templates/  the starter clip outline
// App state goes to %LOCALAPPDATA%\Clipdesk and the workspace (videos, transcripts, clips, outline)
// defaults to Documents\Clipdesk. Nothing needs to be installed or configured first; the OpenRouter
// key is asked for in the app.
//
// Development build (`bun run desktop`): falls back to the source checkout (APP_HOME).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Utils, app } from "electrobun/main";
import { APP_HOME } from "./home.gen";

const bundled = join(import.meta.dir, "..");
const standalone = existsSync(join(bundled, "dist", "ui", "index.html"));

if (standalone) {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const dataDir = join(local, "Clipdesk");
  const workspaceConfig = join(dataDir, "workspace.json");
  let workspace = join(homedir(), "Documents", "Clipdesk");
  try {
    workspace = JSON.parse(readFileSync(workspaceConfig, "utf8")).root || workspace;
  } catch {}
  // A new workspace starts with the starter outline and the folders the crew write to.
  for (const d of [workspace, join(workspace, "clips"), join(workspace, "transcripts"), join(workspace, "downloads"), dataDir]) mkdirSync(d, { recursive: true });
  const outline = join(workspace, "clip_outline.md");
  if (!existsSync(outline)) copyFileSync(join(bundled, "templates", "clip_outline.md"), outline);

  process.env.CLIPDESK_HOME = bundled;
  process.env.CLIPDESK_DATA = dataDir;
  process.env.CLIP_ROOT = workspace;
  process.env.CLIPDESK_WORKSPACE_CONFIG = workspaceConfig;
} else {
  // Must be set before the server modules load, so they resolve dist/ and the tools from the checkout.
  process.env.CLIPDESK_HOME ??= APP_HOME;
}

const { startClipdesk } = await import("../server/server");

let clipdesk: ReturnType<typeof startClipdesk>;
try {
  clipdesk = startClipdesk();
} catch (e) {
  await Utils.showMessageBox({
    type: "error",
    title: "Clipdesk could not start",
    message: e instanceof Error ? e.message : String(e),
    buttons: ["Quit"],
  }).catch(() => {});
  Utils.quit(1);
  throw e;
}

new BrowserWindow({
  title: "Clipdesk",
  url: clipdesk.url,
  frame: { width: 1440, height: 920, x: 80, y: 50 },
});

// Stop the Director's runtime with the app; otherwise it keeps the ports busy.
app.on("before-quit", () => clipdesk.stop());
