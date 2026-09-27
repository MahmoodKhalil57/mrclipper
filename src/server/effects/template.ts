// Effects are written as templates: an ffmpeg filter chain (or an ASS line, or a sound source) with
// {{placeholders}} for their parameters and the render context. Templates are data, not code, so new
// effects (yours, or written by the LLM) can't run anything: a placeholder is either a value or a
// small arithmetic expression, evaluated here.
//
//   {{name}}          a parameter or context value (W, H, fps, dur, frames, from, to)
//   {{name:fmt}}      a formatted value: colours as :ff (0xRRGGBB), :hex (#RRGGBB), :acolor (ASS &H00BBGGRR);
//                     a colour's channels as :r :g :b (0-255); opacity 0..1 as :alpha (ASS &HAA&);
//                     seconds as :time (ASS h:mm:ss.cc);
//                     text as :ass (escaped, right-to-left aware); file paths as :path (escaped for a filter)
//   {{= expr}}        arithmetic over numeric values: + - * / % ( ), min max abs round floor ceil clamp even

export type ParamSpec =
  | { type: "number"; min: number; max: number; default: number; doc?: string }
  | { type: "color"; default: string; doc?: string }
  | { type: "enum"; values: string[]; default: string; doc?: string }
  | { type: "text"; default?: string; max?: number; doc?: string }
  | { type: "asset"; kinds: AssetKind[]; doc?: string };
export type AssetKind = "sfx" | "music" | "overlay" | "image" | "lut" | "font";

export type Values = Record<string, number | string>;

const NAMED: Record<string, string> = {
  white: "#FFFFFF", black: "#000000", red: "#FF3B30", yellow: "#FFD60A", gold: "#FFC83D", orange: "#FF9500", green: "#34C759",
  cyan: "#32D2FF", blue: "#0A84FF", purple: "#BF5AF2", pink: "#FF2D95", magenta: "#FF00FF", grey: "#8E8E93", gray: "#8E8E93",
};
export const toHex = (v: unknown, d: string) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s.toUpperCase();
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toUpperCase();
  return NAMED[s] ?? d;
};

/** Parameters as given (by an LLM, a user) → valid values: clamped, defaulted, checked. Unknown ones are dropped.
 *  `assetOk` resolves an asset name to its file, or null when there's no such file. */
export function resolveParams(specs: Record<string, ParamSpec> | undefined, given: Record<string, unknown> | undefined, assetOk: (kinds: AssetKind[], name: string) => string | null): { values: Values; notes: string[]; missing: string[] } {
  const values: Values = {};
  const notes: string[] = [];
  const missing: string[] = [];
  for (const [k, s] of Object.entries(specs ?? {})) {
    const v = given?.[k];
    switch (s.type) {
      case "number": {
        const n = Number(v);
        values[k] = v === undefined || v === null || v === "" || !Number.isFinite(n) ? s.default : Math.min(s.max, Math.max(s.min, n));
        break;
      }
      case "color":
        values[k] = toHex(v, s.default);
        break;
      case "enum":
        values[k] = s.values.includes(String(v)) ? String(v) : s.default;
        break;
      case "text":
        values[k] = String(v ?? s.default ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, s.max ?? 80);
        if (!values[k]) missing.push(k);
        break;
      case "asset": {
        const path = v ? assetOk(s.kinds, String(v)) : null;
        if (v && !path) notes.push(`"${v}" isn't in assets/ (${s.kinds.join(" or ")})`);
        if (path) values[k] = path;
        else missing.push(k);
        break;
      }
    }
  }
  return { values, notes, missing };
}

// ── a tiny arithmetic evaluator ─────────────────────────────────────

const FUNCS: Record<string, (...a: number[]) => number> = {
  min: Math.min, max: Math.max, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
  even: (x) => Math.max(2, Math.round(x / 2) * 2),
};

