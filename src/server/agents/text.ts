// Small text helpers shared by the workflow steps: hashing for freshness, trimming for prompts and
// Jev states, and reading/rewriting the outline's "## " sections and "**Label:**" settings.
import { createHash } from "node:crypto";

/** Short content hash, stable across line endings. Every step's freshness is built from these. */
export const hashText = (t: string) => createHash("sha1").update(t.replace(/\r\n/g, "\n").trim()).digest("hex").slice(0, 12);

export const clipStr = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** The "**Label:**" settings in a markdown outline. */
export const bold = (t: string) => [...t.matchAll(/\*\*([^*]+?):\*\*/g)].map((m) => m[1].trim());

/** "## " sections of a markdown outline, with their bodies (everything up to the next "## "). */
export function sectionsOf(md: string): { name: string; body: string }[] {
  const text = md.replace(/\r\n/g, "\n");
  const heads = [...text.matchAll(/^## (.+)$/gm)];
  return heads.map((h, i) => ({
    name: h[1].trim(),
    body: text.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index! : text.length).replace(/^\n+|\n+$/g, ""),
  }));
}

export function replaceSection(md: string, name: string, body: string) {
  const text = md.replace(/\r\n/g, "\n");
  const heads = [...text.matchAll(/^## (.+)$/gm)];
  const i = heads.findIndex((h) => h[1].trim() === name);
  if (i === -1) return text;
  const start = heads[i].index!;
  const next = i + 1 < heads.length ? heads[i + 1].index! : -1;
  return text.slice(0, start) + `## ${name}\n\n${body.trim()}\n` + (next === -1 ? "" : "\n" + text.slice(next));
}

/** The outline's audience and tone sections, trimmed to fit a Jev state. */
export function audienceSummary(outline: string): string {
  const grab = (h: string) => outline.match(new RegExp(`^## ${h}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"))?.[1].trim() ?? "";
  return clipStr(`${grab("Audience")}\n\n${grab("Clipping tone")}`.trim() || outline, 1800);
}
