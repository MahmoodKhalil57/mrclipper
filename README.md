# Clipdesk

A cutting room for turning long videos into short clips. One [Think](https://developers.cloudflare.com/agents/harnesses/think/) agent (the **Director**) talks to you and hands the work to three crew agents over MCP:

| Crew | MCP endpoint | Tools |
|---|---|---|
| Transcriber | `/mcp/transcribe` | `list_videos`, `transcribe_video`, `transcribe_status`, `read_transcript` |
| Planner | `/mcp/plan` | `read_outline`, `update_outline`, `read_history`, `plan_clips`, `plan_status` |
| Editor | `/mcp/extract` | `list_runs`, `read_clip_script`, `adjust_clip`, `design_edits`, `extract_clips`, `extract_status` |

The crew are TypeScript ports of `transcribe.py`, `plan_clips.py` and `extract_clips.py` and read and write the same files (`transcripts/`, `clips/<run>/clip_script.md`, `clips/history.md`, `clip_outline.md`), so the Python scripts and the app can be used interchangeably.

## Making clips

1. **Add a video.** Drop a file anywhere on the window, click **+ Add video**, or paste a YouTube link (downloaded with `tools/yt-dlp.exe` into `downloads/`). Each video is a project; switch between them from the thumbnail menu in the top bar.
2. **Follow the canvas.** Each project is a node graph: Source → Transcript → Clip plan → Edit design → Review gate → Cut clips → Clips. The Outline feeds the Planner through the **Brief** (LLM), and the **Outline coach** (LLM) loops from Clips back into the Outline. The node marked *next step* has the button to press. Wires light up and nodes show live progress (transcript chunks, per-clip cutting) while agents work.
3. **Inspect anything.** Click a node to open what it produced:
   - Transcript: search it, click a line to play it, pin notes for the Planner.
   - Clip plan: switch between takes, give direction for a new take, and edit the outline or history.
   - Review: play each clip from the source, Keep or Drop it, nudge its in/out points, and comment on a clip or the whole take.
   - Clips: watch and download the finished files, and comment on them.
4. **Step in.** Every running job has **■ Stop**: on its node, in the tray at the bottom of the canvas, and in the panels. Stopping the Director's current turn is the ■ in its chat. With the **Review gate** on (top bar), nothing gets cut until you approve the take, and that applies to the Director too. Your comments, notes and keep/drop decisions are saved next to the files (`clips/<run>/review.json`, `transcripts/<video>/notes.json`). The Planner reads them before every new take, and the Director reads them with `read_feedback`.
5. **Or just ask.** The Director dock on the left drives the same crew in plain language, and the canvas updates as it works. Any comment has an *ask Director* link that sends it there.

## Vertical framing

When a 16:9 video becomes 9:16, each shot gets its own framing, based on faces measured locally with OpenCV's YuNet detector (`tools/faces.py`). This needs no cloud, so it works in every engine mode. The vision transcript measures two frames per shot and picks:
- **crop:** one person, or everyone who fits in a 9:16 window, framed on their faces.
- **split:** two people too far apart for one window, stacked as a split screen with each face in the upper third of its half.
- **fit:** a group. A square window around them, or the full frame if they're spread wider, over a blurred copy of the shot.

The Editor splits each segment at shot cuts, so the framing changes with every cut. Audio is read continuously per segment, so the splits don't click.

**Face tracking at render time.** People walk around inside a stage shot, so a fixed crop per shot ends up on an empty set or with someone half out of frame. Before rendering a vertical clip, the Editor samples faces every 0.5 s over exactly the ranges it cuts (one ffmpeg pass per shot part, local YuNet, about 3 s per clip), and turns them into a moving crop:
- It holds still inside a dead zone of 3.5% of the width.
- It pans at up to 0.22 widths per second, so it reads as a camera operator following, not a jittery tracker.
- It stays with the current person when the group is too spread to frame.

Split screens track each person separately. Tracks are cached in `clips/<run>/track/`.

Measured faces win over a planner's `reframe_x`, which now only steers shots where no one was measured. Older takes had `reframe_x: 0.5` on every segment, which forced a centre crop. Zoom effects apply only to crops: zooming a split screen or a fitted group trimmed the people at the sides.

On the worst flagged clips, re-rendering cut frames with a face cut by the edge from 9 to 1 and from 4 to 1 (of 14), and frames with no one in them from 7 to 2. What remains is mostly split screens that pair the wrong two people in a crowded shot: picking who's talking would need speaker detection.

One-time setup, from `app/`:

```sh
uv venv .data/py --python 3.12
uv pip install --python .data/py/Scripts/python.exe opencv-python-headless numpy
curl -L -o .data/models/face_detection_yunet_2023mar.onnx https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
```

Without it, crops stay centred and the Transcriber logs a warning.

## Creative edits

Each clip is an **edit decision list**, not a single range:
- **segments:** source ranges in play order, so a cold open can put the payoff first
- **a transition between each pair:** `cut`, `crossfade`, `dip_black`, `slide`, `zoom`, `whip`, `flash` (white), `iris` or `blur`
- **per-segment effects:** `punch_in`, `slow_push`, `ken_burns`, `zoom_out` (pull back), `drift`, speed 0.8–1.5×, a horizontal reframe for the vertical crop, and a flashback look (`bw` or `sepia`)
- **whole-clip finishing, set in the outline:** colour grade (`subtle`, `punchy`, `warm`, `cinematic`, `nostalgic`), vignette, film grain, glow, letterbox bars, and a fade in and out
- **a hook title card**
- **emphasis words**

The outline's **Story structure**, **Editing style**, **Visual effects**, **Captions style** and **Title card** sections set the rules. Their bold labels are read by the Editor: max segments, pause threshold, allowed transitions and zooms, transition length, colour grade, vignette, caption font, size, colours and position, and title duration.

- **LLM Planner:** writes the EDL per clip.
- **Browser agent (WebMCP):** can pass one in `submit_plan`.
- **Jev and Hybrid:** start from the deterministic default below, then the **Edit design** step picks the moves and transitions (see Crew engines).
- **Any other plan without an EDL:** gets the deterministic default. Pauses over the threshold are removed, long stretches are cut at line boundaries every ~4–6 s, framing alternates 100/112% (jump cuts), archive photos get Ken Burns, and the crop follows the subject from the vision transcript.

Every EDL is validated: snapped to whole words, capped to the allowed effects and segment count, and checked on its edited length.

The Editor renders it with an ffmpeg filter graph (per-segment inputs, `zoompan`, `xfade`/`acrossfade`, `eq`, `vignette`). Captions and the title are an ASS file rendered by libass. Captions light up word by word from the measured word timings, emphasis words appear in their own colour, and Arabic shaping works because it goes through libass.

In Review, each clip shows its edit as a timeline. The creative-edit switch falls back to the plain cut. **In** and **Out** move the first and last segments. Slow push and Ken Burns are the slowest effects to render, at about 1.5× real time. Takes planned before this change have no EDL and still cut the plain way.

## Transcript timing

Gemini writes the transcript text because it's the most faithful to the dialect, but its timestamps are guesses. So the Transcriber runs a second pass with `openai/whisper-large-v3` (about $0.02 per 36-minute video; set `TIMING_MODEL` to change it) to measure when each word is spoken. It then aligns Gemini's words onto Whisper's words, using Arabic-normalised fuzzy matching and Gemini's rough times as a guide. Whisper's text is thrown away; only its timings are kept.

Each line then starts at its first word and ends at its last. Lines longer than 9 s are split at punctuation or the longest pause. Captions are timed from those word times too. `transcript.json` stores the times to the millisecond, a `words` array per line, and `timing: "aligned" | "estimated"`. If too few words match in a chunk (music, the outro), that chunk keeps Gemini's estimates. On an old transcript, the Transcribe node shows **⏱ Measure timing**; the Gemini text stays cached, so only the timing pass runs.

## Vision transcript

The Transcriber also records what's on screen, so the Planner can see the video as well as hear it.

1. **Shots:** ffmpeg scene-change detection finds the cuts, measured to the millisecond. Flashes under 0.8 s are merged into the previous shot, and shots over 8 s are sampled every 8 s. A 36-minute episode gives about 510 shots, and detection takes about 70 s.
2. **Labels:** a frame from the middle of each shot goes to `google/gemini-2.5-flash-lite` (set `VISION_MODEL` to change it), 12 frames per request. Each label has a kind (host close-up or wide, footage, archive photo, map, graphic, text card, animation), a short description, on-screen text, number of people, and a rough horizontal position for the main subject. About $0.035 per episode.
3. **Clean-up:** text that appears on more than 20% of shots, such as a burned-in hashtag or logo, counts as an overlay. It's removed from the shots and listed once under `overlays`.

The output goes in `transcripts/<video>/vision/`: `vision.json`, a readable `vision.txt`, and `frames/` (also used as thumbnails in the UI). Every step is cached. How each part uses it:
- **LLM Planner:** gets the shot log next to the transcript and is asked to favour clips where the picture carries the story and survives a 9:16 crop.
- **Jev Planner:** adds a *visuals* decision per candidate, plus a measured *9:16-safe* share (screen time where the subject falls inside a centred vertical crop).
- **Director:** can query it with `read_vision`.
- **UI:** the Transcript panel has a **Vision** tab, and every clip in Review shows its shots.

The subject position comes from the vision model's guess, and flash-lite tends to call things centred, so read 9:16-safe as optimistic.

## WebMCP mode: a workflow shell for your browser's agent

The third engine, **WebMCP**, takes OpenRouter out of the server entirely. Every hosted-model call path refuses to run in this mode: chat completions, Jev and speech-to-text. The thinking moves to whatever agent runs in your browser, which drives Clipdesk through [WebMCP](https://developer.chrome.com/docs/ai/webmcp) tools that the page registers with `document.modelContext`.

**What the server still does:** only deterministic work.
- Keeps an existing transcript. If there's none, it imports YouTube's captions with `yt-dlp`; they come with per-word timings, so the result is measured.
- Detects shots and grabs frames with ffmpeg.
- Validates plans by snapping to line boundaries, enforcing the outline's length range and rejecting overlaps. Rejected clips come back with a reason.
- Cuts with ffmpeg and enforces the review gate.

**What the agent does,** with its 19 tools:
- reads the workflow, outline, feedback, history, transcript and vision in windows
- labels shots (`get_unlabelled_shots` → `label_shots`)
- submits plans (`submit_plan`), adjusts clips and comments
- requests cuts

There's no approve tool, so a take can only be approved by you. The **Agent** panel replaces the Director chat. It shows whether WebMCP is available, a brief you can paste to your agent, a live log of every tool call with its input and output, and a manual runner for trying tools yourself.

Requirements: Chrome 149+ with `chrome://flags/#enable-webmcp-testing` (or the origin trial), and an agent in the browser that speaks WebMCP. Chrome's [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension lets you call the tools by hand. The desktop app's WebView2 doesn't expose WebMCP yet, so use Chrome at `http://127.0.0.1:4477`.

## Crew engines: LLM, Hybrid or System One

The **Crew engine** switch in the top bar sets who does the crew's thinking. You can also pick an engine for a single take in the Plan panel. The Director is an LLM in every mode. So is the Transcriber, because Jev can't take audio.

| | LLM (classic) | Hybrid (LLM + Jev) | System One (Jev) |
|---|---|---|---|
| Planner | One LLM call reads the whole transcript and writes the clip list, with titles, hooks and reasons. | An LLM compiles the outline into Jev's brief, then Jev scores every candidate. | Code proposes candidates; [Jev](https://openrouter.ai/typesafe) answers fixed typed questions about each; code ranks them. |
| Edit design | Written by the LLM with the plan | Jev picks moves and transitions using the brief's guidance, then the LLM writes titles and emphasis | Jev picks moves and transitions using standard guidance |
| Editor | ffmpeg | ffmpeg, after a Jev pre-flight | ffmpeg, after a Jev pre-flight that logs edge warnings (it never blocks or edits the cut) |
| Output | Prose titles and reasons | Prose titles, the LLM's reason, and a breakdown of the brief's own scores | Placeholder titles like "Shocking fact · 21:37", plus a score breakdown for every clip |

The Jev Planner runs in passes. Every line is scored as a possible opener (does it hook, does it work cold) and as a possible ending (does it land, is the thought complete). The best openers are paired with good endings of an allowed length. Jev then judges each candidate window on fit to the outline, whether it stands alone, respect for sensitive topics, tone, your direction, and your earlier feedback. Selection is greedy: no overlaps, spread across tones, and moments from earlier takes scored down. On a 36-minute video that's about 1,000 decisions in about 20 s for about $0.03. Scores are saved in `clips/<run>/jev.json`, runner-ups included.

**Hybrid** adds an LLM step between the outline and System One, so Jev's questions change with the outline instead of being fixed. One call (`MODELS.plan`, about $0.005) reads the outline, your feedback and direction, and a sample of the transcript. It writes a **brief**:
- opener, ending and clip questions, with weights
- tone categories and which tones to prefer
- up to two safety gates, capped at 0.5 (if too few candidates pass, the gates relax and the rest are scored down 25% instead of the plan failing)
- a "use when…" line for each allowed camera move and transition

Jev then answers those questions for every candidate, as in System One. The brief is its own node on the canvas, between the Outline and the Planner. It's compiled once per video and outline version, and Hybrid takes reuse it until the outline changes, so re-planning costs no LLM call. Your per-take direction goes to Jev directly. The cache is `transcripts/<video>/jev_brief.json`, and each take keeps a copy in `clips/<run>/jev.json`.

**Edit design** is the step between the Planner and the Editor, and it has its own node. For each clip, Jev chooses:
- a camera move for every segment, from the outline's allowed zooms
- whether a segment is a flashback, which gives it the outline's flashback look
- a transition for every gap, from the allowed transitions, knowing what was skipped and whether it leads into the final part

At most one flash is kept per clip. When two parts in a row get the same move, Jev's runner-up is used if it scored at least 15%. The last part gets zoom_out if Jev is at least 60% sure it's the final beat. In Hybrid, the LLM then writes the title, the hook card and emphasis words (only words actually spoken) for the final clips. The Edit design panel shows every choice with Jev's odds, and **Redesign** re-runs it (`POST /api/runs/:id/design`, or the Director's `design_edits`). Redesigning an approved take sends it back to review. Decisions are saved in `clips/<run>/design.json`. Takes planned by the LLM or a browser agent skip this step; their edits come with the plan.

**Jev edge check** (Review panel, or the Director's `check_clips` tool) works on takes from either engine. For each clip it rates whether the in and out points are clean and suggests better lines nearby. You apply a suggestion with one click; it never changes a clip by itself. Results go in `clips/<run>/jev_qa.json`. The model defaults to `~typesafe/jev-latest`; set `JEV_MODEL` in `.env` to change it.

## Outline coach: learning an outline that one-shots

The feedback row runs under the canvas from right to left: **Clips → Clip transcript → Rubric (LLM) → Outline coach → Outline**.

**Clip transcript** is the Transcriber pointed at the finished files, so the coach judges what was rendered, not the plan. For each clip:
- Whisper on the audio
- a frame every ~3 s with local face detection, which flags anyone cut off by the 9:16 edge
- one cheap vision check per clip for framing, readable captions and visible effects

It costs about $0.001 a clip and is saved in `clips/<run>/watch/`. It's cached until the clip is re-cut, and the coach runs it for any clip in its evidence that hasn't been watched.

The coach depends on the Crew engine, like every other step:
- **LLM:** one LLM call reads the evidence, including the clip transcripts, and writes a revised outline.
- **Hybrid:** the **Rubric** node (one LLM call) turns the outline and your reviews into 6–12 checkable rules. It also writes two rewrites for each section (up to three) that the evidence says is hurting clips. Jev then rates every finished clip on every rule, without seeing your verdict. Code compares how often each rule is followed on clips you kept or liked vs dropped or disliked. For each flagged section, Jev chooses between keeping it and each rewrite, given those numbers and your comments. A rewrite is applied only with at least 40% and a 10-point lead over the next option, and code assembles the outline from the winners.
- **System One:** a scorecard only, with one rule per outline section and no rewrites.

The scorecard (`outlines/scorecards/`) and the rubric (`outlines/rubrics/`) are shown in the Coach and Rubric panels.

The rest of this section applies in every mode. The coach's output wires back into the Outline.
- **Versions:** every take saves the outline it was planned with (`clips/<run>/outline.md`). Every distinct outline becomes a version in `outlines/ledger.json`, with its text in `outlines/versions/`.
- **Reward:** your review scores the take. The **one-shot score** (0–100) is the share of clips kept, ×0.85 if the take wasn't approved, ×0.9 per clip whose edges you nudged, and ×0.95 per comment on a clip you didn't 👍. A 👎 on a finished clip (Clips panel) counts as a drop. That rating is the strongest signal, because approving mostly means "worth cutting". A version's score is the mean over its reviewed takes.
- **Proposal:** **Coach outline** sends one LLM call (about $0.01) with:
  - the current outline
  - evidence from this video's recent takes and a few reviewed takes from other videos: each clip's status, rating, nudges, comments, Jev's low sub-scores, its moves, and its opening and closing lines
  - the two best-scoring earlier versions, and how each earlier coach change moved the score
  - the clip history log

  It returns a revised outline with a hypothesis, what it kept, and each change with its evidence. Proposals are saved in `outlines/proposals/`.
- **You apply it.** The Coach panel shows the diff: **Apply**, **Apply and plan a new take**, or **Discard**. You can **Restore** any earlier version. The Director can propose (`coach_outline`, `outline_scores`) but can't apply.

Takes planned before versioning show as "outline not recorded". They still count as evidence, but not toward a version's score.

## How it runs

```
Bun process (server.ts)                         wrangler dev → workerd
├─ UI (dist/ui)                                 └─ Director (Think Durable Object)
├─ /agents/*  ── HTTP + WebSocket proxy ──────►     model: OpenRouter
├─ /mcp/*     ◄── MCP (Streamable HTTP) ─────────   tools: the three crew servers
├─ /api/*     library, jobs, SSE events, outline/history editing
└─ /files/*   clip previews (Range requests)
```

Think needs the Workers runtime, so the Bun server launches the prebuilt worker bundle with `wrangler dev --no-bundle` and stops it on exit. The crew run in Bun because they need ffmpeg and the project folder. Long jobs return a `job_id` right away and the Director polls the matching `*_status` tool, which waits up to 50 s per call.

Models are cheap by default: Director and Planner use `z-ai/glm-5.3-flash`, and the Transcriber uses `google/gemini-2.5-flash` for audio. You can override them in the project `.env` with `DIRECTOR_MODEL`, `PLAN_MODELS` (comma-separated) and `TRANSCRIBE_MODEL`.

## Requirements

- Bun 1.2+, Node 18+ (wrangler runs on Node), ffmpeg/ffprobe on `PATH`
- An OpenRouter key, added in the app (see below). No file to edit.
- For the Windows app: [Hutch](https://hutch.blackboard.sh) (installed automatically by `npx electrobun init`, or from its site)

## The OpenRouter key

The key's source of truth is the app's browser storage (localStorage, per origin `http://127.0.0.1:4477`). On first open, the **🔑 Add key** button in the top bar opens a prompt. A key is checked with OpenRouter before it's accepted, and the prompt then shows its label, spend and limit.
- **Server:** the page pushes the key to the server on every (re)connect, and the server holds it in memory only. Nothing is written to disk, so there's no setup step after installing the desktop app.
- **Director worker:** it has no key of its own. On every model call it fetches the key from the server's `/internal/key`, with a random token made at each launch, so a new key takes effect without a restart.
- **Where it's stored:** the desktop app keeps its WebView2 profile under `%LOCALAPPDATA%\dev.clipdesk.cuttingroom\<channel>\WebView2`, so the key survives restarts. Dev and stable builds each have their own.
- **Fallback:** `OPENROUTER_KEY` in the environment or the project `.env` is still read, for the headless CLI. A key from the browser always wins.

## Commands

```sh
bun install
bun run build          # worker bundle + UI + server into dist/
bun run start          # browser: http://127.0.0.1:4477
bun run desktop        # Windows app window (Electrobun dev build)
bun run desktop:build  # Windows installer into artifacts/
```

Run the Hutch commands from PowerShell, not Git Bash. Git Bash's GNU `tar` can't extract Hutch's downloads.

## The desktop app

`src/desktop/index.ts` is the Electrobun main process, running on the Bun runtime (`mainProcess: "bun"`). It starts the same server in-process and opens a native WebView2 window on it.

**The installer is standalone.** It needs nothing installed on the machine and no setup: no Node, ffmpeg, Python or `.env`. `bun run desktop:build` runs `scripts/vendor.ts`, which collects everything the app runs into `vendor/`. Electrobun then packs it next to the app, under `Resources/app`:

| Bundled | What | Replaces |
|---|---|---|
| `dist/ui`, `dist/worker` | the UI and the Director bundle | the source checkout |
| `runtime/workerd.exe` | Cloudflare's Workers runtime, running the Director directly (`src/server/workerd.ts` writes its config) | Node + `wrangler dev` |
| `runtime/ffmpeg.exe` | gyan.dev essentials build: libass, fribidi and harfbuzz for Arabic captions, x264. Duration and size come from `ffmpeg -i`, so no ffprobe. | ffmpeg/ffprobe on `PATH` |
| `runtime/yt-dlp.exe` | YouTube imports and captions | `tools/yt-dlp.exe` |
| `runtime/faces/` | `tools/faces.py` compiled with PyInstaller (OpenCV YuNet) | the Python venv |
| `models/`, `templates/` | the face model and the starter outline | `.data/models`, your own outline |

Where things live when installed:
- **App state** goes to `%LOCALAPPDATA%\Clipdesk`: settings, thumbnails, Director storage, and the workspace choice.
- **The workspace** is `Documents\Clipdesk` by default: videos, `transcripts/`, `clips/` and `clip_outline.md`. It's created on first launch with the starter outline. **Change…** under the project menu (or on the empty-workspace screen) points the app at another folder, such as an existing project, from the next launch.
- **The OpenRouter key** is asked for in the app (see above).

The installer is about 350 MB unpacked. Most of it is workerd, ffmpeg and OpenCV.

Running from source (`bun run start`, `bun run desktop`) still uses the checkout. It uses workerd from `node_modules` (set `CLIPDESK_WRANGLER=1` to use `wrangler dev` instead), plus ffmpeg and yt-dlp from `PATH` or `tools/`, and the venv for face detection.

## Settings

| Variable | Default | |
|---|---|---|
| `CLIPDESK_PORT` | 4477 | UI, API and MCP |
| `CLIPDESK_WORKER_PORT` | 8799 | internal Director (workerd) port |
| `CLIPDESK_DATA` | `.data` | app state (the desktop app uses `%LOCALAPPDATA%\Clipdesk`) |
| `CLIP_ROOT` | `..` | project folder with videos, `transcripts/`, `clips/` |
