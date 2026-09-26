// WebMCP mode turns Clipdesk into a deterministic workflow shell: the browser's agent does the
// thinking through the page's WebMCP tools, and the server must not call any hosted model.
// Every cloud call path (chat completions, Jev decisions, speech-to-text) checks this first.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";

export function engineSetting(): "classic" | "hybrid" | "jev" | "webmcp" {
  try {
    const f = join(DATA_DIR, "settings.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).engine ?? "classic") : "classic";
  } catch {
    return "classic";
  }
}

export class CloudDisabled extends Error {}

export function assertCloud(what: string) {
  if (engineSetting() === "webmcp") {
    throw new CloudDisabled(
      `${what} is switched off in WebMCP mode: Clipdesk makes no OpenRouter calls. ` +
        "The agent in your browser does this step through the page's WebMCP tools.",
    );
  }
}
