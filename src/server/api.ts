// REST endpoints behind the canvas. The Director reaches the same steps over MCP (mcp.ts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { startBrief, startCheck, startCoach, startDesign, startPick, startRefImport, startRefStyle, startRender, startSourceImport, startTranscript } from "./actions";
import { readBrief } from "./agents/brief";
import { applyProposal, discardProposal, restoreVersion, versionText } from "./agents/outlines";
import { addReferenceFile, clearReference, pendingGuide, readReference, setGuide } from "./agents/reference";
import { readVision } from "./agents/vision";
import { ASSETS_DIR, ASSET_FOLDERS, ensureAssetsDir, listAssets, measureAssets } from "./effects/assets";
import { EFFECTS_DIR, loadCatalog } from "./effects/catalog";
import type { AssetKind } from "./effects/template";
import { DATA_DIR, ROOT, VIDEOS_DIR, VIDEO_EXTS, WORKSPACE_CONFIG, WORKSPACE_FIXED } from "./config";
import { cancelJob, getJob, type Job } from "./jobs";
import { clearBrowserKey, keyInfo, setBrowserKey } from "./key";
import { readTranscript, rel, resolveVideo, runDir } from "./library";
import { adjustClipEdges, savePickSettings } from "./agents/take";
import { run } from "./lib";
import { addComment, addNote, deleteComment, deleteNote, feedbackDigest, readNotes, readReview, setApproved, setClipStatus } from "./review";
import { startWorkflow, stepUpToDate, workflowState, type NodeId } from "./workflow";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);

const THUMBS = join(DATA_DIR, "thumbs");

/** One step of the workflow, started from its node on the canvas. A step that's up to date with its inputs
 *  doesn't run (it would give the same result): the answer says why. `force` overrides that, for the API only. */
function startStep(b: Record<string, any>): Job | { skipped: string } {
  const step = b.step as NodeId;
  const video = b.video ? String(b.video) : undefined;
  // Pick's settings sent with the step are saved first: they're its inputs, and may make it due.
  if (step === "pick" && video && (b.direction !== undefined || b.count !== undefined)) {
    savePickSettings(resolveVideo(video), { direction: b.direction, count: b.count === undefined ? undefined : b.count === null || b.count === "" ? null : Number(b.count) });
  }
  const why = b.force ? null : stepUpToDate(step, video, b.take ? String(b.take) : null, { direction: b.direction });
  if (why) return { skipped: why };
  const take = () => {
    if (!b.take) throw new Error("Pick a take first");
    return String(b.take);
  };
  switch (step) {
    case "transcript": return startTranscript(String(b.video));
    case "refstyle": return startRefStyle();
    case "brief": return startBrief(String(b.video));
    case "pick": return startPick({ video: String(b.video) });
    case "design": return startDesign(take());
    case "render": return startRender({ run: take(), only: b.only, force: !!b.force });
    case "check": return startCheck({ run: take(), only: b.only });
    case "coach": return startCoach({ video: b.video, direction: b.direction });
    default: throw new Error(`"${step}" isn't a step you can run`);
  }
}

