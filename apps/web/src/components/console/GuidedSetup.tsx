/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file wires the in-app guided setup: a narrated, element-anchored checklist that teaches the authorization model and drops operators into the real create forms.
*/
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { InteractiveOnboardingChecklist, type Step } from "@/components/ui";
import {
  useActiveZone,
  useApplications,
  usePolicySets,
  useProviders,
  useResources,
} from "@/platform/api/hooks";
import {
  getGuidedSetup,
  setGuidedSetup,
  type GuidedSetupRecord,
} from "@/platform/state/localInstall";

interface SetupStep extends Step {
  to?: string;
  search?: Record<string, string>;
}

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

// Compact lesson layout shared by every build step: what the object is, why it matters in
// the authority chain, and the fields the operator will fill — so the coachmark teaches the
// concept and the form, not just the location of a button.
function Lesson({
  what,
  why,
  fields,
}: {
  what: string;
  why: string;
  fields: { name: string; hint: string }[];
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          What it is
        </div>
        <p className="mt-0.5 text-foreground">{what}</p>
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Why it matters
        </div>
        <p className="mt-0.5 text-muted-foreground">{why}</p>
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          What you&apos;ll fill in
        </div>
        <ul className="mt-1 flex flex-col gap-1.5">
          {fields.map((field) => (
            <li key={field.name} className="flex gap-2">
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-foreground/50" />
              <span>
                <span className="font-medium text-foreground">{field.name}</span>
                <span className="text-muted-foreground"> — {field.hint}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ChainMap({ active }: { active: string }) {
  const nodes = [
    { id: "application", label: "Application" },
    { id: "provider", label: "Provider" },
    { id: "resource", label: "Resource" },
    { id: "policy", label: "Policy" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
      <span className="font-medium text-foreground">Zone</span>
      <span className="text-muted-foreground">→</span>
      {nodes.map((node, index) => (
        <span key={node.id} className="flex items-center gap-1.5">
          <span
            className={
              node.id === active
                ? "rounded bg-primary px-1.5 py-0.5 font-medium text-primary-foreground"
                : "text-muted-foreground"
            }
          >
            {node.label}
          </span>
          {index < nodes.length - 1 ? <span className="text-muted-foreground">+</span> : null}
        </span>
      ))}
      <span className="text-muted-foreground">→</span>
      <span className="font-medium text-foreground">Runtime</span>
    </div>
  );
}

// Drives the narrated guided setup from the active zone's real inventory. The tour opens
// with the authorization model, walks each building block (teaching its fields and reason
// before deep linking into the real create form), and closes by sending the operator to
// verify enforcement. Build steps complete from live backend state; the orientation and
// verify bookends complete when acknowledged.
export function GuidedSetup() {
  const navigate = useNavigate();
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

  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState<GuidedSetupRecord | null>(null);
  const [ackOrientation, setAckOrientation] = useState(false);
  const [ackVerify, setAckVerify] = useState(false);

  function updatePref(next: GuidedSetupRecord) {
    setGuidedSetup(next);
    setPref(next);
  }

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
        title: "How authorization works here",
        description: "A quick map before you build — every step below has a purpose and an order.",
        targetSelector: "",
        actionLabel: "Start building",
        advanceOnAction: true,
        completed: ackOrientation || anyBuilt,
        details: (
          <div className="flex flex-col gap-3 text-sm">
            <ChainMap active="" />
            <p className="text-muted-foreground">
              Caracal brokers authority inside a <span className="text-foreground">zone</span>. To
              authorize a request it needs four things: an{" "}
              <span className="text-foreground">application</span> (who is asking), a{" "}
              <span className="text-foreground">provider</span> (where upstream credentials come
              from), a <span className="text-foreground">resource</span> (what is being accessed and
              with which scopes), and an active <span className="text-foreground">policy set</span>{" "}
              (the rules). Until a policy set is active, the zone denies everything by default.
            </p>
            <p className="text-muted-foreground">
              We&apos;ll do them in that order. Each step opens the real form and explains every
              field. It ticks off here automatically once the object exists.
            </p>
          </div>
        ),
      },
      {
        id: "application",
        title: "Register an application",
        description: "The identity that requests authority.",
        targetSelector: '[data-tour="nav-applications"]',
        to: "/app/applications",
        search: { create: "1" },
        actionLabel: "Open the form",
        completed: hasApps,
        details: (
          <>
            <ChainMap active="application" />
            <div className="mt-3">
              <Lesson
                what="A managed application is a stable identity — an agent, service, worker, or CI job — that authenticates to Caracal and requests tokens."
                why="It is the “who” in every authorization decision. Policies grant scopes to applications, and the runtime issues tokens to them."
                fields={[
                  { name: "Name", hint: "a human label for the workload, e.g. Billing Worker." },
                  {
                    name: "Traits",
                    hint: "optional tags policies can match on (max 32); leave empty to start.",
                  },
                ]}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                On create you&apos;ll see a one-time client secret — copy it then; it is never shown
                again.
              </p>
            </div>
          </>
        ),
      },
      {
        id: "provider",
        title: "Connect a provider",
        description: "Where upstream credentials come from.",
        targetSelector: '[data-tour="nav-providers"]',
        to: "/app/providers",
        search: { create: "1" },
        actionLabel: "Open the form",
        completed: hasProviders,
        details: (
          <>
            <ChainMap active="provider" />
            <div className="mt-3">
              <Lesson
                what="A provider is an upstream identity or credential source the zone brokers — an OAuth provider, an API-key source, or a token exchange."
                why="Resources reference a provider to obtain real upstream credentials at runtime, so Caracal can mint scoped access on the agent's behalf."
                fields={[
                  {
                    name: "Kind",
                    hint: "the provider type (OAuth, API key, …) — sets the rest of the form.",
                  },
                  {
                    name: "Identifier",
                    hint: "provider://lowercase-slug, unique within the zone.",
                  },
                  {
                    name: "Config",
                    hint: "endpoints and auth method; secret fields are write-only.",
                  },
                ]}
              />
            </div>
          </>
        ),
      },
      {
        id: "resource",
        title: "Define a resource",
        description: "What is protected, and the scopes on it.",
        targetSelector: '[data-tour="nav-resources"]',
        to: "/app/resources",
        search: { create: "1" },
        actionLabel: "Open the form",
        completed: hasResources,
        details: (
          <>
            <ChainMap active="resource" />
            <div className="mt-3">
              <Lesson
                what="A resource describes a protected upstream the Gateway authorizes — its identifier, the scopes that can be granted on it, and the provider that backs its credentials."
                why="It is the “what” in a decision. Policies grant an application a set of scopes on a resource; the runtime enforces exactly those."
                fields={[
                  {
                    name: "Identifier",
                    hint: "resource://lowercase-slug naming the protected thing.",
                  },
                  {
                    name: "Scopes",
                    hint: "the permission strings agents can be granted, e.g. example:read.",
                  },
                  {
                    name: "Credential provider",
                    hint: "the provider this resource draws upstream credentials from.",
                  },
                ]}
              />
            </div>
          </>
        ),
      },
      {
        id: "policy",
        title: "Author & activate a policy",
        description: "The rules that turn deny-all into authorized access.",
        targetSelector: '[data-tour="nav-policies"]',
        to: "/app/policies",
        search: { create: "policy" },
        actionLabel: "Open the editor",
        completed: hasActivePolicy,
        details: (
          <>
            <ChainMap active="policy" />
            <div className="mt-3">
              <Lesson
                what="A policy is a Rego data document (package caracal.authz, marked # caracal:data-document). It supplies data — grants, application bindings — that the platform decision contract reads. It never decides on its own."
                why="No active policy set means the zone denies every request. Composing your policy into a policy set and activating it is what finally authorizes traffic."
                fields={[
                  { name: "Name", hint: "what the policy authorizes, e.g. billing-read-access." },
                  {
                    name: "Rego source",
                    hint: "start from a template; define data like grants and app_ids — never result.",
                  },
                ]}
              />
              <p className="mt-3 text-xs text-muted-foreground">
                After saving the policy, compose it into a policy set and activate it — the Policies
                tab walks you through it.
              </p>
            </div>
          </>
        ),
      },
      {
        id: "verify",
        title: "Verify enforcement",
        description: "Confirm the zone is authorizing, not denying.",
        targetSelector: "",
        to: "/app",
        actionLabel: buildComplete ? "Go to dashboard" : "Review remaining steps",
        advanceOnAction: true,
        completed: ackVerify,
        details: (
          <div className="flex flex-col gap-3 text-sm">
            <ChainMap active="" />
            {buildComplete ? (
              <p className="text-muted-foreground">
                All four building blocks are in place, so this zone now authorizes requests for the
                scopes your policy grants. Use <span className="text-foreground">Simulate</span> on
                the policy set to dry-run a decision, and watch{" "}
                <span className="text-foreground">Sessions</span> and{" "}
                <span className="text-foreground">Audit</span> as agents start exchanging tokens.
              </p>
            ) : (
              <p className="text-muted-foreground">
                A few building blocks are still missing, so the zone keeps denying by default.
                Finish the unchecked steps above — each opens its real form with the fields
                explained.
              </p>
            )}
          </div>
        ),
      },
    ],
    [
      ackOrientation,
      anyBuilt,
      hasApps,
      hasProviders,
      hasResources,
      hasActivePolicy,
      buildComplete,
      ackVerify,
    ],
  );

  const allComplete = settled && steps.every((s) => s.completed);

  useEffect(() => {
    if (pref) return;
    const record = getGuidedSetup();
    if (!record.dismissed && !record.finished) setOpen(true);
    setPref(record);
  }, [pref]);

  useEffect(() => {
    if (!pref || pref.finished || !allComplete) return;
    updatePref({ dismissed: pref.dismissed, finished: true });
  }, [pref, allComplete]);

  if (!zoneId || !pref) return null;
  if (pref.finished) return null;

  const buildDone = [hasApps, hasProviders, hasResources, hasActivePolicy].filter(Boolean).length;

  return (
    <>
      <InteractiveOnboardingChecklist
        steps={steps}
        open={open}
        title="Guided setup"
        manualCompletion={false}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) updatePref({ dismissed: true, finished: pref.finished });
        }}
        onActivateStep={(id) => {
          if (id === "orientation") {
            setAckOrientation(true);
            return;
          }
          if (id === "verify") {
            setAckVerify(true);
            navigate({ to: "/app" });
            return;
          }
          const step = steps.find((s) => s.id === id);
          if (step?.to) navigate({ to: step.to, search: step.search ?? {} });
        }}
        onFinish={() => updatePref({ dismissed: true, finished: true })}
      />

      {!open && settled ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open guided setup"
          className="group fixed bottom-4 right-4 z-[55] grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-all hover:shadow-xl"
        >
          <PlayIcon className="h-6 w-6" />
          {buildDone > 0 && !buildComplete ? (
            <span className="absolute -right-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-card bg-emerald-500 text-[10px] font-bold text-white">
              {buildDone}
            </span>
          ) : null}
        </button>
      ) : null}
    </>
  );
}
