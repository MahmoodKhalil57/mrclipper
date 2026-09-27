// Phase 3 · Brief: everything the LLM wrote for the judges, in one place.
import { useEffect, useState } from "react";
import { actions, type BriefFile } from "../api";
import { JobCard } from "../Common";
import { BriefView, StepTrigger, nodeJob, type PanelProps } from "./shared";

export function BriefPanel(p: PanelProps) {
  const node = p.wf.nodes.brief;
  const job = nodeJob(p, "brief");
  const [file, setFile] = useState<BriefFile | null>(null);
  useEffect(() => {
    actions.briefOf(p.video.name).then(setFile).catch(() => setFile(null));
  }, [p.video.name, node.state, node.facts.map((f) => f[1]).join("|")]);
  const when = file ? new Date(file.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <div className="stack">
      <div className="card row">
        <div className="grow">
          <b>{file ? (node.state === "stale" ? "Out of date" : "Current") : "No brief yet"}</b>
          <div className="hint">
            {file
              ? `${file.brief.source === "llm" ? `Written by ${(file.brief.model ?? "the LLM").split("/").pop()}` : "Built-in (the LLM step failed)"} · ${when} · $${file.cost.toFixed(3)}${node.reason ? ` · ${node.reason}` : ""}`
              : "One LLM call reads the outline, the style reference and a transcript sample, and writes what every judge uses."}
          </div>
        </div>
        {job?.status === "running" ? (
          <button className="btn danger" onClick={() => p.stop(job.id)}>■ Stop</button>
        ) : (
          <StepTrigger p={p} id="brief" first="Write brief" again="Rewrite" />
        )}
      </div>
      {job && job.status !== "done" && <JobCard job={job} onStop={p.stop} defaultOpen />}
      {file && <BriefView b={file.brief} />}
    </div>
  );
}
