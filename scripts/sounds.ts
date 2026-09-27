// Builds sounds/, the built-in library of recorded sound effects, from Freesound. Every sound here is
// CC0 (public domain), checked again on its page before it's downloaded, so the library can ship with
// mrClipper. Each is trimmed to start on its first sound (so a hit lands exactly where an edit puts it),
// capped in length, peak-normalised to -1 dBFS and saved as MP3, with its description for the planner in
// library.json and its credit in CREDITS.md.
//
//   bun scripts/sounds.ts            download and build every sound (skips ones already built)
//   bun scripts/sounds.ts --force    rebuild them all (or --force a,b for some)
//
// The output is committed, so nobody needs to run this: it's here to add sounds and to show where they came from.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/server/lib";

/** max: seconds kept. peak: the level it's normalised to (dBFS); beds that play under a scene sit lower than hits.
 *  texture: a noise bed (crackle, hiss) that sounds like static on a phone. The planner is only offered it when
 *  the outline asks for it with one of these words. */
type Sound = { name: string; id: number; user: string; title: string; max: number; loop?: boolean; peak?: number; texture?: string[]; description: string; tags: string[] };

const SOUNDS: Sound[] = [
  { name: "whoosh_fast", id: 60030, user: "qubodup", title: "Swosh / Whoosh / Air Cut", max: 1.5, description: "A fast air whoosh: under a quick transition, a whip, text flying in.", tags: ["transition", "movement"] },
  { name: "whoosh_long", id: 812675, user: "AudioPapkin", title: "Sound Design Elements Whoosh SFX 040", max: 3, description: "A long, deep cinematic whoosh: a big transition or a slow reveal.", tags: ["transition", "cinematic"] },
  { name: "swoosh", id: 585257, user: "lesaucisson", title: "swoosh-1.mp3", max: 1.5, description: "A light swoosh: slides, pop-ins, quick moves.", tags: ["transition", "text"] },
  { name: "swish", id: 344408, user: "jawbutch", title: "Knife Swish 2.wav", max: 1, description: "A sharp, thin swish: fast cuts, a blade-quick move.", tags: ["transition", "fast"] },
  { name: "riser", id: 685256, user: "syntheffects", title: "Riser sound effect short.wav", max: 5, description: "A rising swell that builds into a drop or a reveal; end it on the moment.", tags: ["build", "tension"] },
  { name: "reverse_cymbal", id: 110218, user: "genocidalguitar", title: "reverse crash.wav", max: 4, description: "A reversed cymbal that swells into a hit or a cut; end it on the moment.", tags: ["build", "transition"] },
  { name: "hit_cinematic", id: 427803, user: "DeVern", title: "Cinematic Hit With Horns.wav", max: 4.5, description: "A big cinematic hit with brass: a title slam, a dramatic reveal.", tags: ["impact", "drama"] },
  { name: "impact", id: 660770, user: "MadPanCake", title: "Hit Impact", max: 2, description: "A short, punchy impact: a zoom punch, a word landing.", tags: ["impact", "beat"] },
  { name: "punch", id: 490769, user: "steveuk87", title: "Punch 2 - Heavy.ogg", max: 1, description: "A heavy punch: comedy slaps, anime hits.", tags: ["impact", "comedy", "anime"] },
  { name: "boom", id: 116643, user: "Woodingp", title: "Intro Boom.aif", max: 3.5, description: "A deep boom: an entrance, a reveal, a beat drop.", tags: ["impact", "drop"] },
  { name: "bass_drop", id: 59540, user: "uzerx", title: "sub bass 4 secondsssss.wav", max: 3, description: "A sub-bass drop: hype moments and drops.", tags: ["drop", "hype"] },
  { name: "heartbeat", id: 22416, user: "Lunardrive", title: "Four Heartbeats HQ_BeatSmith.wav", max: 4, description: "Four heartbeats: tension, fear, an emotional pause.", tags: ["tension", "emotional"] },
  { name: "camera_shutter", id: 175517, user: "mywhats", title: "camera shutter.wav", max: 1, description: "A camera shutter: freeze frames, photo moments.", tags: ["photo", "freeze"] },
  { name: "ding", id: 127149, user: "Daphne_in_Wonderland", title: "ding.wav", max: 1.5, description: "A clear ding: a fact, a correct answer, an idea.", tags: ["info", "correct"] },
  { name: "chime", id: 398496, user: "Anthousai", title: "wind chimes - single 04.wav", max: 4, description: "A soft wind-chime tone: a gentle memory, a tender beat.", tags: ["soft", "memory"] },
  { name: "pop", id: 789793, user: "quatricise", title: "Pop 4", max: 0.6, description: "A bubbly pop: text or stickers popping in.", tags: ["text", "cute"] },
  { name: "click", id: 534103, user: "pbimal", title: "mouse-click-single-00.flac", max: 0.4, description: "A mouse click: UI moments, selections.", tags: ["ui", "tech"] },
  { name: "typing", id: 250390, user: "Psykophobia", title: "Keyboard Typing Tapping.wav", max: 5, loop: true, peak: -6, description: "Keyboard typing: under typed-on text, tech moments.", tags: ["ui", "tech"] },
  { name: "record_scratch", id: 43404, user: "simkiott", title: "record_scratch.wav", max: 1.7, description: "A record scratch: 'wait, what?', a sudden stop before a freeze.", tags: ["comedy", "stop"] },
  { name: "glitch", id: 332711, user: "AmicaSys", title: "Glitch", max: 2, description: "A digital glitch: under glitch effects and cuts.", tags: ["glitch", "tech"] },
  { name: "crowd_laugh", id: 138112, user: "snakebarney", title: "Small Crowd Laughing", max: 5, description: "A small audience laughing: sitcom-style comedy beats.", tags: ["comedy", "crowd"] },
  { name: "applause", id: 462362, user: "Breviceps", title: "Small applause", max: 6, description: "Small applause: a great line, a win, an ending.", tags: ["crowd", "ending"] },
  { name: "crowd_gasp", id: 324898, user: "deleted_user_2104797", title: "Crowd shock.wav", max: 3.5, description: "A crowd gasping in shock: a shocking moment.", tags: ["shock", "crowd"] },
  { name: "crowd_aww", id: 124996, user: "phmiller42", title: "aww.wav", max: 2, description: "A crowd going 'aww': cute or touching moments.", tags: ["cute", "crowd"] },
  { name: "cash_register", id: 184438, user: "CapsLok", title: "Cash Register Fake.wav", max: 2.3, description: "A cash register: money, prices, a deal.", tags: ["money", "comedy"] },
  { name: "sparkle", id: 511485, user: "MLaudio", title: "cartoon_wink_magic_sparkle.wav", max: 1.6, description: "A magic sparkle: glow-ups, reveals, cute moments.", tags: ["magic", "reveal"] },
  { name: "rewind", id: 162493, user: "TasmanianPower", title: "Vinyl rewind", max: 2.7, description: "A vinyl rewind: going back in time, a flashback, 'let's rewind'.", tags: ["flashback", "time"] },
  { name: "clock_ticking", id: 130388, user: "olver", title: "Clock ticking", max: 6, loop: true, peak: -8, description: "A clock ticking: waiting, suspense, time running out.", tags: ["suspense", "time"] },
  { name: "sword_slash", id: 268227, user: "XxChr0nosxX", title: "Swing.mp3", max: 1.1, description: "A sword swing: anime cuts, fast strikes.", tags: ["anime", "action"] },
  { name: "thunder", id: 683421, user: "SholeColtis", title: "Short_Thunder_Mid.wav", max: 6.7, description: "Thunder: a dramatic turn, a storm of emotion.", tags: ["drama", "weather"] },
  { name: "drum_roll", id: 77305, user: "bigjoedrummer", title: "buzz roll.wav", max: 5, description: "A snare drum roll: before a reveal or an answer.", tags: ["build", "reveal"] },
  { name: "sad_trombone", id: 362206, user: "TaranP", title: "horn_fail_wahwah_1.wav", max: 4.3, description: "A 'wah wah' sad trombone: a comic fail.", tags: ["comedy", "fail"] },
  { name: "boing", id: 540790, user: "magnuswaker", title: "Boing 2", max: 1.1, description: "A cartoon boing: silly bounces, comic moments.", tags: ["comedy", "cartoon"] },
  { name: "notification", id: 740423, user: "AnthonyRox", title: "Message Notification 4", max: 0.6, description: "A phone notification: a message, a reminder.", tags: ["ui", "phone"] },
  { name: "vinyl_crackle", id: 614342, user: "mitchanary", title: "Vinyl Dust 50.wav", max: 10, loop: true, peak: -10, texture: ["vinyl crackle", "crackle"], description: "Record crackle and dust: nostalgia under a scene.", tags: ["nostalgia", "ambience"] },
  { name: "room_tone", id: 454166, user: "kyles", title: "room tone medium quiet Pablo's condo.flac", max: 12, loop: true, peak: -20, texture: ["room tone"], description: "Quiet room ambience: fills a silence or a freeze.", tags: ["ambience", "silence"] },
  { name: "suspense_sting", id: 506295, user: "FartMuffin", title: "tension sting.mp3", max: 4.5, description: "A tension sting: something is wrong, a twist.", tags: ["tension", "twist"] },
  { name: "crickets", id: 242046, user: "lezaarth", title: "cricket2.wav", max: 7.4, loop: true, peak: -8, description: "Crickets: an awkward silence after a joke falls flat.", tags: ["comedy", "silence"] },
  { name: "slide_whistle", id: 395443, user: "plasterbrain", title: "Cartoon Fall", max: 2, description: "A falling slide whistle: a cartoon fall, a fail.", tags: ["comedy", "cartoon"] },
  { name: "tada", id: 397355, user: "plasterbrain", title: "Tada Fanfare A", max: 1.8, description: "A 'ta-da' fanfare: a reveal, a proud moment.", tags: ["reveal", "comedy"] },
  { name: "buzzer_wrong", id: 648462, user: "-Andreas", title: "Wrong Answer", max: 1.1, description: "A wrong-answer buzzer: a mistake, 'nope'.", tags: ["comedy", "fail"] },
  { name: "sad_piano", id: 238328, user: "johnthewizar", title: "A Minor Progression Piano.wav", max: 10, description: "A short minor piano progression: a sad cut, an emotional ending.", tags: ["sad", "emotional"] },
];

