// `bun dev`: fetch the helper tools on the first run, build, and serve mrClipper at http://127.0.0.1:4477.
import { join } from "node:path";
import { PORT } from "../src/server/config";
import { setup } from "./setup";

// Say so now if the port is taken (often mrClipper already running), before any setup or build work.
try {
  Bun.listen({ hostname: "127.0.0.1", port: PORT, socket: { data() {} } }).stop(true);
} catch {
  console.error(`Port ${PORT} is already in use (is mrClipper already running?). Stop it, or set MRCLIPPER_PORT to another port.`);
  process.exit(1);
}

await setup();

const build = Bun.spawnSync([process.execPath, join(import.meta.dir, "build.ts")], { stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

await import("../src/server/main.ts");
