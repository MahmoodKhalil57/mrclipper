# mrClipper

mrClipper turns a long video into short vertical clips. It runs one workflow of thirteen steps in six phases, all shown as a node graph, and every step follows the same rule:

> **Code measures, the LLM writes, Jev judges, you decide.**

- **Code** does whatever can be measured or computed: transcripts' word timings, shots, faces, candidate clips, ranking, rendering, statistics.
- **The LLM** (`z-ai/glm-5.3-flash`) writes: the brief, hook-card options, outline rewrites. It never makes the final choice.
- **[Jev](https://openrouter.ai/typesafe)** (a System One decision model) judges: it answers typed questions (yes/no, pick one, score) with probabilities, so every choice is saved with its odds.
- **You** give the inputs, review the finished clips, and decide whether the outline changes.

If an LLM step fails, a built-in default takes its place and the workflow carries on.

## Quick start

You need [Bun](https://bun.sh) 1.2.15 or newer, and an [OpenRouter](https://openrouter.ai/settings/keys) key.

```sh
git clone <this repo> mrclipper
cd mrclipper
bun i
bun dev
```

Open http://127.0.0.1:4477 and add your OpenRouter key when the app asks (🔑 Key in the top bar).

The first `bun dev` also gets the tools mrClipper runs, into `.store/tools/`. Later runs skip this step.
- **ffmpeg**, with libass and x264: yours from `PATH` if it has them, else a static build (gyan.dev on Windows, BtbN on Linux). On macOS, run `brew install ffmpeg` first.
- **yt-dlp**, for link imports: yours from `PATH`, else the standalone binary.
- **Face detection**, for 9:16 framing: the YuNet model, plus Python and OpenCV installed with [uv](https://docs.astral.sh/uv/). uv is downloaded too if you don't have it.

The app starts even if one of these fails, and says what's missing; `bun run setup` tries again. Nothing else is needed: no Node, no Python, no global installs.

On Windows, clone into a folder whose path is under about 150 characters. The Director keeps each conversation in a file with a long name, and Windows can't open paths over 260 characters; mrClipper warns when it starts if yours would go over.

## Where things go

Everything a checkout writes stays inside it, in `.store/` (gitignored):

| Folder | What's in it |
|---|---|
| `.store/workspace/` | the **workspace**: your videos (`videos/`), `transcripts/`, `clips/`, `outlines/`, `references/`, your files for edits (`assets/`) and your own effects (`effects/`), and `clip_outline.md`, which starts as a copy of `templates/clip_outline.md` |
| `.store/state/` | settings, thumbnails, job history, and the Director's conversations |
| `.store/tools/` | ffmpeg, yt-dlp, the face model and its Python |

To keep clips somewhere else, use **Change…** next to the workspace path in the project menu (it applies from the next start), or set `MRCLIPPER_WORKSPACE`. Delete `.store/` to start over. Settings go in `.env` (copy `.env.example`), and none are needed.

A checkout from before the rename (Clipdesk) moves its `.data/` into `.store/` on its first start, and keeps using the folder above it as its workspace.

## The workflow

Paths in the last column are inside the workspace.

| Phase | Step | Who | What it makes | Saved in |
|---|---|---|---|---|
| **1 Inputs** | Source video | you | the long video | `videos/` |
| | Outline | you | who the clips are for and how to cut them | `clip_outline.md` |
| | Reference clip | you, optional | a finished short whose style to copy | `references/<id>/` |
| | Copy guide | you, optional | what to copy from it, in your words | `references/<id>/reference.json` |
| **2 Understand** | Transcript | Transcriber | what's said, with measured word timings, and what's on screen, shot by shot | `transcripts/<video>/` |
| | Reference style | Transcriber | the reference measured and described, focused on the copy guide | `references/<id>/reference.json` |
| **3 Brief** | Brief | LLM writes | Jev's questions for picking clips, edit and hook-card guidance, and the rules every finished clip is checked on | `transcripts/<video>/brief.json` |
| **4 Make** | Pick clips | Jev judges | a new **take**: the best clips that don't overlap | `clips/<take>/clip_script.md`, `take.json`, `jev.json` |
| | Design edits | LLM writes, Jev judges | an edit per clip from the effects library and your files (two plans, Jev picks one), the hook card and emphasis words | `clips/<take>/design.json` |
| | Render | code | the finished 9:16 clips | `clips/<take>/*.mp4`, `render.json` |
| | Check | Transcriber + Jev | each clip heard and watched, then rated on the brief's rules and its in and out points | `clips/<take>/check.json`, `watch/` |
| **5 Review** | Review | you | keep or drop each clip, nudges, comments | `clips/<take>/review.json` |
| **6 Learn** | Coach | LLM writes, Jev picks | a proposal for the next outline version, which you apply or discard | `outlines/` |

The Coach's output wires back into the Outline, which closes the loop: the next take is made from the version you applied.

## Making clips

1. **Add a video.** Drop a file on the window, click **+ Add video**, or paste a YouTube link. Each video is a project; switch between them from the thumbnail menu in the top bar.
2. **Check the outline.** A new workspace starts from a template. Its bold settings are rules: clip count and length, the transitions, camera moves and effects allowed, music, captions, the colour grade. Its prose steers the edit.
   Put any sound effects, music, GIFs and stickers you want used in the workspace's `assets/` folder.
3. **Optionally add a style reference.** On the Reference clip node, upload a short (or paste a TikTok, Reels or Shorts link) and say what to copy from it: "the fast cuts and the two-word captions".
4. **Press ▶ Run.** It does every step that isn't done, in order, and stops at Review. The button shows how many steps it will do; hover it to see which. **■ Stop run** stops the current step too.
5. **Review** the finished clips. Each one plays next to its Check card (how it did on the brief's rules, and whether its edges are clean). **Keep** or **Drop** it, nudge its **In** and **Out** points, and comment. Then **Finish review**. Clips you don't drop count as kept.
6. **Coach** the outline. Press **▶ Coach**, read the proposed diff, and then choose one:
   - **Apply**
   - **Apply and make a new take**
   - **Discard**

   **Restore** brings back any earlier version.

Click any node to see what it made. Every node also has its own ▶ button to run just that step, and every running job has ■ Stop: on its node, in the tray under the canvas, and in the panels.

**Steps are idempotent.** Every output records fingerprints of the inputs it was made from. While they still match, the step is up to date: its button reads **✓ Up to date** and is off, because running it again would give the same result. The server refuses the re-run too, so the Director can't repeat a step either. To run a step again, change one of its inputs; going back to earlier inputs brings back what was already made from them.

### Node states

Every node is in one of these states, computed the same way for all of them from what's on disk and which jobs are running:

| State | Meaning |
|---|---|
| add it · optional | an input you haven't given (the reference and copy guide are optional) |
| waiting | needs an earlier step first |
| ready | can run now |
| running | working; ■ Stop is on the node |
| done | up to date with its inputs; it won't run again until one of them changes |
| out of date | ▶ Run will redo it: an input changed since it was made, or a step before it runs again |
| your turn | Review, or a Coach proposal to apply or discard |
| failed · stopped | the last run of it failed or you stopped it |

What makes each step out of date:
- **Transcript:** it has no vision transcript, or its word timings weren't measured.
- **Reference style:** the copy guide changed.
- **Brief:** the outline or the style reference changed, or an update to mrClipper changed how briefs are written. It's cached per video, so re-running costs no LLM call until one of those happens.
- **Pick clips:** the take was made from an older brief, or Pick's settings (a direction and a clip count, in its panel) changed, or your transcript notes did, or the transcript did. A take never changes its inputs, so ▶ Run makes a new take, unless an earlier take was made from exactly the current inputs: then that take is shown again and nothing runs. Takes made before this version of the workflow show as out of date.
- **Design edits:** your `effects/` or `assets/` changed since it ran, or it was designed before the effects library.
- **Render:** a clip's edit changed (for example, you nudged an edge), or an effect or file it uses changed. Only that clip is rendered again.
- **Check:** a clip was rendered again since it was checked.
- **Any step after one that runs again:** for example, Check after Render, or Design, Render and Check when Run makes a new take.

The Coach is ready when what it learns from changed since it last ran: new reviews or checks on the takes it reads, the outline, or the style reference. A new direction typed in its panel counts too. ▶ Run coaches only when nothing else is due and you've finished reviewing the latest take.

## The steps in detail

### Brief (LLM writes)

This is the one place an LLM turns your inputs into what every judge uses. One call (about 15 s and $0.0016) reads the outline, the style reference and copy guide, and a sample of the transcript. Your reviews reach it only through the Coach, as outline changes, so reviewing a take doesn't put the brief out of date. It writes:
- **for Pick:** questions about openers, endings and whole clips, with weights. It also sets the tone categories, which tones to prefer, and up to two safety gates (capped at 0.5; if too few clips pass, the gates relax and the rest are scored down instead of the take failing).
- **for Design:** a "use when…" line for each allowed camera move and transition, and how hook cards should read.
- **for Check:** 5 to 10 checkable rules from the outline, plus one per style-reference trait.

If the call fails, a built-in brief made from the outline takes over.

### Pick clips (Jev judges)

Jev can't write a clip list, so the work is split up: code proposes candidates, Jev answers the brief's questions about each, and code ranks and picks. There are four passes:
1. **Openers:** every line is scored as a possible opener.
2. **Endings:** every line is scored as a possible ending.
3. **Clips:** the best openers are paired with good endings of an allowed length. Jev judges each pair on the brief's clip questions, tone, your direction, your earlier feedback and the visuals.
4. **Selection:** by score, with the safety gates, no overlaps, and a spread across tones. Moments used in earlier takes are scored down.

On the 10-minute test video that was 493 decisions in 10 s for $0.016.

Pick's inputs are the brief, the transcript, your notes pinned to transcript lines, and its own settings: a direction for Jev and a clip count, saved per video in its panel. Change a setting and the panel offers **▶ Make a new take** (Run: Pick, Design, Render, Check), **Pick only**, or **Save** for a later Run. If an earlier take was picked with exactly those settings and the same other inputs, it offers **↩ Back to take N** instead, which brings that take back without running anything.

### Design edits (LLM writes, code checks, Jev judges)

Design edits each clip like a professional editor would, from the effects library (below) and your files in `assets/`. For every clip:
1. **The LLM plans two edits.** It reads the outline, the brief, the style reference, the clip's words (numbered, with times) and what's on screen, and writes two genuinely different plans. Each plan covers a camera move, looks, speed, freeze frames or reversing for each part, a transition for each join, and effects on the timeline: text, graphics, your GIFs and stickers, generated or file sounds, treatments of the clip's own voice, music, and video effects over a time range. Hits land on words: "a zoom punch and an impact at word 23".
2. **Code checks each plan.** It keeps only what the outline allows (below), what exists (effects, your files) and what lands on a real moment of the clip. It caps the amount at the outline's effect intensity and keeps the clip under its maximum length. Then it test-runs each plan in ffmpeg. An effect that doesn't render is found and dropped. Every change is noted.
3. **Jev picks the plan** a professional short-form editor would choose for this clip, given the brief, the outline's rules and the style reference.
4. **The hook card and emphasis words:** one LLM call writes three hook-card options per clip in the clip's language, and Jev picks the one most likely to stop a scroller. The LLM also proposes up to five words from the clip, and Jev keeps up to three that carry its feeling.

The panel shows both plans with Jev's odds, what each one does, the checks' notes, and the chosen edit as a timeline, with lanes for picture, text and sound. If the LLM can't plan a clip, Jev picks a camera move per part and a transition per join instead, as before.

**What the outline controls.** Its bold settings are rules the plans must follow, so an outline can ask for a quiet, sad edit or a dense anime one:

| Setting | Controls | Example |
|---|---|---|
| **Transitions:** | the transitions allowed at joins | `crossfade, dip_black, blur` or `any` |
| **Zoom effects:** | the camera moves allowed per part | `slow_push, zoom_out, drift` or `any` |
| **Flashback look:** | the look allowed per part | `black and white` |
| **Effects:** | the timeline effects allowed; leave it out for all of them | `shake, zoom_punch, flash, speed_lines, big_text` or `none` |
| **Sound effects:** | the sounds allowed; leave it out for all of them | `whoosh, impact, heartbeat` or `no` |
| **Background music:** | music under the clip, from `assets/music` | `yes`, or a file: `` `sad_piano.mp3` `` |
| **Music mood:** / **Music volume:** | which track fits, and how loud | `slow solo piano` / `low` |
| **Effect intensity:** | how much the planner does | `subtle`, `moderate` or `heavy` |
| **Loudness:** | the level every clip is mastered to | `-14 LUFS` (the default) or `off` |

The outline's prose steers the plans too ("slow motion on the quiet beat after the laugh"). The house style is applied to every clip anyway: the colour grade, vignette, grain, glow, bars, fades, captions and the hook card.

### Render (code)

ffmpeg renders each clip's edit in one run. The edit is more than a single range:
- **parts:** source ranges in play order, so a cold open can put the payoff first. Each part has its camera move and looks, a speed from 0.25× (slow motion) to 4×, an optional freeze frame at its end, and can play reversed (up to 3 s).
- **joins:** a cut, any of ffmpeg's 58 transitions, or an editor's transition, such as a flash cut, an impact cut (a flash plus a zoom punch), a glitch cut, a blur into a memory, or one of your GIFs played over the cut.
- **timeline effects**, each over its own time range: text, graphics, your overlays, sounds, voice treatments, music and video effects. A video effect's stretch is cut out, processed and spliced back, so an effect costs only its own frames.
- **sound:** the voice with its treatments, generated sounds and your sound files, and music ducked under speech, mixed and mastered to the outline's loudness (−14 LUFS unless it says otherwise, peaks under −1.5 dBTP).
- **whole-clip finishing, set in the outline:** a colour grade (`subtle`, `punchy`, `warm`, `cinematic` or `nostalgic`), vignette, film grain, glow, letterbox bars, and a fade in and out.
- **captions, the hook card and text effects:** one ASS file rendered by libass, so Arabic shaping works. Captions follow the measured word timings: `karaoke` lights each word as it's spoken, `pop` pops each word in as it's said, `box` puts karaoke on a box, and `plain` shows whole lines. Emphasis words get their own colour. Fonts in `assets/fonts` can be named as the caption font.

The video is H.264 at quality 20, capped at 12 Mbit/s. Film grain is noise the encoder can't compress, so without the cap a strongly grained minute came out at about 400 MB.

Rendering runs automatically; you review the finished files. `render.json` remembers what each file was rendered from, including the definitions of the effects and the files each clip uses. Only clips whose edit changed, or an effect or file they use, are rendered again. Slow push and Ken Burns are the slowest effects, at about 1.5× real time.

**Vertical framing.** When a 16:9 video becomes 9:16, each shot gets its own framing, based on faces measured locally with OpenCV's YuNet detector:
- **crop:** one person, or everyone who fits in a 9:16 window, framed on their faces.
- **split:** two people too far apart for one window, stacked as a split screen with each face in the upper third of its half.
- **fit:** a group, shown in a square window (or the full frame if they're spread wider) over a blurred copy of the shot.

People move around inside a shot, so before rendering, faces are sampled every 0.5 s over exactly the ranges being cut (about 3 s per clip). They become a moving crop:
- It holds still inside a dead zone of 3.5% of the width.
- It pans at up to 0.22 widths per second, like a camera operator following.
- It stays with the current person when the group is too spread to frame.

Split screens track each person separately. Zoom effects apply only to crops, because zooming a split screen or a group cut off the people at the sides. Tracks are cached in `clips/<take>/track/`.

### The effects library

About 160 effects, in nine kinds. **Browse the effects** in the Design panel lists them all with their settings.

| Kind | Where | Examples |
|---|---|---|
| camera moves, looks | a whole part | `slow_push`, `punch_in`, `zoom_out`, `ken_burns`, `drift`, `bw`, `sepia` |
| transitions | a join | `crossfade`, `dip_black`, `blur`, `flash_cut`, `impact_cut`, `glitch_cut`, `whip_blur`, `asset_wipe`, and every ffmpeg `xfade` |
| video effects | a time range | `zoom_punch`, `zoom_to`, `shake`, `spin`, `glitch`, `rgb_split`, `vhs`, `film`, `glow`, `edge_glow`, `motion_blur`, `trails`, `invert`, `grade`, `lut` |
| graphics | a time range | `flash`, `dip`, `border_glow`, `neon_border`, `speed_lines`, `light_leak`, `progress_bar` |
| text and shapes | a time range | `big_text`, `type_on`, `banner`, `lower_third`, `callout`, `arrow`, `circle`, `highlight_box` |
| your files | a time range | `overlay`: a GIF, a WebM or MOV with transparency, a PNG, or a green-screen clip, keyed |
| sounds | a moment or a range | `whoosh`, `impact`, `boom`, `riser`, `pop`, `ding`, `heartbeat`, `sparkle`, `typing`, `sad_drone`, `vinyl`, or `sfx` with your file |
| the clip's own audio | a time range | `reverb`, `echo`, `muffled`, `telephone`, `pitch`, `bass_boost`, `robot`, `mute`, `reverse_audio` |
| music | a time range | `music`: a track from `assets/music`, ducked under speech |

**Your files** go in the workspace's `assets/` folder: `sfx/`, `music/`, `overlays/`, `images/`, `luts/` and `fonts/`. Use **Open assets folder** or **＋ Add files** in the Design panel. Name them for what they are ("whoosh_long", "sad_piano_slow"), because the planner reads the names. Adding or replacing a file puts Design out of date, so the next Run plans with it.

**Your own effects** go in the workspace's `effects/` folder, one JSON file per effect, in the same shape as the built-ins in `src/server/effects/builtin.ts`. A file with a built-in's name replaces it. An effect is a template: an ffmpeg filter chain, a lavfi picture or sound source, or ASS lines, with `{{placeholders}}` for its settings and the render context (`W`, `H`, `fps`, `dur`, `from`, `to`). Templates are data, not code: filters that read files or take outside commands are refused, and a bad file is skipped with a note. For example:

```json
{ "name": "pulse", "kind": "video", "timing": "range", "tags": ["beat", "alarm"],
  "description": "The picture pulses brighter and darker: a heartbeat, an alarm, a beat.",
  "params": { "rate": { "type": "number", "min": 0.5, "max": 6, "default": 2, "doc": "pulses per second" } },
  "filter": "eq=brightness='0.12*abs(sin(t*{{rate}}*PI))':eval=frame" }
```

`bun scripts/effects-test.ts` renders every effect on a generated test clip. `--frames <dir>` also saves a frame from inside each one, with contact sheets, and `--workspace <dir>` includes that workspace's own effects and files.

### Check (Transcriber + Jev judges)

For every finished clip:
- **Hear and see:** the Transcriber runs on the rendered file. It takes Whisper word timings on the audio, a frame every ~3 s with local face detection (is anyone cut off by the 9:16 edge?), and one cheap vision check for framing, readable captions and visible effects. It's saved in `clips/<take>/watch/` and skipped while the file is unchanged.
- **Rules:** Jev rates the clip on every check rule in the brief, without seeing your verdict.
- **Edges:** Jev rates whether the first and last lines are clean places to start and stop, and suggests better lines nearby. You apply a suggestion with one click in Review; Check never changes a clip by itself.

### Review (you)

The Review panel plays each finished clip with its Check card and its edit as a timeline. You can:
- **Keep** or **Drop** it.
- **Nudge** its **In** and **Out** points. The clip goes out of date, and the next ▶ Run renders and checks just that clip again.
- **Comment** on a clip or on the whole take.
- **Finish review** when you're done. **Reopen** lets you change your verdicts.

Your review is the reward the Coach learns from. The **one-shot score** (0 to 100) says how close the take came to being accepted as-is:
- It starts from the share of clips kept.
- ×0.85 if you didn't finish the review.
- ×0.9 per nudged clip.
- ×0.95 per comment, counting up to six.

An outline version's score is the mean over its reviewed takes.

### Coach (LLM writes, Jev picks, you apply)

1. **Evidence:** the reviewed takes. It uses your keep or drop, nudges and comments, and each clip's Check scores.
2. **Statistics (code):** for each check rule, how often clips follow it overall, on the clips you kept, and on the ones you dropped.
3. **Rewrites (LLM):** two alternatives for each outline section the evidence or the style reference says should change, up to three sections (four with a reference). A rewrite that drops one of the section's bold settings is discarded, because the renderer needs them.
4. **Choice (Jev):** per section, keep the current text or take a rewrite, given the statistics, your comments and the reference. A rewrite needs a clear win: at least 40%, and 10 points over the next option.
5. **Proposal (code):** the revised outline, with a hypothesis and the evidence for each change. You apply it or not.

Every take saves the outline it was made from (`clips/<take>/outline.md`), and every distinct outline becomes a version in `outlines/ledger.json`. Proposals are in `outlines/proposals/` and scorecards in `outlines/scorecards/`. If the rewrite call fails, the Coach still saves the scorecard and proposes nothing.

### Style reference

The Reference style step measures the reference clip: cut rhythm, speech rate, pauses and faces. A multimodal model (`google/gemini-2.5-flash`) then watches and listens to it with your copy guide in mind. The result is a style profile and a list of checkable traits, such as "cuts every 1-2 s" or "two-word captions in the centre". The Brief turns the traits into check rules, and the Coach uses them to rewrite the outline toward the reference. One analysis costs about $0.005.

### Transcript timing and the vision transcript

Gemini writes the transcript text because it's the most faithful to the dialect, but its timestamps are guesses. So a second pass with `openai/whisper-large-v3` (about $0.02 for a 36-minute video) measures when each word is spoken, and Gemini's words are aligned onto Whisper's. Only Whisper's timings are kept. Lines longer than 9 s are split at punctuation or the longest pause.

The vision transcript records what's on screen:
- **Shots:** ffmpeg finds the cuts.
- **Labels:** a frame from each shot goes to `google/gemini-2.5-flash-lite`. It labels the kind of shot (close-up, footage, archive photo, graphic and so on), what's in it, any on-screen text, and the number and position of people. That's about $0.035 for a 36-minute episode.
- **Overlays:** text on more than 20% of shots, such as a logo, is treated as an overlay and listed once.

Both go in `transcripts/<video>/`. The Transcript panel lets you search, play any line, and pin notes for Pick.

## The Director

The chat dock on the left is the **Director**, a [Think](https://developers.cloudflare.com/agents/harnesses/think/) agent. It drives the same workflow through three MCP servers:

| Crew | MCP endpoint | Tools |
|---|---|---|
| Transcriber | `/mcp/transcribe` | `list_videos`, `read_transcript`, `read_vision`, `read_reference`, `job_status` |
| Planner | `/mcp/plan` | `workflow_status`, `run_workflow`, `run_step`, `read_outline`, `update_outline`, `read_brief`, `read_feedback`, `read_history`, `set_style_reference`, `outline_scores`, `job_status` |
| Editor | `/mcp/extract` | `list_takes`, `read_take`, `adjust_clip`, `read_clip_script`, `job_status` |

It uses `run_workflow` by default, the same as ▶ Run, and `run_step` for a single step. Both answer with the reason, instead of a job, when there's nothing to redo. For a different take it passes a new direction, which becomes Pick's setting. It can't review clips or apply an outline proposal: those are yours. Any comment has an *ask Director* link that sends it there.

## How it runs

```
Bun process (server.ts)                         workerd
├─ UI (dist/ui)                                 └─ Director (Think Durable Object)
├─ /agents/*  ── HTTP + WebSocket proxy ──────►     model: OpenRouter
├─ /mcp/*     ◄── MCP (Streamable HTTP) ─────────   tools: the three crew servers
├─ /api/*     workflow state, ▶ Run, steps, jobs, SSE events, reviews, outline
└─ /files/*   clip previews (Range requests)
```

Think needs the Workers runtime, so the Bun server launches workerd directly on the prebuilt worker bundle (`src/server/workerd.ts` writes its config) and stops it on exit. The workflow runs in Bun because it needs ffmpeg and the workspace folder. Every step is a job with a `job_id`, progress and a log. ▶ Run is a job that runs the step jobs in order, and stopping it stops the current step.

Models are cheap by default, and each can be overridden in `.env`. The three writing calls also ask OpenRouter for the fastest provider of the model (`provider.sort: throughput`), because providers of the same model differ a lot in speed: the same brief took from 10 s to 150 s, at the same price.

| Setting | Default | Used for |
|---|---|---|
| `DIRECTOR_MODEL` | `z-ai/glm-5.3-flash` | the Director |
| `PLAN_MODELS` (comma-separated) | `z-ai/glm-5.3-flash` | Brief, hook-card options, outline rewrites |
| `PLAN_REASONING` | `low` | reasoning effort for those three writing calls |
| `TRANSCRIBE_MODEL` | `google/gemini-2.5-flash` | transcripts, the style reference |
| `TIMING_MODEL` | `openai/whisper-large-v3` | word timings |
| `VISION_MODEL` | `google/gemini-2.5-flash-lite` | shot labels, Check's frames |
| `JEV_MODEL` | `~typesafe/jev-latest` | every judgement |

## The OpenRouter key

The key's source of truth is the app's own browser storage. On first open, the **🔑 Add key** button in the top bar opens a prompt, and the key is checked with OpenRouter before it's accepted.
- **Server:** the page pushes the key to the server on every (re)connect, and the server holds it in memory only. Nothing is written to disk, so there's no setup step after installing the desktop app.
- **Director:** it fetches the key from the server's `/internal/key` on every model call, with a random token made at each launch.
- **Where it's kept:** in the browser's storage for http://127.0.0.1:4477 when you run a checkout. The desktop app keeps its WebView2 profile under `%LOCALAPPDATA%\dev.mrclipper.app\<channel>\WebView2`, so the key survives restarts.
- **Fallback:** `OPENROUTER_KEY` in the environment or `.env` is still read, for running headless. A key from the browser always wins.

## Commands

```sh
bun dev                # setup (on the first run), build, then serve at http://127.0.0.1:4477
bun run setup          # get or check the tools in .store/tools
bun run build          # the Director bundle, the UI and the server, into dist/
bun start              # serve the last build
bun run typecheck
bun scripts/effects-test.ts   # render every effect on a test clip
bun run desktop        # the desktop app window, from this checkout (Electrobun dev build)
bun run desktop:build  # the standalone Windows installer, into artifacts/
```

Only the two desktop commands need [Hutch](https://hutch.blackboard.sh). On Windows, run them from PowerShell rather than Git Bash, because Git Bash's GNU `tar` can't extract Hutch's downloads. A checkout runs the Director on the workerd that `bun i` installs, and even the build runs on Bun alone (wrangler bundles the Director under Bun).

## The desktop app

`src/desktop/index.ts` is the Electrobun main process. It starts the same server in-process and opens a native WebView2 window on it. It listens on its own ports (4478 and 8798), so it can run next to a `bun dev` checkout.

**The installer is standalone.** It needs nothing else installed: no Node, ffmpeg, Python or `.env`. `bun run desktop:build` runs `scripts/vendor.ts`, which collects what the app runs into `vendor/`, and Electrobun packs it under `Resources/app`:

| Bundled | What |
|---|---|
| `dist/ui`, `dist/worker` | the UI and the Director bundle |
| `runtime/workerd.exe` | Cloudflare's Workers runtime, running the Director |
| `runtime/ffmpeg.exe` | the gyan.dev essentials build (libass, fribidi and harfbuzz for Arabic captions, x264); durations come from `ffmpeg -i`, so there's no ffprobe |
| `runtime/yt-dlp.exe` | link imports |
| `runtime/faces/` | `tools/faces.py` compiled with PyInstaller (OpenCV YuNet) |
| `models/`, `templates/` | the face model and the starter outline |

Where things live when installed:
- **App state** is in `%LOCALAPPDATA%\mrClipper`: settings, thumbnails, the Director's storage, and the workspace choice.
- **The workspace** is `Documents\mrClipper` by default. It has the same layout as a checkout's `.store/workspace/`, and it's created on first launch with the starter outline. **Change…** in the project menu points the app at another folder from the next launch.
- **Coming from Clipdesk:** the first launch moves `%LOCALAPPDATA%\Clipdesk` and `Documents\Clipdesk` to the new names. The OpenRouter key is asked for once more, because the app's browser storage is new.

The installer is about 350 MB unpacked, mostly workerd, ffmpeg and OpenCV.

## Settings

All optional. Set them in the environment, or in `.env` (see `.env.example`); relative paths are relative to the checkout.

| Variable | Default | |
|---|---|---|
| `MRCLIPPER_PORT` | 4477 (desktop app: 4478) | UI, API and MCP |
| `MRCLIPPER_WORKER_PORT` | 8799 (desktop app: 8798) | the Director's internal port (workerd) |
| `MRCLIPPER_WORKSPACE` | `.store/workspace` | the workspace; wins over the folder chosen in the app |
| `MRCLIPPER_STORE` | `.store` | holds `workspace/`, `state/` and `tools/` unless those are set below |
| `MRCLIPPER_DATA` | `.store/state` | app state (desktop app: `%LOCALAPPDATA%\mrClipper`) |
| `MRCLIPPER_TOOLS` | `.store/tools` | downloaded tools |
| `MRCLIPPER_SKIP_SETUP` | unset | `bun dev` skips the tool setup |
| `MRCLIPPER_WRANGLER` | unset | run the Director with `wrangler dev` instead of workerd |
| `OPENROUTER_KEY` | unset | headless use only; the app's own key wins |