/** Returns a Response for /api/* routes it owns, or null to let the caller continue. */
export async function handleApi(req: Request, url: URL, path: string): Promise<Response | null> {
  const m = req.method;
  const q = (k: string) => url.searchParams.get(k) ?? "";
  const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;

  try {
    // ── The workflow ───────────────────────────────────────────
    if (path === "/api/workflow") return json(workflowState(q("video"), q("take") || null));
    if (path === "/api/run" && m === "POST") {
      const b = await body();
      const r = startWorkflow({ video: String(b.video ?? ""), take: b.take, direction: b.direction, count: b.count });
      return json("skipped" in r ? r : { job_id: r.id });
    }
    if (path === "/api/step" && m === "POST") {
      const r = startStep(await body());
      return json("skipped" in r ? r : { job_id: r.id });
    }
    // Pick's settings (a direction and a clip count): its inputs for the next take.
    if (path === "/api/pick" && m === "PUT") {
      const b = await body();
      return json(savePickSettings(resolveVideo(String(b.video ?? "")), { direction: b.direction, count: b.count === "" ? null : b.count }));
    }
    const cancel = path.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (cancel && m === "POST") {
      if (!getJob(cancel[1])) return fail("Unknown job", 404);
      return json({ ok: cancelJob(cancel[1]) });
    }

    // ── 1 · Inputs: source video ───────────────────────────────
    if (path === "/api/upload" && m === "POST") {
      const name = basename(q("name")).replace(/[<>:"|?*\x00-\x1f]/g, "_");
      if (!VIDEO_EXTS.has(extname(name).toLowerCase())) return fail("Only video files (mp4, mkv, webm, mov, m4v)");
      const dir = VIDEOS_DIR;
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, name);
      // Stream to disk: source videos are often hundreds of MB.
      const writer = Bun.file(dest).writer();
      for await (const chunk of req.body!) writer.write(chunk);
      await writer.end();
      return json({ video: name, path: rel(dest) });
    }
    if (path === "/api/import" && m === "POST") return json({ job_id: startSourceImport(String((await body()).url ?? "").trim()).id });
    if (path === "/api/thumb") {
      const video = resolveVideo(q("video"));
      const t = Number(q("t") || 60);
      const key = createHash("sha1").update(`${video}|${t}`).digest("hex").slice(0, 16);
      const out = join(THUMBS, `${key}.jpg`);
      if (!existsSync(out)) {
        mkdirSync(THUMBS, { recursive: true });
        await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out]);
      }
      if (!existsSync(out)) return new Response("No frame", { status: 404 });
      return new Response(Bun.file(out), { headers: { "Cache-Control": "max-age=86400" } });
    }

    // ── 1 · Inputs: style reference (clip + copy guide) ────────
    if (path === "/api/reference") {
      if (m === "DELETE") return json(clearReference());
      return json({ reference: readReference(), pendingGuide: pendingGuide() });
    }
    if (path === "/api/reference/upload" && m === "POST") {
      const name = basename(q("name"));
      if (!VIDEO_EXTS.has(extname(name).toLowerCase())) return fail("Only video files (mp4, mkv, webm, mov, m4v)");
      return json(await addReferenceFile(name, req.body!));
    }
    if (path === "/api/reference/import" && m === "POST") return json({ job_id: startRefImport(String((await body()).url ?? "").trim()).id });
    if (path === "/api/reference/guide" && m === "PUT") return json(setGuide(String((await body()).guide ?? "")));

    // ── 2 · Understand: transcript, vision, your notes ─────────
    if (path === "/api/transcript") {
      const video = resolveVideo(q("video"));
      return json({ segments: readTranscript(video) ?? [], notes: readNotes(video) });
    }
    if (path === "/api/vision") return json(readVision(resolveVideo(q("video"))) ?? { shots: [] });
    if (path === "/api/notes" && m === "POST") {
      const b = await body();
      return json(addNote(resolveVideo(b.video), Number(b.t) || 0, String(b.text ?? "")));
    }
    if (path === "/api/notes" && m === "DELETE") {
      deleteNote(resolveVideo(q("video")), q("id"));
      return json({ ok: true });
    }
    if (path === "/api/feedback") {
      return new Response(feedbackDigest(resolveVideo(q("video"))) || "No feedback yet.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // ── 3 · Brief ──────────────────────────────────────────────
    if (path === "/api/brief") return json(readBrief(resolveVideo(q("video"))));

    // ── 4 · Design: the effects library and your files ─────────
    if (path === "/api/effects") {
      const cat = loadCatalog();
      const assets = await measureAssets(listAssets());
      return json({
        effects: cat.effects.map(({ name, kind, timing, description, tags, params, duration, origin }) => ({ name, kind, timing, description, tags, params, duration, origin })),
        notes: cat.notes,
        assets: assets.map((a) => ({ kind: a.kind, name: a.name, file: rel(a.file), size: a.size, duration: a.duration })),
        folders: ASSET_FOLDERS, assetsDir: rel(ASSETS_DIR), effectsDir: rel(EFFECTS_DIR),
      });
    }
    if (path === "/api/assets/open" && m === "POST") {
      ensureAssetsDir();
      Bun.spawn(process.platform === "win32" ? ["explorer.exe", ASSETS_DIR] : [process.platform === "darwin" ? "open" : "xdg-open", ASSETS_DIR]);
      return json({ ok: true });
    }
    if (path === "/api/assets/upload" && m === "POST") {
      const kind = q("kind") as AssetKind;
      if (!(kind in ASSET_FOLDERS)) return fail(`kind must be one of ${Object.keys(ASSET_FOLDERS).join(", ")}`);
      const name = basename(q("name")).replace(/[<>:"'|?*\x00-\x1f]/g, "_");
      if (!name || name.startsWith(".")) return fail("Name the file");
      ensureAssetsDir();
      const dest = join(ASSETS_DIR, ASSET_FOLDERS[kind], name);
      const writer = Bun.file(dest).writer();
      for await (const chunk of req.body!) writer.write(chunk);
      await writer.end();
      const added = listAssets().find((a) => a.file === dest);
      if (!added) {
        rmSync(dest, { force: true });
        return fail(`That kind of file can't go in ${ASSET_FOLDERS[kind]}/`);
      }
      return json({ kind, name: added.name, file: rel(dest) });
    }

    // ── 5 · Review: your verdict per clip, nudges, comments, finish ──
    const rv = path.match(/^\/api\/takes\/([^/]+)\/(review|finish|comment|clip\/(\d+))$/);
    if (rv) {
      const takeId = rv[1];
      runDir(takeId);
      if (rv[2] === "review") return json(readReview(takeId));
      const b = await body();
      if (rv[2] === "finish") return json(setApproved(takeId, b.done !== false));
      if (rv[2] === "comment") {
        if (m === "DELETE") return json(deleteComment(takeId, q("id")));
        if (!String(b.text ?? "").trim()) return fail("Empty comment");
        return json(addComment(takeId, String(b.text), b.clip == null ? undefined : Number(b.clip), b.by === "agent" ? "agent" : "you"));
      }
      const clipId = Number(rv[3]);
      if ("status" in b) setClipStatus(takeId, clipId, b.status ?? undefined);
      if ("start" in b || "end" in b || "title" in b || "edit_enabled" in b) adjustClipEdges(takeId, clipId, b);
      return json({ review: readReview(takeId) });
    }

    // ── 6 · Learn: the coach's proposals and outline versions ──
    const cp = path.match(/^\/api\/coach\/([\w-]+)\/(apply|discard)$/);
    if (cp && m === "POST") return json(cp[2] === "apply" ? applyProposal(cp[1]) : discardProposal(cp[1]));
    if (path === "/api/outline/version") {
      if (m === "POST") return json(restoreVersion(String((await body()).hash ?? "")));
      return new Response(versionText(q("hash")), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // ── Workspace and key ──────────────────────────────────────
    if (path === "/api/workspace") {
      if (m === "POST") {
        // Remember another folder (or, when empty, go back to the default). The server reads its paths
        // at start, so it applies on relaunch.
        if (WORKSPACE_FIXED) return fail("MRCLIPPER_WORKSPACE is set, and it wins over the folder chosen here.");
        const root = String((await body()).root ?? "").trim().replace(/^"|"$/g, "");
        if (!root) {
          rmSync(WORKSPACE_CONFIG, { force: true });
          return json({ root: "", restart: true });
        }
        if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(root)) return fail(String.raw`Use a full folder path, like C:\Users\you\Videos\Clips`);
        mkdirSync(root, { recursive: true });
        await Bun.write(WORKSPACE_CONFIG, JSON.stringify({ root }, null, 2));
        return json({ root, restart: true });
      }
      return json({ root: ROOT, data: DATA_DIR, fixed: WORKSPACE_FIXED });
    }
    if (path === "/api/workspace/open" && m === "POST") {
      Bun.spawn(process.platform === "win32" ? ["explorer.exe", ROOT] : [process.platform === "darwin" ? "open" : "xdg-open", ROOT]);
      return json({ ok: true });
    }
    if (path === "/api/key") {
      if (m === "PUT") return json(await setBrowserKey(String((await body()).key ?? "")));
      if (m === "DELETE") return json(clearBrowserKey());
      return json(await keyInfo());
    }
  } catch (e) {
    return fail(e);
  }
  return null;
}
