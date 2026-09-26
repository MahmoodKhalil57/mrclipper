// The OpenRouter key. The browser is the source of truth: the UI keeps it in its own storage and
// pushes it here on load (and again whenever this server restarts). The server holds it in memory
// only and never writes it to disk. OPENROUTER_KEY in the environment or .env is a fallback for the
// headless CLI; a key from the browser always wins.
import { randomUUID } from "node:crypto";
import { OPENROUTER_ENV_KEY } from "./config";

let browserKey = "";

export const openrouterKey = () => browserKey || OPENROUTER_ENV_KEY;
export const keySource = (): "browser" | "env" | null => (browserKey ? "browser" : OPENROUTER_ENV_KEY ? "env" : null);

/** Per-launch secret the Director worker uses to fetch the key from this server. Never leaves this machine. */
export const INTERNAL_TOKEN = randomUUID();

export const MISSING_KEY = "No OpenRouter key yet. Add yours with the 🔑 Key button in Clipdesk's top bar.";

export type KeyInfo = { set: boolean; source: "browser" | "env" | null; label?: string; usage?: number; limit?: number | null; verified?: boolean };

/** Ask OpenRouter about a key: label, spend and limit. Throws if OpenRouter rejects it. */
async function describe(key: string): Promise<Omit<KeyInfo, "set" | "source">> {
  const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res) return { verified: false }; // offline: accept it; calls will say if it's wrong
  if (res.status === 401 || res.status === 403) throw new Error("OpenRouter rejected this key. Check it at openrouter.ai/settings/keys.");
  const d = ((await res.json().catch(() => ({}))) as any).data ?? {};
  return { verified: res.ok, label: d.label, usage: d.usage, limit: d.limit ?? null };
}

export async function setBrowserKey(key: string): Promise<KeyInfo> {
  const k = key.trim();
  if (!/^sk-or-[\w-]{10,}$/.test(k)) throw new Error("That doesn't look like an OpenRouter key (they start with sk-or-).");
  const info = await describe(k);
  browserKey = k;
  return { set: true, source: "browser", ...info };
}

export function clearBrowserKey(): KeyInfo {
  browserKey = "";
  return keyStatus();
}

export const keyStatus = (): KeyInfo => ({ set: !!openrouterKey(), source: keySource() });

export async function keyInfo(): Promise<KeyInfo> {
  const k = openrouterKey();
  if (!k) return keyStatus();
  try {
    return { ...keyStatus(), ...(await describe(k)) };
  } catch (e) {
    return { ...keyStatus(), verified: false, label: e instanceof Error ? e.message : String(e) };
  }
}
