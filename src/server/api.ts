// REST endpoints behind the UI's own controls (the Director reaches the same actions over MCP).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { ApprovalRequired, startAgentPlan, startBrief, startCheck, startCoach, startDesign, startRubric, startWatch, startExtract, startImport, startPlan, startTranscribe } from "./actions";
import { applyProposal, discardProposal, restoreVersion, versionText } from "./agents/coach";
import { readBriefCache } from "./agents/plan-jev";
import { clearBrowserKey, keyInfo, setBrowserKey } from "./key";
import { DATA_DIR, ROOT, VIDEO_EXTS, WORKSPACE_CONFIG } from "./config";
import { cancelJob, getJob } from "./jobs";
import { readClipData, readTranscript, rel, resolveVideo, runDir, writeClipData } from "./library";
import { run } from "./lib";
import { readVision, saveAgentLabels } from "./agents/vision";
import {
  addComment, addNote, addNudge, deleteComment, setClipRating, deleteNote, feedbackDigest, readNotes, readReview, readSettings, setApproved, setClipStatus,
  writeSettings,
} from "./review";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fail = (e: unknown, status = 400) =>
  json({ error: e instanceof Error ? e.message : String(e), approval: e instanceof ApprovalRequired }, status);

const THUMBS = join(DATA_DIR, "thumbs");

