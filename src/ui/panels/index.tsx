// The inspector: one panel per node, with the same header as the node (phase · who, title, state).
import type { NodeId } from "../api";
import { NODE_TITLE, PHASES, WHO_LABEL } from "../Canvas";
import { StateChip } from "../Common";
import { BriefPanel } from "./brief";
import { CoachPanel } from "./coach";
import { OutlinePanel, ReferencePanel, SourcePanel } from "./inputs";
import { CheckPanel, DesignPanel, MusicPanel, PickPanel, RenderPanel, TitlesPanel } from "./make";
import { ReviewPanel } from "./review";
import type { PanelProps } from "./shared";
import { RefStylePanel, TranscriptPanel } from "./understand";

export type { PanelProps } from "./shared";

const ABOUT: Record<NodeId, string> = {
  source: "The long video every clip is cut from: a file, or a link yt-dlp downloads. Another video becomes its own project.",
  outline: "Who the clips are for and how to cut them. The Brief turns it into what Jev asks; the renderer reads its bold settings.",
  refclip: "Optional: a finished short whose style you want the clips to copy.",
  guide: "What to copy from the reference, in your words.",
  transcript: "What the source says, with measured word timings. Click a line to play it; pin notes for Pick.",
  shots: "What the source shows, shot by shot: every cut measured, a frame from each shot described by a vision model, faces measured for the 9:16 crop.",
  refstyle: "The reference, measured (cut rhythm, speech rate) and described by a model that watches and listens, focused on your copy guide.",
  brief: "The one LLM step before the judges: it writes Jev's questions for picking clips, the edit and hook-card guidance, and the rules every finished clip is checked on.",
  pick: "Jev scores every possible opening, ending and clip with the brief's questions; the best that don't overlap make a take.",
  titles: "The LLM writes three hook cards per clip in its own language; Jev picks the one that stops a scroller and keeps the words to stress in the captions.",
  music: "A score made for each clip: the LLM writes three prompts from the clip's own moments, Jev picks, Lyria makes it (about $0.08 a clip). Off unless the outline asks (Music source: generate), but you can score a take by hand.",
  design: "The LLM plans two edits per clip from the effects library and your files; code checks them against the outline and test-renders them; Jev picks one.",
  render: "ffmpeg renders each clip in one pass: face-tracked 9:16 framing, the designed edit with its effects, overlays, sounds and music, the outline's look, captions and the hook card.",
  check: "Every finished clip is heard and watched, then Jev rates it on the brief's rules and checks its in and out points.",
  review: "Your turn: watch the finished clips, keep or drop each, nudge edges, comment, then finish. That's the reward the Coach learns from.",
  coach: "The LLM writes outline rewrites where the evidence says to; Jev picks, per section. You apply the next version, and the next take follows it.",
};

export function Panel({ id, onClose, ...p }: PanelProps & { id: NodeId; onClose: () => void }) {
  const node = p.wf.nodes[id];
  return (
    <aside className="panel pane">
      <div className="panel-head">
        <div style={{ minWidth: 0 }}>
          <div className={`pane-kicker who-${node.who}`}>{node.phase} · {PHASES[node.phase - 1]} · {WHO_LABEL[node.who]}</div>
          <div className="panel-title">{NODE_TITLE[id]}</div>
          <div className="hint">{ABOUT[id]}</div>
        </div>
        <StateChip state={node.state} />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close panel">✕</button>
      </div>
      <div className="scroll panel-body">
        {id === "source" && <SourcePanel {...p} />}
        {id === "outline" && <OutlinePanel {...p} />}
        {(id === "refclip" || id === "guide") && <ReferencePanel {...p} focus={id} />}
        {id === "transcript" && <TranscriptPanel {...p} />}
        {id === "shots" && <TranscriptPanel {...p} focus="vision" />}
        {id === "refstyle" && <RefStylePanel {...p} />}
        {id === "brief" && <BriefPanel {...p} />}
        {id === "pick" && <PickPanel {...p} />}
        {id === "titles" && <TitlesPanel {...p} />}
        {id === "music" && <MusicPanel {...p} />}
        {id === "design" && <DesignPanel {...p} />}
        {id === "render" && <RenderPanel {...p} />}
        {id === "check" && <CheckPanel {...p} />}
        {id === "review" && <ReviewPanel {...p} />}
        {id === "coach" && <CoachPanel {...p} />}
      </div>
    </aside>
  );
}
