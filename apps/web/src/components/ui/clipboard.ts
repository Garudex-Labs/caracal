/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared clipboard copy hook used across the Console UI.
*/
import { useCallback } from "react";

import { useToast } from "./toastContext";

interface CopyOptions {
  successTitle?: string;
  onSuccess?: () => void;
}

async function writeClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// Confirms success only after the clipboard write resolves, so the user is never told a value was
// copied when the clipboard was unavailable or the write was denied.
export function useCopyToClipboard(): (text: string, opts?: CopyOptions) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (text, opts) => {
      if (await writeClipboard(text)) {
        if (opts?.onSuccess) opts.onSuccess();
        else toast({ tone: "success", title: opts?.successTitle ?? "Copied" });
      } else {
        toast({
          tone: "error",
          title: "Copy failed",
          description: "Copy it manually instead.",
        });
      }
    },
    [toast],
  );
}
