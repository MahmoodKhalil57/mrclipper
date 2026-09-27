// Run the Director (a Think agent on Durable Objects) directly on workerd, Cloudflare's open-source
// Workers runtime: one self-contained binary, so the desktop app needs neither Node nor wrangler.
// The config below is what `wrangler dev` would set up for wrangler.jsonc: the prebuilt bundle,
// the Director Durable Object with SQLite storage on local disk, and outbound network access
// (OpenRouter over TLS, and this app's MCP servers on 127.0.0.1).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_DIR } from "./config";

/** The bundled binary in the desktop app, or the one wrangler installed for development. */
export function workerdBinary(): string | null {
  return [
    join(APP_DIR, "runtime", "workerd.exe"),
    join(APP_DIR, "node_modules", "@cloudflare", "workerd-windows-64", "bin", "workerd.exe"),
    join(APP_DIR, "node_modules", "@cloudflare", "workerd-linux-64", "bin", "workerd"),
    join(APP_DIR, "node_modules", "@cloudflare", "workerd-darwin-arm64", "bin", "workerd"),
    join(APP_DIR, "node_modules", "@cloudflare", "workerd-darwin-64", "bin", "workerd"),
  ].find(existsSync) ?? null;
}

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
  const storage = join(p.dir, "durable-objects");
  mkdirSync(storage, { recursive: true });
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
  durableObjectNamespaces = [(className = "Director", uniqueKey = "clipdesk-director", enableSql = true)],
  durableObjectStorage = (localDisk = "do-disk"),
  globalOutbound = "internet",
);
`;
  const file = join(p.dir, "director.capnp");
  writeFileSync(file, config, "utf8");
  return file;
}
