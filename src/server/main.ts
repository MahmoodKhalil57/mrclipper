// CLI entry: serve Clipdesk in the browser at http://127.0.0.1:4477
import { startClipdesk } from "./server";

try {
  const app = startClipdesk();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      app.stop();
      process.exit(0);
    });
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
