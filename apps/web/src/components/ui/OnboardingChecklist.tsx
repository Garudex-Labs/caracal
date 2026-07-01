/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the interactive onboarding checklist with element-anchored coachmarks for guided setup.
*/
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "@/lib/cx";
import { Button } from "./Primitives";

export type StepMedia =
  | { type: "image"; src: string; alt?: string }
  | { type: "video"; href: string; poster?: string; alt?: string };

export type Step = {
  id: string;
  title: string;
  description?: string;
  /** CSS selector for the element this step spotlights. Empty string renders a centered card. */
  targetSelector: string;
  completed?: boolean;
  /** Optional label for the coachmark's primary action (defaults to "Take me there"). */
  actionLabel?: string;
  /** Rich teaching content rendered in the coachmark below the description. */
  details?: ReactNode;
  /**
   * Optional media shown above the title. "image" renders inline; "video" renders a
   * clickable poster that opens the YouTube link in a new tab. Omit for no media (the
   * media area collapses entirely so steps without it lose no space).
   */
  media?: StepMedia;
  /**
   * When true, the primary action advances the tour to the next incomplete step in place
   * (used for informational steps whose CTA does not navigate away). When false (default),
   * the primary action closes the coachmark so the operator can act on the page it opened.
   */
  advanceOnAction?: boolean;
  /** Hide this step from the side checklist (still shown as a coachmark in the tour). */
  hideInList?: boolean;
};

export interface InteractiveOnboardingChecklistProps {
  steps: Step[];
  open?: boolean;
  defaultOpen?: boolean;
  title?: string;
  onOpenChange?(open: boolean): void;
  onActivateStep?(id: string): void;
  onFinish?(): void;
  /** Dismiss the whole walkthrough from the intro step's Skip action. */
  onSkip?(): void;
  /**
   * When true (default), opening the panel auto-spotlights the first remaining step as a
   * coachmark. When false, the panel shows only the checklist and a coachmark appears solely
   * when the operator clicks a step, so a reopened-after-skip guide never re-pops the tour.
   */
  autoSpotlight?: boolean;
  /**
   * When true (default), the coachmark's primary action marks the step complete locally.
   * When false, completion is driven entirely by each step's `completed` flag so the
   * checklist mirrors real backend state instead of optimistic local clicks.
   */
  manualCompletion?: boolean;
}

function usePortalTarget(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.body);
  }, []);
  return el;
}

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function readRect(selector: string): TargetRect | null {
  if (!selector) return null;
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  // A display:none target (e.g. the sidebar on mobile) reports a zero-area rect; treat it
  // as absent so the coachmark falls back to its centered card instead of spotlighting 0,0.
  if (rect.width === 0 && rect.height === 0) return null;
  // Viewport-relative coordinates: the overlay is position:fixed, so it must not add
  // scroll offsets or the spotlight drifts when the page scrolls.
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      className={className}
    >
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={className}
    >
      <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={className}
    >
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <path d="M6 6l12 12M6 18 18 6" strokeLinecap="round" />
    </svg>
  );
}

const SPOTLIGHT_PADDING = 8;
const CARD_WIDTH = 360;
const CARD_HEIGHT = 184;
const CARD_MARGIN = 16;
const PANEL_RESERVE_W = 340;
const PANEL_RESERVE_H = 420;

// Pulls the 11-character YouTube id out of the common URL shapes so a video step can show
// the official thumbnail without the caller supplying a poster.
function youtubeId(href: string): string | null {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.slice(1) || null;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "embed" || parts[0] === "shorts") return parts[1] ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

function PlayBadge() {
  return (
    <span className="pointer-events-none grid h-12 w-12 place-items-center rounded-full bg-foreground/70 text-background shadow-lg transition-transform group-hover:scale-105">
      <svg viewBox="0 0 24 24" className="ml-0.5 h-6 w-6" fill="currentColor" aria-hidden="true">
        <path d="M8 5v14l11-7z" />
      </svg>
    </span>
  );
}

