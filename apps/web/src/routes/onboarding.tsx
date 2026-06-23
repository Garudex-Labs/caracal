/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the guided onboarding route.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AvatarPicker } from "@/components/onboarding/AvatarPicker";
import { OnboardingLayout, type OnboardingStep } from "@/components/onboarding/OnboardingLayout";
import { Button, Card, Field, SectionTitle, Textarea } from "@/components/ui";
import { useSession } from "@/platform/auth";
import { requirePendingOnboarding } from "@/platform/auth/guards";
import { addZone, completeOnboarding, type ProfileRecord } from "@/platform/state/localInstall";

export const Route = createFileRoute("/onboarding")({
  beforeLoad: requirePendingOnboarding,
  component: OnboardingPage,
});

const STEPS: OnboardingStep[] = [
  { title: "Profile", summary: "Tell us who you are" },
  { title: "Zone", summary: "Create your first zone" },
  { title: "Review", summary: "Confirm and finish" },
];

const STEP_HEAD = [
  {
    eyebrow: "Step 1",
    title: "Set up your profile",
    description: "This personalizes your Caracal environment. You can change it later in Settings.",
  },
  {
    eyebrow: "Step 2",
    title: "Create your first zone",
    description:
      "A zone is Caracal's primary trust boundary. It isolates applications, resources, policies, and audit.",
  },
  {
    eyebrow: "Step 3",
    title: "Review and confirm",
    description: "Check the details below. You own this environment as its single user.",
  },
];

function OnboardingPage() {
  const navigate = useNavigate();
  const session = useSession();
  const ownerEmail = session.data?.user?.email ?? "";
  const sessionName = session.data?.user?.name ?? "";

  const [step, setStep] = useState(0);

  const [fullName, setFullName] = useState(sessionName);
  const [displayName, setDisplayName] = useState("");
  const [organization, setOrganization] = useState("");
  const [avatar, setAvatar] = useState("");

  const [zoneName, setZoneName] = useState("Production");
  const [zoneDesc, setZoneDesc] = useState("Live workloads and production agents.");

  const [submitting, setSubmitting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!fullName && sessionName) setFullName(sessionName);
  }, [sessionName, fullName]);

  const profileValid = fullName.trim().length > 0;
  const zoneValid = zoneName.trim().length > 0;

  function goNext() {
    if (step === 0 && !profileValid) {
      setShowErrors(true);
      return;
    }
    if (step === 1 && !zoneValid) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  }

  function goBack() {
    setShowErrors(false);
    setStep((value) => Math.max(value - 1, 0));
  }

  function finish() {
    if (!profileValid || !zoneValid) return;
    setSubmitting(true);
    const profile: ProfileRecord = {
      fullName: fullName.trim(),
      displayName: displayName.trim(),
      organization: organization.trim(),
      avatar,
    };
    addZone({ name: zoneName.trim(), description: zoneDesc.trim() });
    completeOnboarding(profile);
    navigate({ to: "/app" });
  }

  const head = STEP_HEAD[step];

  return (
    <OnboardingLayout
      steps={STEPS}
      current={step}
      eyebrow={head.eyebrow}
      title={head.title}
      description={head.description}
      footer={
        <FooterNav
          step={step}
          submitting={submitting}
          onBack={goBack}
          onNext={goNext}
          onFinish={finish}
        />
      }
    >
      {step === 0 ? (
        <div className="flex flex-col gap-6">
          <AvatarPicker
            value={avatar}
            fallbackName={fullName || displayName}
            onChange={setAvatar}
          />
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <Field
              label="Full name"
              placeholder="Ada Lovelace"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              error={showErrors && !profileValid ? "Full name is required." : undefined}
              autoFocus
            />
            <Field
              label="Display name"
              hint="Optional. How you appear in the Console."
              placeholder="ada"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Field
              label="Organization"
              hint="Optional. Your company or team name."
              placeholder="Acme"
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
            />
            <Field label="Email" value={ownerEmail} readOnly disabled hint="From your account." />
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
          <div className="flex flex-col gap-5">
            <Field
              label="Zone name"
              placeholder="Production"
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              error={showErrors && !zoneValid ? "Zone name is required." : undefined}
              autoFocus
            />
            <Textarea
              label="Description"
              hint="Optional. What this zone is for."
              placeholder="Live workloads and production agents."
              value={zoneDesc}
              onChange={(e) => setZoneDesc(e.target.value)}
            />
          </div>
          <Card className="h-fit bg-muted/30">
            <SectionTitle>What is a zone</SectionTitle>
            <ul className="mt-3 flex flex-col gap-2.5 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>An isolated trust boundary for one environment.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>Holds its own applications, resources, and policies.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground" />
                <span>You can add more zones at any time.</span>
              </li>
            </ul>
          </Card>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <ReviewSection
            title="Profile"
            onEdit={() => setStep(0)}
            rows={[
              ["Full name", fullName.trim()],
              ["Display name", displayName.trim() || "—"],
              ["Organization", organization.trim() || "—"],
              ["Email", ownerEmail || "—"],
            ]}
            avatar={avatar}
            avatarName={fullName || displayName}
          />
          <ReviewSection
            title="First zone"
            onEdit={() => setStep(1)}
            rows={[
              ["Name", zoneName.trim()],
              ["Description", zoneDesc.trim() || "—"],
            ]}
          />
          <Card>
            <SectionTitle>Ownership</SectionTitle>
            <p className="mt-3 text-sm text-foreground">
              You are the single owner of this environment.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              The Community Edition runs as a single user. There are no teams, roles, or invitations
              to manage.
            </p>
          </Card>
        </div>
      ) : null}
    </OnboardingLayout>
  );
}

function FooterNav({
  step,
  submitting,
  onBack,
  onNext,
  onFinish,
}: {
  step: number;
  submitting: boolean;
  onBack: () => void;
  onNext: () => void;
  onFinish: () => void;
}) {
  const isLast = step === STEPS.length - 1;
  return (
    <>
      {step > 0 ? (
        <Button variant="secondary" onClick={onBack} disabled={submitting}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {isLast ? (
        <Button onClick={onFinish} loading={submitting}>
          {submitting ? "Finishing…" : "Finish setup"}
        </Button>
      ) : (
        <Button onClick={onNext}>Continue</Button>
      )}
    </>
  );
}

function ReviewSection({
  title,
  rows,
  onEdit,
  avatar,
  avatarName,
}: {
  title: string;
  rows: [string, string][];
  onEdit: () => void;
  avatar?: string;
  avatarName?: string;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
      </div>
      <div className="mt-3 flex items-start gap-4">
        {avatar !== undefined ? (
          <div className="grid h-12 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-sm font-semibold text-muted-foreground">
            {avatar ? (
              <img src={avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              (avatarName ?? "").trim().slice(0, 1).toUpperCase() || "U"
            )}
          </div>
        ) : null}
        <dl className="min-w-0 flex-1 divide-y divide-border">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 py-2 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="truncate font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
