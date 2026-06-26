/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Caracal Operator route, an enterprise placeholder for natural-language control-plane management.
*/
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { ModulePage } from "@/components/console/ModulePage";
import { Badge, Button, LockBadge } from "@/components/ui";
import { config } from "@/platform/config";

export const Route = createFileRoute("/app/ai")({
  component: CaracalOperatorPage,
});

function CaracalOperatorPage() {
  return (
    <ModulePage
      title="Caracal Operator"
      description="Operate your entire Caracal control plane in natural language. Tell Caracal Operator what you want; it resolves the intent into concrete control-plane changes, shows the plan, and applies it through the same guarded APIs you use by hand — within your operator scope and recorded in the audit log."
      breadcrumbs={[{ label: "Console", to: "/app" }, { label: "Caracal Operator" }]}
      actions={<LockBadge />}
    >
      <div className="flex flex-col gap-4">
        <Console />
        <Comparison />
        <Trust />
      </div>
    </ModulePage>
  );
}

function OperatorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l1.7 4.7L18 9l-4.3 1.6L12 15l-1.7-4.4L6 9z" />
      <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17z" />
    </svg>
  );
}

/* ------------------------------- console ------------------------------- */

interface Scenario {
  id: string;
  prompt: string;
  summary: string;
  steps: { object: string; action: string }[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "stand-up",
    prompt: "Stand up a Production zone with a billing worker that can read invoices",
    summary: "Four linked changes, applied as one reviewed plan.",
    steps: [
      { object: "Zone", action: "Create “Production”, DCR off" },
      { object: "Application", action: "Register managed “billing-worker”" },
      { object: "Policy", action: "Draft grant invoices:read" },
      { object: "Policy", action: "Activate on the Production zone" },
    ],
  },
  {
    id: "connect",
    prompt: "Connect payments-api to Stripe and rotate its secret",
    summary: "Wire an upstream and refresh a credential in place.",
    steps: [
      { object: "Provider", action: "Bind Stripe to payments-api" },
      { object: "Resource", action: "Set credential provider" },
      { object: "Application", action: "Rotate client secret" },
    ],
  },
  {
    id: "investigate",
    prompt: "Why was the last request from analytics-agent denied?",
    summary: "Reads your live config and audit — changes nothing.",
    steps: [
      { object: "Audit", action: "Locate the denied decision" },
      { object: "Policy", action: "Explain the missing scope" },
      { object: "Resolution", action: "Suggest the grant to add" },
    ],
  },
];