function BrokenMediaPlaceholder() {
  return (
    <div className="grid h-full w-full place-items-center bg-muted text-muted-foreground">
      <svg
        viewBox="0 0 24 24"
        className="h-7 w-7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m3 16 5-5 4 4 3-3 6 6" />
        <circle cx="9" cy="9" r="1.5" />
      </svg>
    </div>
  );
}

// Renders the optional media strip above a coachmark's title. Images load lazily over a
// neutral box (no layout shift on slow networks) and fall back to a placeholder when the
// source is missing or fails. Videos render a clickable poster that opens YouTube in a new
// tab, keyboard and screen-reader accessible.
function StepMedia({ media }: { media: StepMedia }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [media]);

  if (media.type === "image") {
    return (
      <div className="mb-3 aspect-video max-h-48 w-full shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
        {failed ? (
          <BrokenMediaPlaceholder />
        ) : (
          <img
            src={media.src}
            alt={media.alt ?? ""}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        )}
      </div>
    );
  }

  const poster =
    media.poster ??
    (youtubeId(media.href)
      ? `https://i.ytimg.com/vi/${youtubeId(media.href)}/hqdefault.jpg`
      : undefined);

  return (
    <a
      href={media.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={media.alt ? `Play video: ${media.alt}` : "Play video in a new tab"}
      className="group relative mb-3 grid aspect-video max-h-48 w-full shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {poster && !failed ? (
        <img
          src={poster}
          alt={media.alt ?? ""}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
      ) : null}
      <span className="absolute inset-0 bg-foreground/10 transition-colors group-hover:bg-foreground/20" />
      <PlayBadge />
    </a>
  );
}

// Chooses the least-bad anchor for the coachmark card: prefer below the target, then
// above, then to the sides; never overlap the bottom-right checklist panel; finally clamp
// into the viewport so the card is always reachable even for edge-hugging targets.
function placeCard(rect: TargetRect): { top: number; left: number } {
  const { top, left, width, height } = rect;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const candidates = [
    { top: top + height + CARD_MARGIN, left: left + width / 2 - CARD_WIDTH / 2 },
    { top: top - CARD_HEIGHT - CARD_MARGIN, left: left + width / 2 - CARD_WIDTH / 2 },
    { top: top + height / 2 - CARD_HEIGHT / 2, left: left + width + CARD_MARGIN },
    { top: top + height / 2 - CARD_HEIGHT / 2, left: left - CARD_WIDTH - CARD_MARGIN },
  ];

  const fit = candidates.find((pos) => {
    const fitsX = pos.left >= CARD_MARGIN && pos.left + CARD_WIDTH <= vw - CARD_MARGIN;
    const fitsY = pos.top >= CARD_MARGIN && pos.top + CARD_HEIGHT <= vh - CARD_MARGIN;
    const overlapsPanel =
      pos.left + CARD_WIDTH > vw - PANEL_RESERVE_W && pos.top + CARD_HEIGHT > vh - PANEL_RESERVE_H;
    return fitsX && fitsY && !overlapsPanel;
  });
  if (fit) return fit;

  const clampedLeft = Math.max(
    CARD_MARGIN,
    Math.min(left + width / 2 - CARD_WIDTH / 2, vw - CARD_WIDTH - CARD_MARGIN),
  );
  const clampedTop = Math.max(
    CARD_MARGIN,
    Math.min(top + height + CARD_MARGIN, vh - CARD_HEIGHT - CARD_MARGIN),
  );
  return { top: clampedTop, left: clampedLeft };
}

