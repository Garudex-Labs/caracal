/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file wires the in-app guided setup: a short, element-anchored walkthrough that explains each building block and opens its real create form.
*/
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { InteractiveOnboardingChecklist, type Step, type StepMedia } from "@/components/ui";
import {
  useActiveZone,
  useApplications,
  usePolicySets,
  useProviders,
  useResources,
  useSystemZoneView,
} from "@/platform/api/hooks";
import { useGuide } from "@/platform/state/guideAccount";
import { CONSOLE_SETUP_GUIDE } from "@/platform/state/guides";

interface SetupStep extends Step {
  to?: string;
  search?: Record<string, string>;
}

// Per-step media shown above each coachmark. Attach an image or a clickable YouTube video
// to any step by its id; omit an id (or leave it undefined) to show no media and reclaim the
// space. Examples:
//   application: { type: "image", src: "/guides/register-app.png", alt: "Application form" }
//   provider:    { type: "video", href: "https://youtu.be/VIDEO_ID", alt: "Connecting a provider" }
const STEP_MEDIA: Record<string, StepMedia | undefined> = {
  orientation: { type: "image", src: "/steps/1.png", alt: "Zone access building blocks" },
  application: { type: "image", src: "/steps/2.png", alt: "Register an application" },
  provider: { type: "image", src: "/steps/3.png", alt: "Connect a provider" },
  resource: { type: "image", src: "/steps/4.png", alt: "Define a resource" },
  policy: { type: "image", src: "/steps/5.png", alt: "Activate a policy" },
  verify: { type: "image", src: "/steps/6.png", alt: "Verify access" },
};

function PlayIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5l5 3.5-5 3.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className={className}
    >
      <path d="M6 6l12 12M6 18 18 6" strokeLinecap="round" />
    </svg>
  );
}

// Compact "you'll set" field list, two items max, one line each, so the card stays
// scannable instead of becoming prose.
function Fields({ items }: { items: { name: string; hint: string }[] }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        You&apos;ll set
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.name} className="text-xs leading-snug">
            <span className="font-medium text-foreground">{item.name}</span>
            <span className="text-muted-foreground">: {item.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One-time mental model, shown only on the orientation step.
function ChainMap() {
  const nodes = ["Application", "Provider", "Resource", "Policy"];
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs">
      <span className="font-medium text-foreground">Zone</span>
      <span className="text-muted-foreground">→</span>
      {nodes.map((node, index) => (
        <span key={node} className="flex items-center gap-1">
          <span className="text-foreground">{node}</span>
          {index < nodes.length - 1 ? <span className="text-muted-foreground">+</span> : null}
        </span>
      ))}
      <span className="text-muted-foreground">→</span>
      <span className="font-medium text-foreground">Access</span>
    </div>
  );
}