function Console() {
  const [active, setActive] = useState(SCENARIOS[0].id);
  const scenario = SCENARIOS.find((s) => s.id === active) ?? SCENARIOS[0];
  const readOnly = scenario.id === "investigate";

  return (
    <section className="overflow-hidden border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <span className="grid h-8 w-8 place-items-center border border-border bg-muted text-foreground">
          <OperatorMark className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            Describe it. Review the plan. Apply.
          </h2>
          <p className="text-xs text-muted-foreground">
            One prompt drives changes across every object in the zone.
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="flex flex-col border-b border-border lg:border-b-0 lg:border-r">
          <div className="px-3 pt-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Example prompts
          </div>
          <div className="flex flex-col gap-1 p-2">
            {SCENARIOS.map((item) => {
              const selected = item.id === scenario.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  aria-pressed={selected}
                  className={
                    "flex items-start gap-2 px-2.5 py-2 text-left text-xs leading-snug transition-colors " +
                    (selected
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground")
                  }
                >
                  <span
                    className={
                      "mt-0.5 h-1.5 w-1.5 flex-shrink-0 rounded-full " +
                      (selected ? "bg-foreground" : "bg-muted-foreground/40")
                    }
                  />
                  <span className="min-w-0">{item.prompt}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-w-0 flex-col bg-background">
          <div className="flex justify-end px-4 pt-4">
            <p className="max-w-[88%] border border-border bg-muted px-3 py-2 text-sm text-foreground">
              {scenario.prompt}
            </p>
          </div>

          <div className="flex items-start gap-2 px-4 pb-4 pt-3">
            <span className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center border border-border bg-muted text-foreground">
              <OperatorMark className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1 border border-border bg-card">
              <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                <span className="text-xs font-medium text-foreground">
                  {readOnly ? "Read-only · no changes" : `Plan · ${scenario.steps.length} changes`}
                </span>
                <Badge tone={readOnly ? "muted" : "success"}>
                  {readOnly ? "Safe" : "Awaiting approval"}
                </Badge>
              </div>
              <ul>
                {scenario.steps.map((step, index) => (
                  <li
                    key={`${step.object}-${index}`}
                    className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs last:border-b-0"
                  >
                    <span className="grid h-4 w-4 flex-shrink-0 place-items-center border border-border font-mono text-[10px] text-foreground">
                      {index + 1}
                    </span>
                    <span className="w-24 flex-shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                      {step.object}
                    </span>
                    <span className="min-w-0 text-foreground">{step.action}</span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                {scenario.summary}
              </p>
            </div>
          </div>

          <div className="mt-auto flex items-center gap-2 border-t border-border p-3">
            <input
              disabled
              value={scenario.prompt}
              readOnly
              className="h-9 min-w-0 flex-1 cursor-not-allowed truncate border border-input bg-muted/40 px-3 text-sm text-muted-foreground"
            />
            <Button size="sm" disabled>
              {readOnly ? "Ask" : "Apply"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ commands ------------------------------ */

const COMMAND_GROUPS: { label: string; phrases: string[] }[] = [
  {
    label: "Create",
    phrases: [
      "Create a Staging zone",
      "Register an app called etl-runner",
      "Add an OAuth provider for GitHub",
      "Define a resource for orders-api",
    ],
  },
  {
    label: "Change",
    phrases: [
      "Rotate the secret for billing-worker",
      "Rebind reports-api to the new provider",
      "Grant invoices:write to billing-worker",
      "Turn off DCR for Production",
    ],
  },
  {
    label: "Understand",
    phrases: [
      "What can analytics-agent access?",
      "Why did this request get denied?",
      "Which resources use the Stripe provider?",
      "Show policies that grant orders:read",
    ],
  },
];

/* ----------------------------- comparison ----------------------------- */

const FLOW: { manual: string; ai: string }[] = [
  {
    manual: "Open each page and create objects one by one",
    ai: "Describe the whole setup in a sentence",
  },
  {
    manual: "Remember how applications, providers, and resources link",
    ai: "Links are resolved for you in the plan",
  },
  {
    manual: "Hand-write and simulate policy before activating",
    ai: "Policy is drafted, simulated, and staged",
  },
  {
    manual: "Re-check the audit log to confirm what changed",
    ai: "Every change is summarized and logged",
  },
];

function Comparison() {
  return (
    <section>
      <SectionHead className="mb-3">From clicks to intent</SectionHead>
      <div className="grid gap-px border border-border bg-border md:grid-cols-2 [&>*]:bg-card">
        <div className="flex flex-col">
          <div className="border-b border-border px-5 py-3 text-sm font-semibold text-muted-foreground">
            By hand today
          </div>
          <ul className="flex flex-col">
            {FLOW.map((row) => (
              <li
                key={row.manual}
                className="flex items-start gap-2.5 border-b border-border px-5 py-3 text-sm text-muted-foreground last:border-b-0"
              >
                <DotDash />
                <span className="min-w-0">{row.manual}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-semibold text-foreground">
            <OperatorMark className="h-4 w-4" />
            With Caracal Operator
          </div>
          <ul className="flex flex-col">
            {FLOW.map((row) => (
              <li
                key={row.ai}
                className="flex items-start gap-2.5 border-b border-border px-5 py-3 text-sm text-foreground last:border-b-0"
              >
                <Check />
                <span className="min-w-0">{row.ai}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- trust ------------------------------- */

const GUARANTEES = [
  "Acts only within your operator scope — never more than you could by hand",
  "Nothing is applied until you approve the plan",
  "Every change is attributed to you and written to the audit log",
  "The Community security model is unchanged — no new trust is introduced",
];

function Trust() {
  return (
    <section className="border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center border border-border bg-muted text-foreground">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
          </span>
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            Governed, not autonomous
          </h3>
        </div>
        <LockBadge />
      </div>
      <ul className="grid gap-x-6 gap-y-2.5 p-5 sm:grid-cols-2">
        {GUARANTEES.map((point) => (
          <li key={point} className="flex items-start gap-2.5 text-sm text-foreground">
            <Check />
            <span className="min-w-0">{point}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
        <a href={config.enterpriseUrl} target="_blank" rel="noreferrer">
          <Button>Upgrade to Enterprise</Button>
        </a>
        <Link
          to="/pricing"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Compare editions
        </Link>
        <span className="text-xs text-muted-foreground">
          Caracal Operator activates in this exact place — no migration.
        </span>
      </div>
    </section>
  );
}

/* ------------------------------ primitives ------------------------------ */

function SectionHead({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={`text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </h3>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-600 dark:text-emerald-400"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DotDash() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground/50"
      aria-hidden="true"
    >
      <path d="M6 12h12" />
    </svg>
  );
}
