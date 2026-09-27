// Electrobun main process (Bun runtime): runs the mrClipper server in-process and shows it in a native window.
//
// Installed (standalone): everything ships inside the app, under Resources/app next to this bundle:
//   dist/       UI, server assets and the Director bundle
//   runtime/    workerd (the Director's runtime), ffmpeg, yt-dlp, faces/ (face detection)
//   models/     the face detection model
//   templates/  the starter clip outline
// App state goes to the user's app data folder (%LOCALAPPDATA%\mrClipper on Windows) and the workspace
// (videos, transcripts, clips, outline) defaults to Documents\mrClipper. Nothing needs to be installed
// or configured first; the OpenRouter key is asked for in the app.
//
// Development build (`bun run desktop`): runs from the source checkout (APP_HOME) and its .store/.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserWindow, Utils, app } from "electrobun/main";
import { APP_HOME } from "./home.gen";

const bundled = join(import.meta.dir, "..");
const standalone = existsSync(join(bundled, "dist", "ui", "index.html"));

/** Where an app keeps its data on this OS. */
function appDataDir(name: string) {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), name);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", name);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), name);
}

/** The app was called Clipdesk: move one of its folders to the new name, once. */
function adopt(from: string, to: string) {
  if (!existsSync(from) || existsSync(to)) return;
  try {
    renameSync(from, to);
  } catch {}
}

if (standalone) {
  const dataDir = appDataDir("mrClipper");
  const workspace = join(homedir(), "Documents", "mrClipper");
  const oldWorkspace = join(homedir(), "Documents", "Clipdesk");
  adopt(appDataDir("Clipdesk"), dataDir);
  adopt(oldWorkspace, workspace);
  // A folder chosen in the old app that was the old default follows it to the new name.
  const saved = join(dataDir, "workspace.json");
  try {
    const root = JSON.parse(readFileSync(saved, "utf8")).root;
    if (root && resolve(root) === resolve(oldWorkspace) && existsSync(workspace)) writeFileSync(saved, JSON.stringify({ root: workspace }, null, 2));
  } catch {}

  process.env.MRCLIPPER_HOME = bundled;
  process.env.MRCLIPPER_DATA = dataDir;
  process.env.MRCLIPPER_TOOLS = join(dataDir, "tools");
  process.env.MRCLIPPER_DEFAULT_WORKSPACE = workspace;
  // Its own ports, so the installed app and a `bun dev` checkout can run side by side.
  process.env.MRCLIPPER_PORT ??= "4478";
  process.env.MRCLIPPER_WORKER_PORT ??= "8798";
} else {
  // Must be set before the server modules load, so they resolve dist/ and the tools from the checkout.
  process.env.MRCLIPPER_HOME ??= APP_HOME;
}

const { startMrClipper } = await import("../server/server");

let mrclipper: ReturnType<typeof startMrClipper>;
try {
  mrclipper = startMrClipper();
} catch (e) {
  await Utils.showMessageBox({
    type: "error",
    title: "mrClipper could not start",
    message: e instanceof Error ? e.message : String(e),
    buttons: ["Quit"],
  }).catch(() => {});
  Utils.quit(1);
  throw e;
}

new BrowserWindow({
  title: "mrClipper",
  url: mrclipper.url,
  frame: { width: 1440, height: 920, x: 80, y: 50 },
});

// Stop the Director's runtime with the app; otherwise it keeps the ports busy.
app.on("before-quit", () => mrclipper.stop());