// Drives the guided walkthrough from the active zone's real inventory. Each build step is a
// one-line explanation plus the two fields the operator will fill, with a button that opens
// the real form. Every step ticks off from live data: the orientation bookend completes once
// anything is built and the verify bookend once everything is. Whether the guide launches,
// resumes, or stays retired is read from the account-held guide record, so the decision
// survives restarts and new browsers.
export function GuidedSetup() {
  const navigate = useNavigate();
  const systemView = useSystemZoneView();
  const { activeZone } = useActiveZone();
  const zoneId = activeZone?.id ?? null;

  const applications = useApplications(zoneId);
  const resources = useResources(zoneId);
  const providers = useProviders(zoneId);
  const policySets = usePolicySets(zoneId);

  const settled =
    !applications.isLoading &&
    !resources.isLoading &&
    !providers.isLoading &&
    !policySets.isLoading;

  const guide = useGuide(CONSOLE_SETUP_GUIDE);
  const [open, setOpen] = useState(false);
  // True only while the panel is showing because of the genuine first-visit auto-launch. It
  // gates the step-by-step coachmark: after the guide is skipped or dismissed, reopening the
  // list from the launcher shows only the checklist, never the auto-spotlight popup again.
  const [autoStart, setAutoStart] = useState(false);
  const launchDecided = useRef(false);

  const hasApps = (applications.data?.length ?? 0) > 0;
  const hasProviders = (providers.data?.length ?? 0) > 0;
  const hasResources = (resources.data?.length ?? 0) > 0;
  const hasActivePolicy = (policySets.data ?? []).some((set) => set.active_version_id);
  const anyBuilt = hasApps || hasProviders || hasResources || hasActivePolicy;
  const buildComplete = hasApps && hasProviders && hasResources && hasActivePolicy;

  const steps: SetupStep[] = useMemo(
    () => [
      {
        id: "orientation",
        title: "Set up access in 4 steps",
        description: "A zone authorizes a request once it has these four things.",
        targetSelector: "",
        actionLabel: "Start",
        media: STEP_MEDIA.orientation,
        advanceOnAction: true,
        hideInList: true,
        completed: anyBuilt,
        details: (
          <div className="flex flex-col gap-2">
            <ChainMap />
            <p className="text-xs text-muted-foreground">
              Until a policy is active, the zone denies everything. We&apos;ll add each piece in
              order. Every step opens the real form.
            </p>
          </div>
        ),
      },
      {
        id: "application",
        title: "1. Register an application",
        description: "The identity that asks for access. Policies grant scopes to it.",
        targetSelector: '[data-tour="nav-applications"]',
        to: "/app/applications",
        search: { create: "1" },
        actionLabel: "Open the form",
        media: STEP_MEDIA.application,
        completed: hasApps,
        details: (
          <Fields
            items={[
              { name: "Name", hint: "a label for the agent, e.g. Son of Anton." },
              { name: "Traits", hint: "optional tags; leave empty to start." },
            ]}
          />
        ),
      },
      {
        id: "provider",
        title: "2. Connect a provider",
        description: "Where upstream credentials come from at runtime.",
        targetSelector: '[data-tour="nav-providers"]',
        to: "/app/providers",
        search: { create: "1" },
        actionLabel: "Open the form",
        media: STEP_MEDIA.provider,
        completed: hasProviders,
        details: (
          <Fields
            items={[
              { name: "Kind", hint: "OAuth, API key, etc. Picks the rest of the form." },
              { name: "Identifier", hint: "unique in the zone, e.g. provider://hooli-oidc." },
            ]}
          />
        ),
      },
      {
        id: "resource",
        title: "3. Define a resource",
        description: "What is protected, and the scopes that can be granted on it.",
        targetSelector: '[data-tour="nav-resources"]',
        to: "/app/resources",
        search: { create: "1" },
        actionLabel: "Open the form",
        media: STEP_MEDIA.resource,
        completed: hasResources,
        details: (
          <Fields
            items={[
              { name: "Identifier", hint: "the protected upstream, e.g. resource://pipernet." },
              { name: "Scopes", hint: "grantable permissions, e.g. pipernet:read." },
            ]}
          />
        ),
      },
      {
        id: "policy",
        title: "4. Activate a policy",
        description: "The rules that switch the zone from deny-all to authorized.",
        targetSelector: '[data-tour="nav-policies"]',
        to: "/app/policies",
        search: { create: "policy" },
        actionLabel: "Open the editor",
        media: STEP_MEDIA.policy,
        completed: hasActivePolicy,
        details: (
          <Fields
            items={[
              { name: "Name", hint: "what it authorizes, e.g. PiperNet read." },
              { name: "Rego", hint: "start from a template, then activate it." },
            ]}
          />
        ),
      },
      {
        id: "verify",
        title: buildComplete ? "You're enforcing" : "Almost there",
        description: buildComplete
          ? "This zone now authorizes requests for the scopes your policy grants."
          : "Finish the unchecked steps. The zone denies by default until then.",
        targetSelector: "",
        to: "/app",
        actionLabel: buildComplete ? "Go to dashboard" : "Done for now",
        media: STEP_MEDIA.verify,
        advanceOnAction: true,
        hideInList: true,
        completed: buildComplete,
        details: buildComplete ? (
          <p className="text-xs text-muted-foreground">
            Use <span className="text-foreground">Simulate</span> on the policy set to dry-run a
            decision, and watch <span className="text-foreground">Sessions</span> and{" "}
            <span className="text-foreground">Audit</span> as agents exchange tokens.
          </p>
        ) : undefined,
      },
    ],
    [anyBuilt, hasApps, hasProviders, hasResources, hasActivePolicy, buildComplete],
  );

  const allComplete = settled && steps.every((s) => s.completed);

  // The launch decision is made exactly once per mount, and only after both inputs are
  // authoritative: the zone inventory has settled and the account's guide record has loaded.
  // A guide that was ever seen never auto-opens again - reloads, navigation, restarts, and
  // new sign-ins all land here with status "seen" or "done". An account whose zone is already
  // fully built retires the guide silently instead of teaching what already exists.
  useEffect(() => {
    if (launchDecided.current || systemView) return;
    if (!zoneId || !settled || !guide.ready) return;
    launchDecided.current = true;
    if (guide.status !== "unseen") return;
    if (buildComplete) {
      guide.advance("done");
      return;
    }
    setOpen(true);
    setAutoStart(true);
    guide.advance("seen");
  }, [systemView, zoneId, settled, guide, buildComplete]);

  // Permanently retire the guide once the operator is done with it: either they walked the
  // full tour (allComplete, incl. the verify bookend), or all four build tasks are finished
  // and the panel is closed (so completing the last task on its real form auto-hides the
  // launcher instead of leaving a stale circle behind). Manual dismissal also retires it.
  useEffect(() => {
    if (guide.status !== "seen") return;
    if (allComplete || (buildComplete && !open)) guide.advance("done");
  }, [guide, allComplete, buildComplete, open]);

  if (systemView || !zoneId || !guide.ready) return null;
  if (guide.status === "done") return null;

  const buildDone = [hasApps, hasProviders, hasResources, hasActivePolicy].filter(Boolean).length;

  return (
    <>
      <InteractiveOnboardingChecklist
        steps={steps}
        open={open}
        autoSpotlight={autoStart}
        title="Guided setup"
        manualCompletion={false}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setAutoStart(false);
        }}
        onActivateStep={(id) => {
          if (id === "orientation") {
            return;
          }
          if (id === "verify") {
            navigate({ to: "/app" });
            return;
          }
          const step = steps.find((s) => s.id === id);
          if (step?.to) navigate({ to: step.to, search: step.search ?? {} });
        }}
        onFinish={() => guide.advance("done")}
        onSkip={() => guide.advance("done")}
      />

      {!open && settled ? (
        <div className="group fixed bottom-4 right-4 z-[55]">
          <button
            onClick={() => setOpen(true)}
            aria-label="Open guided setup"
            className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:shadow-xl"
          >
            <PlayIcon className="h-6 w-6" />
          </button>
          {buildDone > 0 && !buildComplete ? (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-card bg-emerald-500 text-[10px] font-bold text-white transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
              {buildDone}
            </span>
          ) : null}
          <button
            onClick={() => guide.advance("done")}
            aria-label="Hide setup guide"
            title="Hide setup guide"
            className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 group-hover:opacity-100"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        </div>
      ) : null}
    </>
  );
}