const OUT = join(import.meta.dir, "..", "sounds");
const forceArg = process.argv[process.argv.indexOf("--force") + 1];
const force = (name: string) => process.argv.includes("--force") && (!forceArg || forceArg.startsWith("--") || forceArg.split(",").includes(name));
const ua = { "User-Agent": "mrClipper sound library (https://github.com)" };
mkdirSync(OUT, { recursive: true });
const tmp = join(tmpdir(), "mrclipper-sounds");
mkdirSync(tmp, { recursive: true });
const built: (Sound & { seconds: number; page: string })[] = [];

for (const s of SOUNDS) {
  const page = `https://freesound.org/people/${s.user}/sounds/${s.id}/`;
  const file = join(OUT, `${s.name}.mp3`);
  if (existsSync(file) && !force(s.name)) {
    const seconds = await probeSeconds(file);
    built.push({ ...s, seconds, page });
    continue;
  }
  const html = await (await fetch(page, { headers: ua })).text();
  if (!/publicdomain\/zero\/1\.0/.test(html)) throw new Error(`${s.name}: ${page} isn't CC0 (any more?); pick another sound`);
  const preview = html.match(/https:\/\/cdn\.freesound\.org\/previews\/\d+\/\d+_\d+-hq\.mp3/)?.[0];
  if (!preview) throw new Error(`${s.name}: no preview on ${page}`);
  const raw = join(tmp, `${s.name}.raw.mp3`);
  writeFileSync(raw, Buffer.from(await (await fetch(preview, { headers: ua })).arrayBuffer()));
  // Start on the first sound, cap the length (fading out if it's cut), then peak-normalise to -1 dBFS.
  const shape = `silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.01,atrim=0:${s.max},afade=t=out:st=${Math.max(0, s.max - 0.15)}:d=0.15${s.loop ? ",afade=t=in:d=0.05" : ""}`;
  const det = await run(["ffmpeg", "-hide_banner", "-nostats", "-i", raw, "-af", `${shape},volumedetect`, "-f", "null", "-"]);
  const peak = Number(det.stderr.match(/max_volume:\s*(-?[\d.]+) dB/)?.[1] ?? -1);
  const gain = Math.min(18, (s.peak ?? -1) - peak);
  const r = await run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-af", `${shape},volume=${gain.toFixed(2)}dB`, "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", file]);
  if (r.code !== 0) throw new Error(`${s.name}: ${r.stderr.slice(-300)}`);
  rmSync(raw, { force: true });
  const seconds = await probeSeconds(file);
  built.push({ ...s, seconds, page });
  console.log(`${s.name.padEnd(15)} ${seconds.toFixed(2)}s  ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB  "${s.title}" by ${s.user}`);
  await new Promise((res) => setTimeout(res, 500));
}

