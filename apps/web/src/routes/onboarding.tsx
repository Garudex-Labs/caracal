/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the guided onboarding route.
*/
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { DcrField } from "@/components/console/DcrField";
import { EnterpriseCallout } from "@/components/onboarding/EnterpriseCallout";
import { IdentityCard } from "@/components/onboarding/IdentityCard";
import { OnboardingLayout, type OnboardingStep } from "@/components/onboarding/OnboardingLayout";
import { ZoneExplainer } from "@/components/onboarding/ZoneExplainer";
import { AvatarPicker, Button, Card, Field, SectionTitle, useToast } from "@/components/ui";
import { ConsoleApiError, consoleApi } from "@/platform/api/client";
import { selectZone } from "@/platform/api/hooks";
import { ZONE_NAME_MAX } from "@/platform/api/types";
import { signOut, updateUser, useSession } from "@/platform/auth";
import { requirePendingOnboarding } from "@/platform/auth/guards";
import {
  completeOnboarding,
  getOnboardingDraft,
  getProfile,
  HANDLE_MAX,
  NAME_MAX,
  resolveDisplayName,
  sanitizeHandle,
  setOnboardingDraft,
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

// Zone-name problems send the operator back to the zone step with a plain-language
// explanation; raw control-plane codes never reach the toast.
const ZONE_NAME_ERRORS: Record<string, string> = {
  reserved_namespace: "That name is reserved for Caracal's own systems. Choose a different name.",
  zone_slug_conflict: "A zone with a similar name already exists. Choose a different name.",
  invalid_zone: "Enter a valid zone name.",
};

function OnboardingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const session = useSession();
  const ownerEmail = session.data?.user?.email ?? "";
  const sessionName = session.data?.user?.name ?? "";

  const [draft] = useState(() => getOnboardingDraft());

  const [step, setStep] = useState(() => Math.min(Math.max(draft?.step ?? 0, 0), STEPS.length - 1));

  const [accountId] = useState(() => getProfile().accountId);
  const [fullName, setFullName] = useState(() => draft?.fullName ?? sessionName);
  const fullNameEdited = useRef(false);
  const [displayName, setDisplayName] = useState(() => draft?.displayName ?? "");
  const [avatar, setAvatar] = useState(() => draft?.avatar ?? "");

  const [zoneName, setZoneName] = useState(() => draft?.zoneName ?? "");
  const [zoneDcr, setZoneDcr] = useState(() => draft?.zoneDcr ?? false);

  const [submitting, setSubmitting] = useState(false);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (draft === null && !fullNameEdited.current && !fullName && sessionName) {
      setFullName(sessionName);
    }
  }, [draft, sessionName, fullName]);

  useEffect(() => {
    setOnboardingDraft({ step, fullName, displayName, avatar, zoneName, zoneDcr });
  }, [step, fullName, displayName, avatar, zoneName, zoneDcr]);

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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step < STEPS.length - 1) goNext();
    else void finish();
  }

  async function exitToSignIn() {
    await signOut();
    navigate({ to: "/sign-in" });
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
    // The authenticated user record carries the same name and avatar as the local
    // profile so the console and auth server agree on the operator's identity; a
    // failed sync never blocks onboarding since Settings can save the profile later.
    await updateUser({ name: profile.fullName, image: profile.avatar || undefined }).catch(
      () => undefined,
    );
    try {
      const zone = await consoleApi.zones.create({
        name: zoneName.trim(),
        dcr_enabled: zoneDcr,
      });
      selectZone(zone.id);
      completeOnboarding(profile);
      toast({
        tone: "success",
        title: "You're all set",
        description: `${zone.name} is ready to use.`,
      });
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
      const nameError = err instanceof ConsoleApiError ? ZONE_NAME_ERRORS[err.code] : undefined;
      if (nameError) setStep(1);
      toast({
        tone: "error",
        title: "Could not create zone",
        description: nameError ?? "Something went wrong on our side. Try again in a moment.",
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
      signedInAs={ownerEmail}
      onSignOut={() => void exitToSignIn()}
      onSubmit={onSubmit}
      footer={<FooterNav step={step} submitting={submitting} onBack={goBack} />}
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
                onChange={(e) => {
                  fullNameEdited.current = true;
                  setFullName(e.target.value.slice(0, NAME_MAX));
                }}
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
              onChange={(e) => setZoneName(e.target.value.slice(0, ZONE_NAME_MAX))}
              maxLength={ZONE_NAME_MAX}
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
            editDisabled={submitting}
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
            editDisabled={submitting}
            rows={[
              ["Name", zoneName.trim()],
              ["Dynamic Client Registration (DCR)", zoneDcr ? "Enabled" : "Off"],
            ]}
          />
          <div className="lg:col-span-2">
            <EnterpriseCallout />
          </div>
        </div>
      ) : null}
    </OnboardingLayout>
  );
}

function FooterNav({
  step,
  submitting,
  onBack,
}: {
  step: number;
  submitting: boolean;
  onBack: () => void;
}) {
  const isLast = step === STEPS.length - 1;
  return (
    <>
      {step > 0 ? (
        <Button type="button" variant="secondary" onClick={onBack} disabled={submitting}>
          Back
        </Button>
      ) : (
        <span />
      )}
      {isLast ? (
        <Button type="submit" loading={submitting}>
          {submitting ? "Finishing…" : "Finish setup"}
        </Button>
      ) : (
        <Button type="submit">Continue</Button>
      )}
    </>
  );
}

function ReviewSection({
  title,
  rows,
  onEdit,
  editDisabled,
  avatar,
  avatarName,
}: {
  title: string;
  rows: [string, string][];
  onEdit: () => void;
  editDisabled: boolean;
  avatar?: string;
  avatarName?: string;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <SectionTitle>{title}</SectionTitle>
        <Button type="button" variant="ghost" size="sm" onClick={onEdit} disabled={editDisabled}>
          Edit
        </Button>
      </div>
      <div className="mt-3 flex items-start gap-4">
        {avatar !== undefined ? (
          <div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-sm font-semibold text-muted-foreground">
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
                className="min-w-0 text-right font-medium wrap-anywhere text-foreground"
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
