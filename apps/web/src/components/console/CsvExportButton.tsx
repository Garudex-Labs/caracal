/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the one-click CSV export button for filtered console feeds.
*/
import { useState } from "react";

import { useToast } from "@/components/ui";
import { config } from "@/platform/config";

// Downloads the current feed as CSV straight from the control plane, honoring the active
// server-side filters, so operators can hand a filtered slice to auditors without leaving
// the page. The server fixes the column set and redacts sensitive values before export.
export function CsvExportButton({
  zoneId,
  path,
  query,
  noun,
}: {
  zoneId: string;
  path: string;
  query: Record<string, string>;
  noun: string;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);

  async function download() {
    setPending(true);
    try {
      const params = new URLSearchParams(query);
      params.set("format", "csv");
      params.set("limit", "1000");
      const res = await fetch(
        `${config.consoleBaseUrl}/v1/zones/${encodeURIComponent(zoneId)}/${path}?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`export_failed_${res.status}`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${path}-${stamp}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({
        tone: "error",
        title: "Export failed",
        description: "Check the control plane connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={() => void download()}
      disabled={pending}
      aria-label={`Export ${noun} as CSV`}
      title={`Export ${noun} as CSV`}
      className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-surface hover:text-foreground disabled:opacity-60"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    </button>
  );
}