function CoachmarkOverlay({
  step,
  isFirst,
  isLast,
  manualCompletion,
  onNext,
  onPrev,
  onPrimary,
  onClose,
  onSkip,
}: {
  step: Step;
  isFirst: boolean;
  isLast: boolean;
  manualCompletion: boolean;
  onNext: () => void;
  onPrev: () => void;
  onPrimary: () => void;
  onClose: () => void;
  onSkip?: () => void;
}) {
  const [rect, setRect] = useState<TargetRect | null>(() => readRect(step.targetSelector));

  const update = useCallback(() => setRect(readRect(step.targetSelector)), [step.targetSelector]);

  useEffect(() => {
    update();
    if (!step.targetSelector) return;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const target = document.querySelector(step.targetSelector);
    const observer = new ResizeObserver(update);
    if (target) observer.observe(target);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer.disconnect();
    };
  }, [step.targetSelector, update]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !isLast) onNext();
      else if (e.key === "ArrowLeft" && !isFirst) onPrev();
      else if (e.key === "Enter") {
        e.preventDefault();
        onPrimary();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFirst, isLast, onNext, onPrev, onPrimary, onClose]);

  const primaryLabel = step.actionLabel ?? (manualCompletion ? "Mark complete" : "Take me there");

  const cardBody = (
    <>
      {step.media ? <StepMedia media={step.media} /> : null}
      <h3 id="coachmark-title" className="mb-2 shrink-0 text-sm font-semibold text-foreground">
        {step.title}
      </h3>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-0.5">
        {step.description ? <p className="text-sm text-foreground">{step.description}</p> : null}
        {step.details ? <div className="mt-3">{step.details}</div> : null}
      </div>

      <div className="mt-4 flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={onPrev}
            disabled={isFirst}
            aria-label="Previous step"
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onNext}
            disabled={isLast}
            aria-label="Next step"
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {onSkip && isFirst && !isLast && step.targetSelector === "" ? (
            <Button variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          ) : null}
          <Button size="sm" onClick={onPrimary}>
            {primaryLabel}
          </Button>
        </div>
      </div>
    </>
  );

  // Intentional centered card: a step with no target (orientation/summary), or an anchored
  // step whose element is not on the current screen. Both dim the page and present the same
  // lesson card centered, so the tour never shows a broken or empty spotlight.
  const isIntro = step.targetSelector === "";
  if (isIntro || !rect) {
    return (
      <div
        className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-overlay/50 p-4 backdrop-blur-[1px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coachmark-title"
        onClick={onClose}
      >
        <div
          className="animate-pop-in flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-xl border border-border bg-card p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {!isIntro ? (
            <p className="mb-3 shrink-0 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Open the related page to see this in context. The lesson stays the same.
            </p>
          ) : null}
          {cardBody}
        </div>
      </div>
    );
  }

  const cx0 = rect.left + rect.width / 2;
  const cy0 = rect.top + rect.height / 2;
  const radius = Math.max(rect.width, rect.height) / 2 + SPOTLIGHT_PADDING;
  const card = placeCard(rect);

  return (
    <div
      className="animate-fade-in pointer-events-none fixed inset-0 z-[60]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="coachmark-title"
      style={{
        background: `radial-gradient(circle at ${cx0}px ${cy0}px, transparent ${radius}px, rgba(0,0,0,0.62) ${radius + 1}px)`,
      }}
    >
      <div
        className="absolute rounded-lg"
        style={{
          top: rect.top - SPOTLIGHT_PADDING,
          left: rect.left - SPOTLIGHT_PADDING,
          width: rect.width + SPOTLIGHT_PADDING * 2,
          height: rect.height + SPOTLIGHT_PADDING * 2,
          boxShadow: "0 0 0 2px var(--ring), 0 0 22px rgba(0,0,0,0.35)",
        }}
      />

      <div
        className="animate-pop-in pointer-events-auto absolute flex flex-col rounded-xl border border-border bg-card p-4 shadow-xl"
        style={{
          top: card.top,
          left: card.left,
          width: CARD_WIDTH,
          maxHeight: Math.max(CARD_MARGIN * 8, window.innerHeight - card.top - CARD_MARGIN),
        }}
      >
        {cardBody}
      </div>
    </div>
  );
}

