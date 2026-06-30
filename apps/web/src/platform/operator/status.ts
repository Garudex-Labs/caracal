/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Canonical Operator status vocabulary: one authoritative wording for each plan lifecycle state, plus rotated equivalents for the transient working indicators.
*/

// The authoritative words for a plan's lifecycle state. The decision badge, the pinned decision
// dock, and the in-transcript confirmation slot all read from here so one state never appears as
// two different phrases. These are operational truth and stay exact - no variety.
export const PLAN_STATUS = {
  awaitingApproval: "Awaiting approval",
  approved: "Approved",
  approvedByAutopilot: "Approved by autopilot",
  applied: "Applied",
  rejected: "Rejected",
} as const;

// Equivalent ways to say "the Operator is busy reasoning". Every line means exactly the same
// thing; rotating through them keeps a long session from repeating one mechanical phrase. The
// caller passes a stable seed so a single send holds one line steady - it never flickers between
// renders - while a fresh send rotates to the next.
const WORKING_LINES = [
  "The Operator is working…",
  "Working through it…",
  "Reasoning it out…",
  "Lining up the steps…",
  "Thinking it through…",
  "Piecing it together…",
  "On it - one moment…",
] as const;

// Equivalent ways to say "applying the approved change". Same meaning, varied wording, seeded so
// it stays steady for one apply and rotates across plans.
const APPLYING_LINES = [
  "Working…",
  "Applying…",
  "Making the change…",
  "Putting it into effect…",
  "Carrying it out…",
] as const;

// Picks a line by seed, wrapping safely for any integer so a negative or large seed still lands
// on a real entry.
function pick(lines: readonly string[], seed: number): string {
  const index = ((Math.trunc(seed) % lines.length) + lines.length) % lines.length;
  return lines[index];
}

export function workingLine(seed: number): string {
  return pick(WORKING_LINES, seed);
}

export function applyingLine(seed: number): string {
  return pick(APPLYING_LINES, seed);
}
