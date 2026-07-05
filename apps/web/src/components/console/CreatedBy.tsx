/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders an attribution identity as its current profile name with an optional Caracal operator co-author badge.
*/
import { useQuery } from "@tanstack/react-query";

import { Tooltip } from "@/components/ui/Tooltip";
import { resolveProfileName } from "@/platform/api/profiles";
import { cx } from "@/lib/cx";

const OperatorStarGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2.5l1.9 4.7 5 .4-3.8 3.3 1.2 4.9L12 18l-4.3 2.7 1.2-4.9L5 12.6l5-.4L12 2.5z" />
  </svg>
);

// Attribution stores an immutable identity, never a display name. This component resolves it to
// the profile's current name at render time - so a rename updates every historical record on
// screen - and keeps the stored identity one hover away for audit work. Identities the install
// cannot resolve (admin credentials, erased profiles) render verbatim.
export function CreatedBy({
  id,
  coAuthored,
  className,
}: {
  id: string | null | undefined;
  coAuthored?: boolean;
  className?: string;
}) {
  const identity = id && id.trim().length > 0 ? id : null;
  const profile = useQuery({
    queryKey: ["profile", identity],
    queryFn: () => resolveProfileName(identity!),
    enabled: identity !== null,
    staleTime: 60_000,
  });
  const name = profile.data ?? null;
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      {identity ? (
        <Tooltip
          label={name ? `Profile ID: ${identity}` : `Recorded identity: ${identity}`}
          side="top"
        >
          <span className="min-w-0 break-words" tabIndex={0}>
            {name ?? identity}
          </span>
        </Tooltip>
      ) : (
        <span className="min-w-0 break-words">-</span>
      )}
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
