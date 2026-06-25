/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides a deterministic identicon avatar generated from a stable seed string.
*/
import { useMemo } from "react";

import { cx } from "@/lib/cx";

// A small, stable 32-bit hash (FNV-1a) so the same seed always yields the same avatar.
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const SIZES = {
  sm: "h-7 w-7 rounded-[5px]",
  md: "h-8 w-8 rounded-md",
  lg: "h-10 w-10 rounded-lg",
} as const;

// A deterministic identicon: a left-right symmetric 5x5 grid derived from the seed hash,
// painted in a hash-chosen hue so every object reads as a distinct, recognizable mark while
// staying tasteful against the console's neutral surfaces. Stable across renders and sessions.
export function IdentityAvatar({
  seed,
  size = "md",
  className,
}: {
  seed: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { cells, fg } = useMemo(() => {
    const h = hash(seed);
    const hue = h % 360;
    // Build a 5-wide grid but only decide the left 3 columns, mirroring to the right so the
    // mark is symmetric and immediately reads as an avatar rather than noise.
    const grid: boolean[] = [];
    for (let row = 0; row < 5; row += 1) {
      const left: boolean[] = [];
      for (let col = 0; col < 3; col += 1) {
        const bit = (h >> ((row * 3 + col) % 31)) & 1;
        left.push(bit === 1);
      }
      grid.push(left[0], left[1], left[2], left[1], left[0]);
    }
    return {
      cells: grid,
      fg: `oklch(0.62 0.17 ${hue})`,
    };
  }, [seed]);

  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid flex-shrink-0 place-items-center overflow-hidden border border-border bg-muted",
        SIZES[size],
        className,
      )}
    >
      <svg viewBox="0 0 5 5" className="h-[68%] w-[68%]" shapeRendering="crispEdges">
        {cells.map((on, index) =>
          on ? (
            <rect
              key={index}
              x={index % 5}
              y={Math.floor(index / 5)}
              width="1"
              height="1"
              fill={fg}
            />
          ) : null,
        )}
      </svg>
    </span>
  );
}
