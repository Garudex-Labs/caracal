// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator deliberation views: the live reasoning trail and the collapsed replay of a completed turn.

import { useMemo } from "react";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { cx } from "@/lib/cx";
import { workingLine } from "@/platform/operator/status";
import type { OperatorProgressStage } from "@/platform/api/types";

// Human-readable labels for each deliberation stage the Operator streams while it works.
const STAGE_LABELS: Record<OperatorProgressStage, string> = {
  triaging: "Understanding the request",
  gathering: "Reading live state",
  planning: "Composing a plan",
  repairing: "Repairing the plan",
  critiquing: "Reviewing for risk",
  revising: "Revising the plan",
  guarding: "Checking against Caracal policy",
  answering: "Writing the answer",
};

// A live, ordered account of the Operator's reasoning while a send is in flight. Each stage the
// backend streams becomes a row: completed stages settle to muted text with a filled marker, the
// current stage stays in the foreground with a pulsing marker. Before the first stage arrives a
// seeded working line stands in so there is never dead air; the seed holds one phrasing steady for
// this send and rotates to a fresh equivalent on the next.
export function DeliberationTrail({
  stages,
  seed = 0,
}: {
  stages: OperatorProgressStage[];
  seed?: number;
}) {
  if (stages.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-purple" />
        {workingLine(seed)}
      </div>
    );
  }
  return (
    <ol className="flex flex-col gap-1 px-1">
      {stages.map((stage, index) => {
        const active = index === stages.length - 1;
        return (
          <li key={`${stage}-${index}`} className="flex items-center gap-2 text-xs">
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                active ? "animate-pulse bg-accent-purple" : "bg-muted-foreground/40",
              )}
            />
            <span className={active ? "text-foreground" : "text-muted-foreground"}>
              {STAGE_LABELS[stage]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// A completed turn's deliberation trail, collapsed by default: the recorded path the request was
// reasoned through, replayable after the live stream has ended. Consecutive repeats collapse so a
// repair or revise loop reads as one step, and a trail of fewer than two stages is hidden since a
// single stage is not a deliberation worth disclosing.
export function DeliberationReplay({ stages }: { stages: OperatorProgressStage[] }) {
  const trail = useMemo(() => {
    const out: OperatorProgressStage[] = [];
    for (const stage of stages) {
      if (out[out.length - 1] !== stage) out.push(stage);
    }
    return out;
  }, [stages]);
  if (trail.length < 2) return null;
  return (
    <Task defaultOpen={false} className="border border-border bg-card/60">
      <div className="flex items-center px-3 py-2">
        <TaskTrigger
          title={`Deliberation · ${trail.length} steps`}
          className="min-w-0 flex-1 text-xs"
        />
      </div>
      <TaskContent className="mt-0 px-3 pb-2.5">
        {trail.map((stage, index) => (
          <TaskItem key={`${stage}-${index}`} className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
            <span className="text-foreground">{STAGE_LABELS[stage]}</span>
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
