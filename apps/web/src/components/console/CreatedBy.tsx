/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders an attribution identity as its current profile name with an optional Caracal operator co-author badge.
*/
import { useQuery } from "@tanstack/react-query";

import { Tooltip } from "@/components/ui/Tooltip";
import { useCopyToClipboard } from "@/components/ui";
import { resolveProfileName } from "@/platform/api/profiles";
import { accountIdFor } from "@/platform/state/localInstall";
import { cx } from "@/lib/cx";

const OperatorStarGlyph = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2.5l1.9 4.7 5 .4-3.8 3.3 1.2 4.9L12 18l-4.3 2.7 1.2-4.9L5 12.6l5-.4L12 2.5z" />
  </svg>
);

const CopyGlyph = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

// Attribution stores an immutable identity, never a display name. This component resolves it to
// the profile's current name at render time - so a rename updates every historical record on
// screen - and keeps the stable identity one hover away for audit work: a resolved profile shows
// its Account ID (the deterministic CRC rendering of the profile id, matching Settings), while
// identities the install cannot resolve (admin credentials, erased profiles) render verbatim.
// The hover card is interactive so the identity can be copied from it.
export function CreatedBy({
  id,
  coAuthored,
  className,
}: {
  id: string | null | undefined;
  coAuthored?: boolean;
  className?: string;
}) {
  const copy = useCopyToClipboard();
  const identity = id && id.trim().length > 0 ? id : null;
  const profile = useQuery({
    queryKey: ["profile", identity],
    queryFn: () => resolveProfileName(identity!),
    enabled: identity !== null,
    staleTime: 60_000,
  });
  const name = profile.data ?? null;
  const accountId = identity && name ? accountIdFor(identity) : null;
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      {identity ? (
        <Tooltip
          interactive
          side="top"
          label={
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                {accountId ? "Account ID: " : "Recorded identity: "}
                <span className="break-all font-mono text-foreground">{accountId ?? identity}</span>
              </span>
              <button
                type="button"
                aria-label={accountId ? "Copy Account ID" : "Copy recorded identity"}
                onClick={() =>
                  void copy(accountId ?? identity, {
                    successTitle: accountId ? "Account ID copied" : "Identity copied",
                  })
                }
                className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground"
              >
                <CopyGlyph />
              </button>
            </span>
          }
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
