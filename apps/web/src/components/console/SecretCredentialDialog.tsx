// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared secure prompt that collects provider credentials for a plan step into the sealed vault.

import { useEffect, useState } from "react";

import { Button, Modal } from "@/components/ui";
import { KeyGlyph } from "@/components/console/OperatorGlyphs";

// What the prompt shows for each credential field: the human label, the paste hint per provider
// convention, and whether the value is a multi-line block (a PEM key) rather than a single token.
const FIELD_META: Record<string, { label: string; hint: string; multiline?: boolean }> = {
  client_id: {
    label: "Client ID",
    hint: "The OAuth client identifier from the provider's app registration.",
  },
  client_secret: {
    label: "Client secret",
    hint: "The confidential client secret issued alongside the client ID.",
  },
  api_key: {
    label: "API key",
    hint: "The key the provider issued for this integration.",
  },
  bearer_token: {
    label: "Bearer token",
    hint: "The static token the Gateway will present to the upstream.",
  },
  private_key: {
    label: "Private key",
    hint: "The PEM private key used to sign the client assertion (private_key_jwt).",
    multiline: true,
  },
};

function fieldMeta(field: string) {
  return (
    FIELD_META[field] ?? {
      label: field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      hint: "The credential value the provider issued for this field.",
    }
  );
}

const KIND_LABELS: Record<string, string> = {
  oauth2_authorization_code: "OAuth 2.0 authorization code",
  oauth2_client_credentials: "OAuth 2.0 client credentials",
  api_key: "API key",
  bearer_token: "Bearer token",
};

function RevealIcon({ shown }: { shown: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
      {shown ? null : <path d="M4 4l16 16" />}
    </svg>
  );
}

// The secure credential prompt for one plan step. Values are held only in this dialog's local
// state, cleared on close and submit, and sent once to the sealed vault - they never touch the
// chat, the plan, or the model. Fields are exactly those the selected provider kind requires
// (e.g. a Hooli OIDC client presents a client ID and secret; an API-key provider a single key).
export function SecretCredentialDialog({
  open,
  providerName,
  kind,
  fields,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  providerName: string;
  kind: string;
  fields: string[];
  pending: boolean;
  error: string | null;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const fieldKey = fields.join(",");
  useEffect(() => {
    setValues({});
    setRevealed({});
  }, [open, fieldKey]);

  const complete = fields.every((field) => (values[field] ?? "").trim().length > 0);
  const submit = () => {
    if (!complete || pending) return;
    const trimmed: Record<string, string> = {};
    for (const field of fields) trimmed[field] = (values[field] ?? "").trim();
    setValues({});
    onSubmit(trimmed);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Credentials for ${providerName}`}
      description={`This ${KIND_LABELS[kind] ?? kind} provider needs the values below. They are sealed into a short-lived vault, applied once when the plan runs, and never enter the chat, the plan, or the model. Unused values expire after 30 minutes.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!complete || pending}>
            {pending ? "Sealing…" : "Save credentials"}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
        <KeyGlyph className="h-3.5 w-3.5 flex-shrink-0" />
        Paste each value exactly as the provider issued it.
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {fields.map((field) => {
          const meta = fieldMeta(field);
          const shown = revealed[field] === true;
          return (
            <label key={field} className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-foreground">{meta.label}</span>
              {meta.multiline ? (
                <textarea
                  value={values[field] ?? ""}
                  onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                  rows={5}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                />
              ) : (
                <span className="relative flex items-center">
                  <input
                    type={shown ? "text" : "password"}
                    value={values[field] ?? ""}
                    onChange={(e) => setValues((prev) => ({ ...prev, [field]: e.target.value }))}
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-9 font-mono text-xs text-foreground outline-none focus:border-ring"
                  />
                  <button
                    type="button"
                    aria-label={shown ? "Hide value" : "Show value"}
                    onClick={() => setRevealed((prev) => ({ ...prev, [field]: !shown }))}
                    className="absolute right-2 text-muted-foreground hover:text-foreground"
                  >
                    <RevealIcon shown={shown} />
                  </button>
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">{meta.hint}</span>
            </label>
          );
        })}
        {error ? (
          <p className="text-[11px] text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