async function probeSeconds(f: string) {
  const r = await run(["ffmpeg", "-hide_banner", "-i", f]);
  const m = r.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? +(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])).toFixed(2) : 0;
}

writeFileSync(join(OUT, "library.json"), JSON.stringify({
  about: "Built-in recorded sound effects. All CC0 (public domain) from Freesound; see CREDITS.md. Built by scripts/sounds.ts.",
  sounds: built.map((s) => ({ name: s.name, description: s.description, tags: s.tags, seconds: s.seconds, ...(s.loop ? { loop: true } : {}), ...(s.texture ? { texture: s.texture } : {}), source: s.page, author: s.user, title: s.title, license: "CC0 1.0" })),
}, null, 1) + "\n");
writeFileSync(join(OUT, "CREDITS.md"), [
  "# Sound credits",
  "",
  "Every sound here is from [Freesound](https://freesound.org) and released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain) by its author. No credit is required; it's given anyway. The files are the Freesound previews, trimmed and level-matched by `scripts/sounds.ts`.",
  "",
  "| File | Sound | Author |",
  "|---|---|---|",
  ...built.map((s) => `| \`${s.name}.mp3\` | [${s.title.replace(/\|/g, "/")}](${s.page}) | ${s.user} |`),
  "",
].join("\n"));
console.log(`\n${built.length} sounds in ${OUT}`);