/** Returns a Response for /api/* routes it owns, or null to let the caller continue. */
export async function handleApi(req: Request, url: URL, path: string): Promise<Response | null> {
  const m = req.method;
  const q = (k: string) => url.searchParams.get(k) ?? "";
  const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;

  try {
    // ── Sources ──────────────────────────────────────────────────
    if (path === "/api/upload" && m === "POST") {
      const name = basename(q("name")).replace(/[<>:"|?*\x00-\x1f]/g, "_");
      if (!VIDEO_EXTS.has(extname(name).toLowerCase())) return fail("Only video files (mp4, mkv, webm, mov, m4v)");
      const dir = join(ROOT, "downloads");
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, name);
      // Stream to disk: source videos are often hundreds of MB.
      const writer = Bun.file(dest).writer();
      for await (const chunk of req.body!) writer.write(chunk);
      await writer.end();
      return json({ video: name, path: rel(dest) });
    }
    if (path === "/api/import" && m === "POST") {
      const job = startImport(String((await body()).url ?? "").trim());
      return json({ job_id: job.id });
    }
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
    // ── WebMCP: the browser agent's write paths ─────────────────
    if (path === "/api/webmcp/plan" && m === "POST") {
      const b = await body();
      return json({ job_id: startAgentPlan({ video: b.video, clips: b.clips, direction: b.direction, agent: b.agent }).id });
    }
    if (path === "/api/webmcp/labels" && m === "POST") {
      const b = await body();
      return json(saveAgentLabels(resolveVideo(b.video), Array.isArray(b.labels) ? b.labels : []));
    }
    if (path === "/api/feedback") {
      return new Response(feedbackDigest(resolveVideo(q("video"))) || "No feedback yet.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (path === "/api/webmcp/shots") {
      const vt = readVision(resolveVideo(q("video")));
      if (!vt) return fail("No shots yet. Run prepare_video first.");
      const limit = Math.min(24, Number(q("limit") || 12));
      const todo = vt.shots.filter((s) => !s.kind && !s.cont).slice(0, limit);
      return json({ total: vt.shots.length, unlabelled: vt.shots.filter((s) => !s.kind).length, shots: todo });
    }
    if (path === "/api/vision") {
      return json(readVision(resolveVideo(q("video"))) ?? { shots: [] });
    }
    if (path === "/api/transcript") {
      const video = resolveVideo(q("video"));
      return json({ segments: readTranscript(video) ?? [], notes: readNotes(video) });
    }
    if (path === "/api/notes" && m === "POST") {
      const b = await body();
      return json(addNote(resolveVideo(b.video), Number(b.t) || 0, String(b.text ?? "")));
    }
    if (path === "/api/notes" && m === "DELETE") {
      deleteNote(resolveVideo(q("video")), q("id"));
      return json({ ok: true });
    }

    // ── Jobs: start from the canvas, stop anything ──────────────
    if (path === "/api/jobs" && m === "POST") {
      const b = await body();
      const job =
        b.agent === "transcribe" ? startTranscribe(b.args) :
        b.agent === "plan" ? startPlan(b.args) :
        b.agent === "extract" ? startExtract(b.args) :
        null;
      if (!job) return fail(`Unknown agent ${b.agent}`);
      return json({ job_id: job.id });
    }
    const cancel = path.match(/^\/api\/jobs\/([\w-]+)\/cancel$/);
    if (cancel && m === "POST") {
      if (!getJob(cancel[1])) return fail("Unknown job", 404);
      return json({ ok: cancelJob(cancel[1]) });
    }

    // ── Review: approve, keep/drop, adjust, comment ─────────────
    const rv = path.match(/^\/api\/runs\/([^/]+)\/(review|approve|comment|check|design|watch|clip\/(\d+))$/);
    if (rv) {
      const runId = rv[1];
      runDir(runId);
      if (rv[2] === "review") return json(readReview(runId));
      const b = await body();
      if (rv[2] === "check") return json({ job_id: startCheck(runId, b.only).id });
      if (rv[2] === "design") return json({ job_id: startDesign(runId).id });
      if (rv[2] === "watch") return json({ job_id: startWatch(runId, !!b.force).id });
      if (rv[2] === "approve") return json(setApproved(runId, b.approved !== false));
      if (rv[2] === "comment") {
        if (m === "DELETE") return json(deleteComment(runId, q("id")));
        if (!String(b.text ?? "").trim()) return fail("Empty comment");
        return json(addComment(runId, String(b.text), b.clip == null ? undefined : Number(b.clip), b.by === "agent" ? "agent" : "you"));
      }
      const clipId = Number(rv[3]);
      if ("status" in b) setClipStatus(runId, clipId, b.status ?? undefined);
      if (b.start != null || b.end != null) addNudge(runId, clipId);
      if ("rating" in b) setClipRating(runId, clipId, b.rating === 1 || b.rating === -1 ? b.rating : undefined);
      if ("start" in b || "end" in b || "title" in b || "edit_enabled" in b) {
        const script = join(runDir(runId), "clip_script.md");
        const data = readClipData(script);
        const clip = data.clips.find((c) => c.id === clipId);
        if (!clip) return fail(`No clip ${clipId}`, 404);
        const e = clip.edit;
        if (e && "edit_enabled" in b) e.enabled = b.edit_enabled !== false;
        if (e?.segments.length && e.enabled !== false && (b.start != null || b.end != null)) {
          // With an edit, "in" is the first segment that plays and "out" the last one.
          const first = e.segments[0];
          const last = e.segments[e.segments.length - 1];
          if (b.start != null) first.start = Math.max(0, Number(b.start));
          if (b.end != null) last.end = Number(b.end);
          if (first.end <= first.start + 0.5 || last.end <= last.start + 0.5) return fail("That would leave a segment shorter than half a second");
          clip.start = Math.min(...e.segments.map((s) => s.start));
          clip.end = Math.max(...e.segments.map((s) => s.end));
        } else {
          if (b.start != null) clip.start = Math.max(0, Number(b.start));
          if (b.end != null) clip.end = Number(b.end);
        }
        if (b.title) clip.title = String(b.title);
        if (clip.end <= clip.start + 1) return fail("A clip needs at least a second between start and end");
        writeClipData(script, data);
      }
      return json({ review: readReview(runId) });
    }

    // ── Workspace: where videos, transcripts, clips and the outline live ──
    if (path === "/api/workspace") {
      if (m === "POST") {
        // Desktop app only: remember another folder; the server reads its paths at start, so it applies on relaunch.
        if (!WORKSPACE_CONFIG) return fail("Set CLIP_ROOT to change the workspace when running from source.");
        const root = String((await body()).root ?? "").trim().replace(/^"|"$/g, "");
        if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(root)) return fail(String.raw`Use a full folder path, like C:\Users\you\Videos\Clips`);
        mkdirSync(root, { recursive: true });
        await Bun.write(WORKSPACE_CONFIG, JSON.stringify({ root }, null, 2));
        return json({ root, restart: true });
      }
      return json({ root: ROOT, data: DATA_DIR, desktop: !!WORKSPACE_CONFIG });
    }
    if (path === "/api/workspace/open" && m === "POST") {
      Bun.spawn(process.platform === "win32" ? ["explorer.exe", ROOT] : [process.platform === "darwin" ? "open" : "xdg-open", ROOT]);
      return json({ ok: true });
    }

    // ── OpenRouter key (held in memory; the browser is the source of truth) ──
    if (path === "/api/key") {
      if (m === "PUT") return json(await setBrowserKey(String((await body()).key ?? "")));
      if (m === "DELETE") return json(clearBrowserKey());
      return json(await keyInfo());
    }

    // ── Brief and Outline coach (the two LLM nodes around System One) ──
    if (path === "/api/brief") {
      if (m === "POST") return json({ job_id: startBrief(String((await body()).video ?? "")).id });
      return json(readBriefCache(resolveVideo(q("video"))));
    }
    if (path === "/api/rubric" && m === "POST") {
      const b = await body();
      return json({ job_id: startRubric({ video: b.video, direction: b.direction }).id });
    }
    if (path === "/api/coach" && m === "POST") {
      const b = await body();
      return json({ job_id: startCoach({ video: b.video, direction: b.direction }).id });
    }
    const cp = path.match(/^\/api\/coach\/([\w-]+)\/(apply|discard)$/);
    if (cp && m === "POST") return json(cp[2] === "apply" ? applyProposal(cp[1]) : discardProposal(cp[1]));
    if (path === "/api/outline/version") {
      if (m === "POST") return json(restoreVersion(String((await body()).hash ?? "")));
      return new Response(versionText(q("hash")), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    // ── Settings ────────────────────────────────────────────────
    if (path === "/api/settings") {
      if (m === "PUT") return json(writeSettings(await body()));
      return json(readSettings());
    }
  } catch (e) {
    return fail(e, e instanceof ApprovalRequired ? 409 : 400);
  }
  return null;
}
