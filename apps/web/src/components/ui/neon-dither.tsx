/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides a contained, theme-aware dithering shader backdrop for empty states.
*/
import { useMemo, useSyncExternalStore } from "react";
import { Dithering } from "@paper-design/shaders-react";

import { cx } from "@/lib/cx";
import { useTheme } from "@/platform/theme";

// The console's signature accent (matches --accent-purple used across the landing page).
const ACCENT = { light: "#8047e1", dark: "#a883ff" } as const;

// Respects the OS reduced-motion preference so the shader animation can be stilled without
// removing the texture entirely.
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

export interface DitherBackdropProps {
  // Visual presence, 0..1. Kept moderate so it reads as branded texture, not decoration.
  intensity?: number;
  className?: string;
}

// A self-contained dithered backdrop. Unlike the upstream component it never touches the
// document theme class (the app owns that) and is positioned absolutely inside its parent so
// it fills the whole box behind content. Coloured with the landing page's purple accent.
export function DitherBackdrop({ intensity = 0.7, className }: DitherBackdropProps) {
  const theme = useTheme();
  const reducedMotion = usePrefersReducedMotion();
  const isDark = theme === "dark";

  const config = useMemo(() => {
    const t = Math.max(0, Math.min(1, intensity));
    const accent = isDark ? ACCENT.dark : ACCENT.light;
    return {
      front: `${accent}${alpha(0.14 + t * 0.12)}`,
      speed: reducedMotion ? 0 : 0.18 + t * 0.22,
      px: Math.round(2 + t * 1),
      scale: 1.1 + t * 0.15,
    };
  }, [isDark, intensity, reducedMotion]);

  return (
    <div
      aria-hidden="true"
      className={cx("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <Dithering
        colorBack="#00000000"
        colorFront={config.front}
        speed={config.speed}
        shape="wave"
        type="4x4"
        pxSize={config.px}
        scale={config.scale}
        style={{ height: "100%", width: "100%" }}
      />
      {/* A soft central scrim so the texture stays full-bleed while keeping the centered
          content legible. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(70% 60% at 50% 50%, color-mix(in oklch, var(--card) 72%, transparent) 0%, transparent 72%)",
        }}
      />
    </div>
  );
}

function alpha(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
}
