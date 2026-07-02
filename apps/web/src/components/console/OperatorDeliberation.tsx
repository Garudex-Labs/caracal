// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Operator deliberation views: the live reasoning trail and the collapsed replay of a completed turn.

import { useMemo, useState } from "react";
import { cx } from "@/lib/cx";
import { workingLine } from "@/platform/operator/status";
import type { OperatorProgressStage } from "@/platform/api/types";

// Right-pointing chevron for the deliberation disclosure; rotates a quarter turn when expanded.
const ChevronGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
    <path
      d="m9 6 6 6-6 6"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

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
// repair or revise loop reads as one step. The replay is shown only for a turn that actually
// deliberated - one that read live state, planned, repaired, critiqued, revised, or guarded - so a
// trivial answer that only triaged and replied carries no disclosure to expand.
const SUBSTANTIVE_STAGES: ReadonlySet<OperatorProgressStage> = new Set([
  "gathering",
  "planning",
  "repairing",
  "critiquing",
  "revising",
  "guarding",
]);

export function DeliberationReplay({ stages }: { stages: OperatorProgressStage[] }) {
  const [open, setOpen] = useState(false);
  const trail = useMemo(() => {
    const out: OperatorProgressStage[] = [];
    for (const stage of stages) {
      if (out[out.length - 1] !== stage) out.push(stage);
    }
    return out;
  }, [stages]);
  if (!trail.some((stage) => SUBSTANTIVE_STAGES.has(stage))) return null;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-fit cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
      >
        <ChevronGlyph
          className={cx(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200 group-hover:text-foreground",
            open && "rotate-90",
          )}
        />
        <span>Deliberation</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="tabular-nums text-muted-foreground/70">{trail.length} steps</span>
      </button>
      {open ? (
        <ol className="animate-fade-in mt-2 ml-[6px] flex flex-col gap-2 border-l border-border/70 pl-4">
          {trail.map((stage, index) => (
            <li key={`${stage}-${index}`} className="relative flex items-center text-xs">
              <span className="absolute -left-[17px] h-1.5 w-1.5 rounded-full bg-muted-foreground/40 ring-2 ring-background" />
              <span className="text-muted-foreground">{STAGE_LABELS[stage]}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