export function evalExpr(src: string, vars: Values): number {
  const toks = src.match(/\d+\.?\d*|\.\d+|[A-Za-z_][\w.]*|[-+*/%(),]/g) ?? [];
  if (toks.join("").length !== src.replace(/\s+/g, "").length) throw new Error(`bad expression: ${src}`);
  let i = 0;
  const peek = () => toks[i];
  const take = (t?: string) => {
    const x = toks[i++];
    if (t && x !== t) throw new Error(`expected ${t} in ${src}`);
    return x;
  };
  const primary = (): number => {
    const t = take();
    if (t === undefined) throw new Error(`unexpected end of ${src}`);
    if (t === "(") {
      const v = sum();
      take(")");
      return v;
    }
    if (t === "-") return -primary();
    if (/^[\d.]/.test(t)) return Number(t);
    if (FUNCS[t] && peek() === "(") {
      take("(");
      const args = [sum()];
      while (peek() === ",") (take(), args.push(sum()));
      take(")");
      return FUNCS[t](...args);
    }
    if (t === "PI") return Math.PI;
    const v = vars[t];
    if (typeof v !== "number") throw new Error(`"${t}" isn't a number in ${src}`);
    return v;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const r = primary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + product() : v - product();
    return v;
  };
  const v = sum();
  if (i !== toks.length) throw new Error(`trailing input in ${src}`);
  if (!Number.isFinite(v)) throw new Error(`${src} isn't finite`);
  return v;
}

export const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));

export const assTime = (t: number) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};

/**
 * Right-to-left lines need an RTL paragraph direction, or libass lays them out left-to-right and
 * numbers, periods, commas and embedded English land in the wrong place. Lines whose first strong
 * letter is Hebrew or Arabic are wrapped in RLE…PDF (and styles use Encoding -1, libass's auto base direction).
 */
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
export const isRtl = (text: string) => RTL_LETTER.test(text.match(/\p{L}/u)?.[0] ?? "");
export const rtl = (text: string) => (isRtl(text) ? `‫${text}‬` : text);

/** Text for an ASS event: override braces and backslashes removed, RTL-aware. */
export const assText = (s: string) => rtl(s.replace(/[{}\\]/g, ""));

/** #RRGGBB → ASS &HAABBGGRR (alpha 0 = opaque). */
export const assColor = (hex: string, alpha = 0) =>
  `&H${alpha.toString(16).padStart(2, "0")}${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

/** A file path inside a filter option the template quotes ('{{file:path}}'): forward slashes, drive colon escaped. */
export const ffPath = (p: string) => p.replace(/\\/g, "/").replace(/'/g, "").replace(/:/g, "\\:");

/** Fill a template. Throws on an unknown placeholder or format, so a broken effect fails loudly in tests. */
export function fill(tpl: string, vars: Values): string {
  return tpl.replace(/\{\{\s*(=?)\s*([^}]+?)\s*\}\}/g, (_, isExpr: string, body: string) => {
    if (isExpr) return fmtNum(evalExpr(body, vars));
    const [name, fmt] = body.split(":").map((s: string) => s.trim());
    const v = vars[name];
    if (v === undefined) throw new Error(`unknown placeholder {{${body}}}`);
    switch (fmt) {
      case undefined: return typeof v === "number" ? fmtNum(v) : String(v);
      case "time": return assTime(Number(v));
      case "alpha": return `&H${Math.round(255 * (1 - Math.min(1, Math.max(0, Number(v))))).toString(16).padStart(2, "0").toUpperCase()}&`;
      case "ff": return `0x${toHex(v, "#FFFFFF").slice(1)}`;
      case "hex": return toHex(v, "#FFFFFF");
      case "acolor": return assColor(toHex(v, "#FFFFFF"));
      case "r": case "g": case "b": {
        const h = toHex(v, "#FFFFFF");
        return String(parseInt(h.slice(fmt === "r" ? 1 : fmt === "g" ? 3 : 5, fmt === "r" ? 3 : fmt === "g" ? 5 : 7), 16));
      }
      case "ass": return assText(String(v));
      case "path": return ffPath(String(v));
      default: throw new Error(`unknown format {{${body}}}`);
    }
  });
}

/** Filters an effect template may not use: they read or write files, or take commands from outside. */
export const FORBIDDEN_FILTERS = ["movie", "amovie", "sendcmd", "asendcmd", "zmq", "azmq", "ladspa", "lv2", "frei0r", "vidstabdetect", "vidstabtransform", "ocr", "metadata", "ametadata"];
export function checkTemplate(tpl: string): string | null {
  const bad = FORBIDDEN_FILTERS.find((f) => new RegExp(`(^|[,;\\]\\s])${f}\\s*(=|,|;|\\[|$)`).test(tpl));
  return bad ? `uses the "${bad}" filter, which effects can't use` : null;
}
