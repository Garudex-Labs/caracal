/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the interactive onboarding checklist with element-anchored coachmarks for guided setup.
*/
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { cx } from "@/lib/cx";
import { Button } from "./Primitives";

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

function CircleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
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
}: {
  step: Step;
  isFirst: boolean;
  isLast: boolean;
  manualCompletion: boolean;
  onNext: () => void;
  onPrev: () => void;
  onPrimary: () => void;
  onClose: () => void;
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
        <Button size="sm" onClick={onPrimary}>
          {primaryLabel}
        </Button>
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
        className="animate-fade-in fixed inset-0 z-[60] flex items-center justify-center bg-foreground/45 p-4 backdrop-blur-[1px]"
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
    if (activeId || autoOpenedRef.current) return;
    const firstIncomplete = steps.find((s) => !completed.has(s.id));
    if (!firstIncomplete) return;
    const timer = setTimeout(() => {
      autoOpenedRef.current = true;
      setActiveId(firstIncomplete.id);
    }, 350);
    return () => clearTimeout(timer);
  }, [open, activeId, steps, completed]);

  // When external (data-driven) completion marks the active step done, move on.
  useEffect(() => {
    if (!activeId) return;
    if (!completed.has(activeId)) return;
    const idx = steps.findIndex((s) => s.id === activeId);
    const next = steps.slice(idx + 1).find((s) => !completed.has(s.id));
    setActiveId(next ? next.id : null);
  }, [activeId, steps, completed]);

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
          className="animate-slide-in-right fixed bottom-4 right-4 z-[55] flex max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
          role="dialog"
          aria-label={title}
        >
          <div className="border-b border-border p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">{title}</h2>
              <button
                onClick={() => setOpen(false)}
                aria-label="Dismiss guided setup"
                className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-medium text-foreground">
                {listDone}/{listTotal}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <ul className="scrollbar-thin flex-1 overflow-y-auto p-3">
            {listSteps.map((step) => {
              const isDone = completed.has(step.id);
              const isActive = activeId === step.id;
              return (
                <li key={step.id} className="mb-2 last:mb-0">
                  <button
                    onClick={() => !isDone && setActiveId(step.id)}
                    disabled={isDone}
                    className={cx(
                      "w-full rounded-lg border p-3 text-left transition-colors",
                      "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      isDone
                        ? "cursor-default border-emerald-500/30 bg-emerald-500/10"
                        : "border-border hover:bg-accent/50",
                      isActive && !isDone ? "ring-2 ring-ring/50" : "",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span className="mt-0.5 flex-shrink-0">
                        {isDone ? (
                          <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-white">
                            <CheckIcon className="h-3 w-3" />
                          </span>
                        ) : (
                          <CircleIcon className="h-5 w-5 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span
                          className={cx(
                            "block text-sm font-medium",
                            isDone ? "text-muted-foreground line-through" : "text-foreground",
                          )}
                        >
                          {step.title}
                        </span>
                        {step.description ? (
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {step.description}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          {buildAllComplete ? (
            <div className="border-t border-border p-4">
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
        />
      ) : null}
    </>,
    portal,
  );
}