export function InteractiveOnboardingChecklist({
  steps,
  open: controlledOpen,
  defaultOpen = false,
  title = "Guided setup",
  onOpenChange,
  onActivateStep,
  onFinish,
  onSkip,
  autoSpotlight = true,
  manualCompletion = true,
}: InteractiveOnboardingChecklistProps) {
  const portal = usePortalTarget();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [localCompleted, setLocalCompleted] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  // The coachmark is spotlighted once per panel-open. Without this guard, dismissing the
  // coachmark (Escape, or a primary action that navigates away in data-driven mode) would
  // immediately re-trigger the auto-advance effect and re-dim the page the operator was
  // just sent to. Reset when the panel closes so reopening starts the tour again.
  const autoOpenedRef = useRef(false);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const completed = useMemo(
    () =>
      new Set<string>([
        ...steps.filter((s) => s.completed).map((s) => s.id),
        ...(manualCompletion ? [...localCompleted] : []),
      ]),
    [steps, manualCompletion, localCompleted],
  );

  const totalSteps = steps.length;

  // The side checklist and its progress count only the visible (build) steps, so bookend
  // coachmarks like an intro or summary do not inflate "2/6". The coachmark sequence still
  // walks the full steps array.
  const listSteps = useMemo(() => steps.filter((s) => !s.hideInList), [steps]);
  const listTotal = listSteps.length;
  const listDone = listSteps.filter((s) => completed.has(s.id)).length;
  const progress = listTotal === 0 ? 0 : (listDone / listTotal) * 100;
  const buildAllComplete = listTotal > 0 && listDone === listTotal;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
      if (!next) setActiveId(null);
    },
    [isControlled, onOpenChange],
  );

  // Auto-advance the coachmark to the first remaining step the first time the panel opens,
  // so the operator is immediately pointed at the next real task. After that first spotlight
  // the operator drives navigation (list clicks, prev/next), so this never re-fires and
  // re-dims the screen on dismiss.
  useEffect(() => {
    if (!open) {
      autoOpenedRef.current = false;
      return;
    }
    if (!autoSpotlight) return;
    if (activeId || autoOpenedRef.current) return;
    const firstIncomplete = steps.find((s) => !completed.has(s.id));
    if (!firstIncomplete) return;
    const timer = setTimeout(() => {
      autoOpenedRef.current = true;
      setActiveId(firstIncomplete.id);
    }, 350);
    return () => clearTimeout(timer);
  }, [open, autoSpotlight, activeId, steps, completed]);

  // When external (data-driven) completion marks the active step done, move on. During the
  // auto-spotlight tour this advances to the next remaining step; in manual mode it simply
  // closes the coachmark so a reopened-after-skip guide never jumps to the next uncreated step.
  useEffect(() => {
    if (!activeId) return;
    if (!completed.has(activeId)) return;
    if (!autoSpotlight) {
      setActiveId(null);
      return;
    }
    const idx = steps.findIndex((s) => s.id === activeId);
    const next = steps.slice(idx + 1).find((s) => !completed.has(s.id));
    setActiveId(next ? next.id : null);
  }, [activeId, steps, completed, autoSpotlight]);

  const activeStep = activeId ? (steps.find((s) => s.id === activeId) ?? null) : null;
  const activeIndex = activeStep ? steps.indexOf(activeStep) : -1;
  const hasPrevIncomplete =
    activeIndex > 0 && steps.slice(0, activeIndex).some((s) => !completed.has(s.id));
  const hasNextIncomplete =
    activeIndex >= 0 &&
    activeIndex < totalSteps - 1 &&
    steps.slice(activeIndex + 1).some((s) => !completed.has(s.id));

  function gotoIncomplete(from: number, dir: 1 | -1) {
    for (let i = from; i >= 0 && i < totalSteps; i += dir) {
      if (!completed.has(steps[i].id)) {
        setActiveId(steps[i].id);
        return;
      }
    }
  }

  function primaryAction(stepId: string) {
    onActivateStep?.(stepId);
    const step = steps.find((s) => s.id === stepId);
    if (manualCompletion) {
      setLocalCompleted((prev) => new Set([...prev, stepId]));
      const idx = steps.findIndex((s) => s.id === stepId);
      const merged = new Set([...completed, stepId]);
      const next = steps.slice(idx + 1).find((s) => !merged.has(s.id));
      setActiveId(next ? next.id : null);
      if (steps.every((s) => merged.has(s.id))) setTimeout(() => onFinish?.(), 120);
    } else if (step?.advanceOnAction) {
      // Informational step (orientation/summary): its CTA does not navigate, so advance the
      // coachmark to the next remaining step in place to keep the tour moving.
      const idx = steps.findIndex((s) => s.id === stepId);
      const next = steps.slice(idx + 1).find((s) => !completed.has(s.id));
      setActiveId(next ? next.id : null);
    } else {
      // Data-driven build step: the CTA opened the real page/form, so close the coachmark
      // and let completion arrive when the object actually exists (via `completed`).
      setActiveId(null);
    }
  }

  if (!portal) return null;

  return createPortal(
    <>
      {open ? (
        <div
          className="animate-slide-in-right fixed bottom-4 right-4 z-[55] flex max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden border border-border bg-card shadow-xl"
          role="dialog"
          aria-label={title}
        >
          <div className="flex flex-col gap-2.5 border-b border-border px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {title}
              </h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Dismiss guided setup"
                className="-mr-1 grid h-6 w-6 place-items-center text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border">
                <div
                  className="h-px bg-foreground transition-[width] duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
                {listDone}/{listTotal}
              </span>
            </div>
          </div>

          <ul className="scrollbar-thin flex-1 overflow-y-auto py-1">
            {listSteps.map((step, index) => {
              const isDone = completed.has(step.id);
              const isActive = activeId === step.id;
              return (
                <li key={step.id}>
                  <button
                    onClick={() => !isDone && setActiveId(step.id)}
                    disabled={isDone}
                    aria-current={isActive ? "step" : undefined}
                    className={cx(
                      "group relative flex w-full items-start gap-3 px-4 py-2.5 text-left outline-none transition-colors",
                      "focus-visible:bg-accent/60",
                      isDone ? "cursor-default" : isActive ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    {isActive && !isDone ? (
                      <span className="absolute inset-y-0 left-0 w-0.5 bg-foreground" />
                    ) : null}
                    <span className="mt-px flex-shrink-0">
                      {isDone ? (
                        <span className="grid h-5 w-5 place-items-center bg-foreground text-background">
                          <CheckIcon className="h-3 w-3" />
                        </span>
                      ) : (
                        <span
                          className={cx(
                            "grid h-5 w-5 place-items-center border text-[11px] font-medium tabular-nums transition-colors",
                            isActive
                              ? "border-foreground bg-foreground text-background"
                              : "border-border text-muted-foreground group-hover:border-foreground/40 group-hover:text-foreground",
                          )}
                        >
                          {index + 1}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cx(
                          "block text-sm leading-snug",
                          isDone
                            ? "text-muted-foreground line-through"
                            : "font-medium text-foreground",
                        )}
                      >
                        {step.title.replace(/^\d+\.\s*/, "")}
                      </span>
                      {step.description ? (
                        <span
                          className={cx(
                            "mt-0.5 block text-xs leading-snug text-muted-foreground",
                            isDone && "line-through opacity-70",
                          )}
                        >
                          {step.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {buildAllComplete ? (
            <div className="border-t border-border p-3">
              <Button
                className="w-full"
                onClick={() => {
                  onFinish?.();
                  setOpen(false);
                }}
              >
                <CheckIcon className="h-4 w-4" />
                Finish setup
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {activeStep ? (
        <CoachmarkOverlay
          step={activeStep}
          isFirst={!hasPrevIncomplete}
          isLast={!hasNextIncomplete}
          manualCompletion={manualCompletion}
          onNext={() => gotoIncomplete(activeIndex + 1, 1)}
          onPrev={() => gotoIncomplete(activeIndex - 1, -1)}
          onPrimary={() => primaryAction(activeStep.id)}
          onClose={() => setActiveId(null)}
          onSkip={onSkip}
        />
      ) : null}
    </>,
    portal,
  );
}
