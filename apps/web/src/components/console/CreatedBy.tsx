/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders a creator label with an optional Caracal operator co-author badge.
*/
import { Tooltip } from "@/components/ui/Tooltip";
import { cx } from "@/lib/cx";

const OperatorStarGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2.5l1.9 4.7 5 .4-3.8 3.3 1.2 4.9L12 18l-4.3 2.7 1.2-4.9L5 12.6l5-.4L12 2.5z" />
  </svg>
);

export function CreatedBy({
  name,
  coAuthored,
  className,
}: {
  name: string | null | undefined;
  coAuthored?: boolean;
  className?: string;
}) {
  const label = name && name.trim().length > 0 ? name : "—";
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      <span className="min-w-0 break-words">{label}</span>
      {coAuthored ? (
        <Tooltip label="Co-authored by Caracal Operator" side="top">
          <span
            className="inline-flex items-center text-primary"
            tabIndex={0}
            aria-label="Co-authored by Caracal Operator"
          >
            <OperatorStarGlyph className="h-3.5 w-3.5" />
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}
