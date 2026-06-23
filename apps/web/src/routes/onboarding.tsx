/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the guided onboarding route.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { OnboardingLayout } from "@/components/onboarding/OnboardingLayout";
import { Button, Field } from "@/components/ui";
import { useSession } from "@/platform/auth";
import { requirePendingOnboarding } from "@/platform/auth/guards";
import { content } from "@/platform/content/resolver";
import { addZone, completeOnboarding, seedSampleData } from "@/platform/state/localInstall";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: requirePendingOnboarding,
  component: OnboardingPage,
});

const TEMPLATES = [
  { id: "blank", label: "Blank zone", desc: "Start empty and configure everything yourself." },
  {
    id: "gateway",
    label: "API gateway starter",
    desc: "A resource and policy set for upstream routing.",
  },
  {
    id: "agents",
    label: "Multi-agent starter",
    desc: "Applications and delegation for agent workflows.",
  },
];

function OnboardingPage() {
  const navigate = useNavigate();
  const labels = content.onboarding.steps;
  const steps = [labels.installation, labels.zone, labels.admin, labels.samples, labels.review];
  const session = useSession();
  const operatorEmail = session.data?.user?.email ?? "your account";

  const [step, setStep] = useState(0);
  const [installName, setInstallName] = useState("");
  const [zoneName, setZoneName] = useState("Production");
  const [zoneDesc, setZoneDesc] = useState("Live workloads and production agents.");
  const [withSamples, setWithSamples] = useState(true);
  const [template, setTemplate] = useState("blank");

  function next() {
    setStep((value) => Math.min(value + 1, steps.length - 1));
  }
  function back() {
    setStep((value) => Math.max(value - 1, 0));
  }

  function finish() {
    addZone({ name: zoneName, description: zoneDesc });
    if (withSamples) seedSampleData();
    completeOnboarding(installName || "Caracal");
    navigate({ to: "/app" });
  }

  return (
    <OnboardingLayout steps={steps} current={step}>
      {step === 0 ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Name this installation. It appears across the Console and audit trail.
          </p>
          <Field
            label="Installation name"
            placeholder="Acme Platform"
            value={installName}
            onChange={(e) => setInstallName(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={next} disabled={!installName.trim()}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Create your first zone. A zone is Caracal's primary trust boundary.
          </p>
          <Field label="Zone name" value={zoneName} onChange={(e) => setZoneName(e.target.value)} />
          <Field
            label="Zone description"
            value={zoneDesc}
            onChange={(e) => setZoneDesc(e.target.value)}
          />
          <div className="flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next} disabled={!zoneName.trim()}>
              Continue
            </Button>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            The first operator becomes the installation administrator.
          </p>
          <div className="rounded-md border border-border bg-background px-4 py-3 text-sm">
            <div className="font-medium text-foreground">Administrator</div>
            <div className="mt-1 font-mono text-muted-foreground">{operatorEmail}</div>
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>Continue</Button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Optionally seed sample data and pick a quick-start template.
          </p>
          <label className="flex items-center gap-3 rounded-md border border-border bg-background px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={withSamples}
              onChange={(e) => setWithSamples(e.target.checked)}
            />
            <span className="text-foreground">Add sample zones and example objects</span>
          </label>
          <div className="flex flex-col gap-2">
            {TEMPLATES.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background px-4 py-3 text-sm"
              >
                <input
                  type="radio"
                  name="template"
                  checked={template === option.id}
                  onChange={() => setTemplate(option.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium text-foreground">{option.label}</span>
                  <span className="block text-muted-foreground">{option.desc}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={next}>Continue</Button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted-foreground">Review and finish setup.</p>
          <dl className="divide-y divide-border rounded-md border border-border">
            {[
              ["Installation", installName || "Caracal"],
              ["First zone", zoneName],
              ["Administrator", operatorEmail],
              ["Sample data", withSamples ? "Enabled" : "Skipped"],
              [
                "Template",
                TEMPLATES.find((option) => option.id === template)?.label ?? "Blank zone",
              ],
            ].map(([key, value]) => (
              <div key={key} className="flex justify-between px-4 py-2.5 text-sm">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="font-medium text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex justify-between">
            <Button variant="secondary" onClick={back}>
              Back
            </Button>
            <Button onClick={finish}>Finish setup</Button>
          </div>
        </div>
      ) : null}
    </OnboardingLayout>
  );
}
