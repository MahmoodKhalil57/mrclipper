// Run the Director (a Think agent on Durable Objects) directly on workerd, Cloudflare's open-source
// Workers runtime: one self-contained binary, so the desktop app needs neither Node nor wrangler.
// The config below is what `wrangler dev` would set up for wrangler.jsonc: the prebuilt bundle,
// the Director Durable Object with SQLite storage on local disk, and outbound network access
// (OpenRouter over TLS, and this app's MCP servers on 127.0.0.1).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DIR } from "./config";

/** workerd's per-platform npm packages (the same table the `workerd` package uses). */
const WORKERD_PACKAGES: Record<string, string> = {
  "darwin arm64": "@cloudflare/workerd-darwin-arm64",
  "darwin x64": "@cloudflare/workerd-darwin-64",
  "linux arm64": "@cloudflare/workerd-linux-arm64",
  "linux x64": "@cloudflare/workerd-linux-64",
  "win32 x64": "@cloudflare/workerd-windows-64",
  "win32 arm64": "@cloudflare/workerd-windows-64",
};

/** The binary bundled with the desktop app, or the one `bun install` put in node_modules for this platform. */
export function workerdBinary(): string | null {
  const exe = process.platform === "win32" ? "workerd.exe" : "workerd";
  const bundled = join(APP_DIR, "runtime", exe);
  if (existsSync(bundled)) return bundled;
  const pkg = WORKERD_PACKAGES[`${process.platform} ${process.arch}`];
  if (!pkg) return null;
  try {
    const bin = join(dirname(Bun.resolveSync(`${pkg}/package.json`, APP_DIR)), "bin", exe);
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** The Director namespace's storage key: its folder under do/. Kept short, like do/ itself: see the
 *  path-length check in writeWorkerdConfig. */
const DIRECTOR_KEY = "director";

const EMAIL_INTERNAL = `class EmailMessage {
  constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; }
}
export default { EmailMessage };
`;

const str = (s: string) => JSON.stringify(s); // capnp string literals use the same escapes as JSON
const slash = (p: string) => p.replaceAll("\\", "/");

/** Compatibility settings come from wrangler.jsonc when it's around (dev), else these (packaged). */
function compat(): { date: string; flags: string[] } {
  const fallback = { date: "2026-09-25", flags: ["nodejs_compat"] };
  try {
    const raw = readFileSync(join(APP_DIR, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    const w = JSON.parse(raw);
    return { date: w.compatibility_date ?? fallback.date, flags: w.compatibility_flags ?? fallback.flags };
  } catch {
    return fallback;
  }
}

/** Write the workerd config (and a copy of the bundle next to it) into `dir`; returns the config path. */
export function writeWorkerdConfig(p: { bundle: string; dir: string; port: number; vars: Record<string, string> }): string {
  const storage = join(p.dir, "do");
  mkdirSync(storage, { recursive: true });
  // The app was called Clipdesk, and kept the Director's conversations in durable-objects/clipdesk-director.
  const old = join(p.dir, "durable-objects", "clipdesk-director");
  if (existsSync(old) && !existsSync(join(storage, DIRECTOR_KEY))) renameSync(old, join(storage, DIRECTOR_KEY));
  // Each Director conversation is a SQLite file named by a 64-character id, and SQLite on Windows can't
  // open a path over 259 characters (it fails with SQLITE_CANTOPEN). Its longest is the rollback journal.
  const longest = join(storage, DIRECTOR_KEY, `${"0".repeat(64)}.sqlite-journal`).length;
  if (process.platform === "win32" && longest > 259) {
    console.warn(`  The Director's storage path is ${longest} characters, over Windows' 260 limit, so its chat won't work.\n  Move this folder somewhere with a shorter path, or set MRCLIPPER_DATA to a short folder.`);
  }
  copyFileSync(p.bundle, join(p.dir, "director.js"));
  // `cloudflare:email` (pulled in by the agents SDK, unused here) needs this internal module, which
  // wrangler's Miniflare normally supplies. Same shape as Miniflare's.
  writeFileSync(join(p.dir, "email-internal.js"), EMAIL_INTERNAL, "utf8");
  const c = compat();
  const config = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .director),
    (name = "internet", network = (allow = ["public", "private", "local"], tlsOptions = (trustBrowserCas = true))),
    (name = "do-disk", disk = (path = ${str(slash(storage))}, writable = true)),
  ],
  sockets = [(name = "http", address = ${str(`127.0.0.1:${p.port}`)}, http = (), service = "main")],
  extensions = [(modules = [(name = "cloudflare-internal:email", esModule = embed "email-internal.js", internal = true)])],
);

const director :Workerd.Worker = (
  modules = [(name = "director.js", esModule = embed "director.js")],
  compatibilityDate = ${str(c.date)},
  compatibilityFlags = [${c.flags.map(str).join(", ")}],
  bindings = [
${Object.entries(p.vars).map(([k, v]) => `    (name = ${str(k)}, text = ${str(v)}),`).join("\n")}
    (name = "Director", durableObjectNamespace = "Director"),
  ],
  durableObjectNamespaces = [(className = "Director", uniqueKey = ${str(DIRECTOR_KEY)}, enableSql = true)],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
);
`;
  const file = join(p.dir, "director.capnp");
  writeFileSync(file, config, "utf8");
  return file;
}
