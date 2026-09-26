// Electrobun main process (Bun runtime): runs the Clipdesk server in-process and shows it in a native window.
import { BrowserWindow, Utils, app } from "electrobun/main";
import { APP_HOME } from "./home.gen";

// Must be set before the server modules load, so they resolve dist/ and wrangler from the app folder.
process.env.CLIPDESK_HOME ??= APP_HOME;
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

// Stop wrangler/workerd with the app; otherwise they keep the ports busy.
app.on("before-quit", () => clipdesk.stop());
