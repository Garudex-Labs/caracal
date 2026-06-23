/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the Dynamic Client Registration toggle with an explanatory tooltip for zone forms.
*/
import { Tooltip } from "@/components/ui";
import { cx } from "@/lib/cx";

function InfoIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5h.01" />
    </svg>
  );
}

export function DcrField({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">Dynamic Client Registration</span>
            <Tooltip label="Lets agents self-register short-lived client identities through the zone's DCR endpoint. These clients auto-expire and are managed programmatically, not from the console. Leave off unless a workload needs to register itself at runtime.">
              <span className="inline-flex cursor-help">
                <InfoIcon />
              </span>
            </Tooltip>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Allow workloads to register their own client identities at runtime.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Dynamic Client Registration"
          onClick={() => onChange(!enabled)}
          className={cx(
            "relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-foreground" : "bg-muted",
          )}
        >
          <span
            className={cx(
              "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
              enabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>
    </div>
  );
}
