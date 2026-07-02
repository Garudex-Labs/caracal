/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file frames the full-page guided onboarding flow.
*/
import { Link } from "@tanstack/react-router";
import type { FormEvent, ReactNode } from "react";

import { cx } from "@/lib/cx";

export interface OnboardingStep {
  title: string;
  summary: string;
}

function CheckIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function StepRail({ steps, current }: { steps: OnboardingStep[]; current: number }) {
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "active" : "todo";
        return (
          <li
            key={step.title}
            aria-current={state === "active" ? "step" : undefined}
            className="flex items-start gap-3 rounded-md px-3 py-2.5"
          >
            <span
              className={cx(
                "mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border text-xs font-semibold transition-colors",
                state === "done" && "border-transparent bg-white text-[#121016]",
                state === "active" && "border-white text-white",
                state === "todo" && "border-white/25 text-white/40",
              )}
            >
              {state === "done" ? <CheckIcon /> : index + 1}
            </span>
            <span className="min-w-0">
              <span
                className={cx(
                  "block text-sm font-medium",
                  state === "todo" ? "text-white/45" : "text-white",
                )}
              >
                {step.title}
              </span>
              <span
                className={cx(
                  "mt-0.5 block text-xs",
                  state === "todo" ? "text-white/30" : "text-white/55",
                )}
              >
                {step.summary}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function MobileProgress({ steps, current }: { steps: OnboardingStep[]; current: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-6 lg:hidden">
      <div aria-hidden="true" className="flex flex-1 items-center gap-1.5">
        {steps.map((step, index) => (
          <span
            key={step.title}
            className={cx(
              "h-1 flex-1 rounded-full transition-colors",
              index <= current ? "bg-foreground" : "bg-border",
            )}
          />
        ))}
      </div>
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {current + 1}/{steps.length}
      </span>
    </div>
  );
}

export function OnboardingLayout({
  steps,
  current,
  title,
  description,
  signedInAs,
  onSignOut,
  onSubmit,
  children,
  footer,
}: {
  steps: OnboardingStep[];
  current: number;
  title: string;
  description: string;
  signedInAs: string;
  onSignOut: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="grid h-dvh overflow-hidden lg:grid-cols-[340px_1fr] xl:grid-cols-[380px_1fr]">
      <aside
        className="relative hidden flex-col overflow-hidden p-8 text-white lg:flex xl:p-10"
        style={{ backgroundColor: "#121016" }}
      >
        <Link to="/" className="relative z-10 flex shrink-0 items-center">
          <img
            src="/caracal_dark.png"
            alt="Caracal"
            className="h-auto w-44 max-w-full object-contain xl:w-52"
          />
        </Link>

        <div className="scrollbar-thin relative z-10 -mx-3 my-6 min-h-0 flex-1 overflow-y-auto">
          <StepRail steps={steps} current={current} />
        </div>

        <p className="relative z-10 max-w-xs shrink-0 text-xs leading-relaxed text-white/45">
          You own this environment. Caracal runs entirely under your control.
        </p>

        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-24 top-1/3 h-72 w-72 rounded-full opacity-25 blur-3xl"
          style={{ backgroundColor: "#6C3FF5" }}
        />
      </aside>

      <main className="flex min-h-0 flex-col bg-background">
        <MobileProgress steps={steps} current={current} />

        <header className="relative shrink-0 border-b border-border px-6 pb-6 pt-6 sm:px-10 md:px-14 md:pb-7 md:pt-8">
          <div aria-live="polite" className="w-full animate-fade-in">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.2em]">
                <span className="tabular-nums text-primary">
                  {String(current + 1).padStart(2, "0")}
                </span>
                <span className="tabular-nums text-muted-foreground/40">
                  / {String(steps.length).padStart(2, "0")}
                </span>
                <span aria-hidden="true" className="h-3 w-px bg-border" />
                <span className="truncate text-muted-foreground">{steps[current]?.title}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <span className="hidden max-w-55 truncate md:inline" title={signedInAs}>
                  {signedInAs}
                </span>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="rounded font-medium underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  Sign out
                </button>
              </div>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
              {title}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          </div>

          <div className="absolute inset-x-0 bottom-0 h-0.5 bg-border/50">
            <div
              className="h-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${((current + 1) / steps.length) * 100}%` }}
            />
          </div>
        </header>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10 md:px-14">
            <div key={current} className="w-full animate-fade-in">
              {children}
            </div>
          </div>

          <footer className="shrink-0 border-t border-border bg-background/95 px-6 py-4 backdrop-blur sm:px-10 md:px-14">
            <div className="flex w-full items-center justify-between gap-3">{footer}</div>
          </footer>
        </form>
      </main>
    </div>
  );
}
