/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the guided onboarding route.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DcrField } from "@/components/console/DcrField";
import { IdentityCard } from "@/components/onboarding/IdentityCard";
import { OnboardingLayout, type OnboardingStep } from "@/components/onboarding/OnboardingLayout";
import { ZoneExplainer } from "@/components/onboarding/ZoneExplainer";
import { AvatarPicker, Button, Card, Field, SectionTitle, useToast } from "@/components/ui";
import { ConsoleApiError, consoleApi } from "@/platform/api/client";
import { selectZone } from "@/platform/api/hooks";
import { useSession } from "@/platform/auth";
import { requirePendingOnboarding } from "@/platform/auth/guards";
import {
  completeOnboarding,
  getProfile,
  HANDLE_MAX,
  NAME_MAX,
  resolveDisplayName,
  sanitizeHandle,
  type ProfileRecord,
} from "@/platform/state/localInstall";

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
    title: "Set up your profile",
    description: "This personalizes your Caracal environment. You can change it later in Settings.",
  },
  {
    title: "Create your first zone",
    description:
      "A zone is Caracal's primary trust boundary. It isolates applications, resources, policies, and audit.",
  },
  {
    title: "Review and confirm",
    description: "Check the details below. You own this environment as its single user.",
  },
];

function OnboardingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const session = useSession();
  const ownerEmail = session.data?.user?.email ?? "";
  const sessionName = session.data?.user?.name ?? "";

  const [step, setStep] = useState(0);

  const [accountId] = useState(() => getProfile().accountId);
  const [fullName, setFullName] = useState(sessionName);
  const [displayName, setDisplayName] = useState("");
  const [avatar, setAvatar] = useState("");

  const [zoneName, setZoneName] = useState("");
  const [zoneDcr, setZoneDcr] = useState(false);

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

  async function finish() {
    if (!profileValid || !zoneValid) return;
    setSubmitting(true);
    const profile: ProfileRecord = {
      accountId,
      fullName: fullName.trim(),
      displayName: resolveDisplayName(fullName, displayName),
      avatar,
    };
    try {
      const zone = await consoleApi.zones.create({
        name: zoneName.trim(),
        dcr_enabled: zoneDcr,
      });
      selectZone(zone.id);
      completeOnboarding(profile);
      navigate({ to: "/app" });
    } catch (err) {
      if (
        err instanceof ConsoleApiError &&
        (err.notConfigured || err.unreachable || err.status === 0)
      ) {
        completeOnboarding(profile);
        toast({
          tone: "info",
          title: "Profile saved",
          description: "Connect the control plane to create your first zone.",
        });
        navigate({ to: "/app" });
        return;
      }
      setSubmitting(false);
      toast({
        tone: "error",
        title: "Could not create zone",
        description: err instanceof ConsoleApiError ? err.code : "Unexpected error.",
      });
    }
  }

  const head = STEP_HEAD[step];

  return (
    <OnboardingLayout
      steps={STEPS}
      current={step}
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
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:gap-12">
          <div className="order-2 flex min-w-0 flex-col gap-6 lg:order-1">
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
                onChange={(e) => setFullName(e.target.value.slice(0, NAME_MAX))}
                maxLength={NAME_MAX}
                error={showErrors && !profileValid ? "Full name is required." : undefined}
                autoFocus
              />
              <Field
                label="Display name"
                hint="Optional. Defaults to your first name. How you appear in the Console."
                placeholder="ada"
                value={displayName}
                onChange={(e) => setDisplayName(sanitizeHandle(e.target.value))}
                maxLength={HANDLE_MAX}
              />
              <Field label="Email" value={ownerEmail} readOnly disabled hint="From your account." />
              <Field
                label="Account ID"
                value={accountId}
                readOnly
                disabled
                hint="Generated and locked. Your internal identifier."
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The Community Edition links all zones directly to your account. There are no
              organizations or teams.
            </p>
          </div>

          <div className="order-1 lg:order-2">
            <div className="flex flex-col gap-3 lg:sticky lg:top-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Live preview
              </span>
              <IdentityCard
                accountId={accountId}
                fullName={fullName}
                displayName={displayName}
                email={ownerEmail}
                avatar={avatar}
              />
            </div>
          </div>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)] lg:gap-12">
          <div className="order-2 flex min-w-0 flex-col gap-5 lg:order-1">
            <Field
              label="Zone name"
              placeholder="e.g. Production"
              hint="A recognizable name for this environment, like Production, Staging, or Development."
              value={zoneName}
              onChange={(e) => setZoneName(e.target.value)}
              error={showErrors && !zoneValid ? "Zone name is required." : undefined}
              autoFocus
            />
            <DcrField enabled={zoneDcr} onChange={setZoneDcr} />
          </div>
          <div className="order-1 h-fit lg:order-2 lg:sticky lg:top-0">
            <ZoneExplainer />
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:items-start">
          <ReviewSection
            title="Profile"
            onEdit={() => setStep(0)}
            rows={[
              ["Full name", fullName.trim()],
              ["Display name", resolveDisplayName(fullName, displayName) || "-"],
              ["Email", ownerEmail || "-"],
              ["Account ID", accountId],
            ]}
            avatar={avatar}
            avatarName={fullName || displayName}
          />
          <ReviewSection
            title="First zone"
            onEdit={() => setStep(1)}
            rows={[
              ["Name", zoneName.trim()],
              ["Dynamic Client Registration", zoneDcr ? "Enabled" : "Off"],
            ]}
          />
          <Card className="lg:col-span-2">
            <SectionTitle>Ownership</SectionTitle>
            <p className="mt-3 text-sm text-foreground">
              You are the single owner of this environment.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              The Community Edition runs as a single user. All zones link directly to your account.
              There are no organizations, teams, roles, or invitations to manage.
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
              <dt className="shrink-0 text-muted-foreground">{label}</dt>
              <dd
                className="min-w-0 text-right font-medium text-foreground [overflow-wrap:anywhere]"
                title={value}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
