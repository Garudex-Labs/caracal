// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0


import { useState, useSyncExternalStore } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useRetentionWarnings } from "@/hooks/use-api";
import { hasMinRole } from "@/hooks/use-role-guard";
import { getUserRole } from "@/lib/api";

const subscribe = () => () => {};
function getSnapshot() {
  return sessionStorage.getItem("retention-warning-dismissed") === "1";
}
function getServerSnapshot() {
  return false;
}

export function RetentionWarningBanner() {
  const wasDismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);
  const { data } = useRetentionWarnings();

  if (dismissed || wasDismissed) return null;
  if (!hasMinRole(getUserRole("operator"), "operator")) return null;
  if (!data?.retention_enabled || !data.warnings?.length) return null;

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem("retention-warning-dismissed", "1");
  };

  return (
    <div className="bg-warning/10 border border-warning/30 text-warning px-4 py-2.5 text-xs flex items-center gap-2">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">
        Data retention is active ({data.retention_days} days).{" "}
        {data.warnings.length} agent{data.warnings.length > 1 ? "s have" : " has"} unanalyzed traces.{" "}
        Generate insights from the agent detail page before they expire.
      </span>
      <button onClick={handleDismiss} aria-label="Dismiss retention warning" className="p-0.5 hover:bg-warning/20 rounded">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
