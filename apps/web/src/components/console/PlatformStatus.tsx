/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the always-visible navbar platform health indicator that links to Diagnostics.
*/
import { appLink } from "@/platform/nav/appLink";
import { useNavigate } from "@tanstack/react-router";

import { cx } from "@/lib/cx";
import { platformHealthOf, useDiagnostics, type PlatformHealth } from "@/platform/api/hooks";

interface Meter {
  active: number;
  bar: string;
  text: string;
}

const BAR_HEIGHTS = ["h-1.5", "h-2.5", "h-3.5"];

const METER: Record<PlatformHealth, Meter> = {
  healthy: { active: 3, bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  attention: { active: 2, bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  unhealthy: { active: 1, bar: "bg-destructive", text: "text-destructive" },
  unknown: { active: 0, bar: "bg-muted-foreground", text: "text-muted-foreground" },
};

export function PlatformStatus() {
  const navigate = useNavigate();
  const diagnostics = useDiagnostics();
  const offline = diagnostics.isError;
  const health = offline ? "unhealthy" : platformHealthOf(diagnostics.data);
  const meter = METER[health];
  const summary = diagnostics.data?.summary;

  const label = offline
    ? "Diagnostics offline"
    : health === "healthy"
      ? "Operational"
      : health === "unknown"
        ? "Checking"
        : summary
          ? [
              summary.fail > 0 ? `${summary.fail} failing` : null,
              summary.warn > 0 ? `${summary.warn} degraded` : null,
            ]
              .filter(Boolean)
              .join(" · ")
          : health === "unhealthy"
            ? "Failing"
            : "Degraded";

  return (
    <button
      onClick={() => navigate({ to: appLink("/diagnostics") })}
      aria-label={`Platform status: ${label}. Open Diagnostics.`}
      title={`${label}: open Diagnostics`}
      className={cx(
        "group inline-flex h-9 items-center gap-2 rounded-md px-2.5 text-xs font-medium",
        "outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    >
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {BAR_HEIGHTS.map((h, i) => (
          <span
            key={h}
            className={cx(
              "w-[3px] rounded-[1px] transition-colors",
              h,
              i < meter.active ? meter.bar : "bg-border",
            )}
          />
        ))}
      </span>
      <span className={cx("hidden whitespace-nowrap tabular-nums lg:inline", meter.text)}>
        {label}
      </span>
    </button>
  );
}
