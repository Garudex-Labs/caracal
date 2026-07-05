/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file builds the kind-aware create and edit form for upstream credential providers.
*/
import { useState } from "react";

import {
  Badge,
  Button,
  Disclosure,
  Field,
  Modal,
  PasswordField,
  Select,
  Textarea,
} from "@/components/ui";
import {
  crossFieldIssues,
  parseParams,
  reservedParamsFor,
  serializeParams,
  validateFieldFormat,
  validateIdentifier,
} from "@/components/console/providerValidation";
import type {
  Provider,
  ProviderInput,
  ProviderKind,
  ProviderTestResult,
} from "@/platform/api/types";

export const TEST_STATUS: Record<
  ProviderTestResult["status"],
  { label: string; tone: "success" | "danger" | "warning" }
> = {
  ok: { label: "Connection verified", tone: "success" },
  auth_failed: { label: "Authentication failed", tone: "danger" },
  unreachable: { label: "Endpoint unreachable", tone: "danger" },
  endpoint_error: { label: "Unexpected endpoint response", tone: "warning" },
  config_error: { label: "Configuration error", tone: "warning" },
};

const KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: "caracal_mandate", label: "Caracal mandate" },
  { value: "oauth2_authorization_code", label: "OAuth 2.0: authorization code" },
  { value: "oauth2_client_credentials", label: "OAuth 2.0: client credentials" },
  { value: "api_key", label: "API key" },
  { value: "bearer_token", label: "Bearer token" },
  { value: "none", label: "None" },
];

type FieldKind = "text" | "secret" | "secret-multiline" | "list" | "params" | "bool" | "select";

interface ProviderField {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  required?: boolean;
  advanced?: boolean;
  options?: string[];
  placeholder?: string;
  dependsOn?: Partial<Record<string, string>>;
}

const AUTH_CODE_METHODS = ["client_secret_basic", "client_secret_post", "none"];
const CC_METHODS = ["client_secret_basic", "client_secret_post", "private_key_jwt", "none"];

// Mirrors apps/api PUBLIC/SECRET provider config keys so the form never sends
// fields the control plane would reject.
const FIELDS: Record<ProviderKind, ProviderField[]> = {
  none: [],
  caracal_mandate: [],
  oauth2_authorization_code: [
    {
      key: "authorization_endpoint",
      label: "Authorization endpoint",
      kind: "text",
      required: true,
      placeholder: "https://login.hooli.example/oauth/authorize",
      hint: "HTTPS endpoint where users approve delegated access.",
    },
    {
      key: "token_endpoint",
      label: "Token endpoint",
      kind: "text",
      required: true,
      placeholder: "https://login.hooli.example/oauth/token",
      hint: "HTTPS endpoint where provider tokens are issued or refreshed.",
    },
    {
      key: "redirect_uri",
      label: "Redirect URI",
      kind: "text",
      required: true,
      placeholder:
        "https://caracal.piedpiper.example/v1/zones/<zone-id>/provider-grants/oauth/callback",
      hint: "Caracal's callback: <control-plane URL>/v1/zones/<zone-id>/provider-grants/oauth/callback. Register this exact URL with the provider.",
    },
    { key: "client_id", label: "Client ID", kind: "text", required: true },
    {
      key: "client_secret",
      label: "Client secret",
      kind: "secret",
      hint: "Required for client_secret_basic and client_secret_post.",
    },
    {
      key: "scopes",
      label: "Upstream OAuth scopes",
      kind: "list",
      hint: "Optional. Comma-separated scopes requested from the provider.",
    },
    {
      key: "client_auth_method",
      label: "Client authentication",
      kind: "select",
      options: AUTH_CODE_METHODS,
      advanced: true,
    },
    {
      key: "authorization_params",
      label: "Authorization parameters",
      kind: "params",
      advanced: true,
      hint: "Optional key=value pairs, e.g. access_type=offline, prompt=consent.",
    },
    {
      key: "token_params",
      label: "Token parameters",
      kind: "params",
      advanced: true,
      hint: "Optional key=value token endpoint parameters.",
    },
    {
      key: "allowed_token_hosts",
      label: "Token endpoint hosts",
      kind: "list",
      advanced: true,
      hint: "Optional. Uses the token endpoint host when blank.",
    },
    {
      key: "auth_header",
      label: "Upstream authorization header",
      kind: "text",
      advanced: true,
      hint: "Optional. Leave blank for Authorization.",
    },
    {
      key: "auth_scheme",
      label: "Upstream authorization scheme",
      kind: "text",
      advanced: true,
      hint: "Optional prefix such as Bearer or Token.",
    },
    {
      key: "forward_caracal_identity",
      label: "Forward Caracal identity",
      kind: "bool",
      advanced: true,
      hint: "Also send X-Caracal-Identity to trusted upstreams.",
    },
    {
      key: "allow_runtime_injection",
      label: "Allow runtime injection",
      kind: "bool",
      advanced: true,
      hint: "Allow caracal run to inject this credential into a child process.",
    },
  ],
  oauth2_client_credentials: [
    {
      key: "token_endpoint",
      label: "Token endpoint",
      kind: "text",
      required: true,
      placeholder: "https://login.hooli.example/oauth/token",
      hint: "HTTPS endpoint where provider tokens are issued or refreshed.",
    },
    { key: "client_id", label: "Client ID", kind: "text", required: true },
    {
      key: "client_secret",
      label: "Client secret",
      kind: "secret",
      hint: "Required unless using private_key_jwt or none.",
    },
    {
      key: "scopes",
      label: "Upstream OAuth scopes",
      kind: "list",
      hint: "Optional. Comma-separated scopes requested from the provider.",
    },
    {
      key: "client_auth_method",
      label: "Client authentication",
      kind: "select",
      options: CC_METHODS,
      advanced: true,
    },
    {
      key: "audience",
      label: "Token audience",
      kind: "text",
      advanced: true,
      hint: "Optional audience parameter for token endpoints that require one.",
    },
    {
      key: "resource",
      label: "Resource indicator",
      kind: "text",
      advanced: true,
      hint: "Optional RFC 8707 / Azure-style resource value.",
    },
    {
      key: "key_id",
      label: "Key ID",
      kind: "text",
      advanced: true,
      dependsOn: { client_auth_method: "private_key_jwt" },
      hint: "Optional kid header for private_key_jwt assertions.",
    },
    {
      key: "private_key",
      label: "Private key (PEM)",
      kind: "secret-multiline",
      advanced: true,
      dependsOn: { client_auth_method: "private_key_jwt" },
      hint: "PEM private key used to sign private_key_jwt client assertions.",
    },
    {
      key: "token_params",
      label: "Token parameters",
      kind: "params",
      advanced: true,
      hint: "Optional key=value token endpoint parameters.",
    },
    {
      key: "allowed_token_hosts",
      label: "Token endpoint hosts",
      kind: "list",
      advanced: true,
      hint: "Optional. Uses the token endpoint host when blank.",
    },
    {
      key: "auth_header",
      label: "Upstream authorization header",
      kind: "text",
      advanced: true,
      hint: "Optional. Leave blank for Authorization.",
    },
    {
      key: "auth_scheme",
      label: "Upstream authorization scheme",
      kind: "text",
      advanced: true,
      hint: "Optional prefix such as Bearer or Token.",
    },
    {
      key: "forward_caracal_identity",
      label: "Forward Caracal identity",
      kind: "bool",
      advanced: true,
    },
    {
      key: "allow_runtime_injection",
      label: "Allow runtime injection",
      kind: "bool",
      advanced: true,
    },
  ],
  api_key: [
    {
      key: "auth_location",
      label: "Key location",
      kind: "select",
      options: ["header", "query"],
      hint: "Where the upstream expects the key.",
    },
    {
      key: "header_name",
      label: "Header name",
      kind: "text",
      required: true,
      dependsOn: { auth_location: "header" },
      placeholder: "X-API-Key",
      hint: "Header where the upstream expects the key.",
    },
    {
      key: "query_param_name",
      label: "Query parameter",
      kind: "text",
      required: true,
      dependsOn: { auth_location: "query" },
      placeholder: "api_key",
      hint: "Query parameter where the upstream expects the key.",
    },
    { key: "api_key", label: "API key", kind: "secret", required: true },
    {
      key: "auth_scheme",
      label: "Authorization scheme",
      kind: "text",
      advanced: true,
      dependsOn: { auth_location: "header" },
      hint: "Optional prefix such as ApiKey or Token.",
    },
    {
      key: "forward_caracal_identity",
      label: "Forward Caracal identity",
      kind: "bool",
      advanced: true,
    },
    {
      key: "allow_runtime_injection",
      label: "Allow runtime injection",
      kind: "bool",
      advanced: true,
    },
  ],
  bearer_token: [
    { key: "bearer_token", label: "Bearer token", kind: "secret", required: true },
    {
      key: "allowed_token_hosts",
      label: "Allowed upstream hosts",
      kind: "list",
      hint: "Host allow-list for static bearer-token forwarding.",
    },
    {
      key: "auth_header",
      label: "Upstream authorization header",
      kind: "text",
      advanced: true,
      hint: "Optional. Leave blank for Authorization.",
    },
    {
      key: "auth_scheme",
      label: "Authorization scheme",
      kind: "text",
      advanced: true,
      hint: "Optional prefix such as Bearer.",
    },
    {
      key: "forward_caracal_identity",
      label: "Forward Caracal identity",
      kind: "bool",
      advanced: true,
    },
    {
      key: "allow_runtime_injection",
      label: "Allow runtime injection",
      kind: "bool",
      advanced: true,
    },
  ],
};

const SECRET_KEYS = new Set(["client_secret", "private_key", "api_key", "bearer_token"]);

type Values = Record<string, string>;

const PARAM_KEYS = new Set(["authorization_params", "token_params"]);

function initialValues(provider?: Provider): Values {
  const values: Values = {};
  if (!provider) return values;
  const config = provider.config_json ?? {};
  for (const [key, raw] of Object.entries(config)) {
    if (PARAM_KEYS.has(key) && raw != null && typeof raw === "object" && !Array.isArray(raw)) {
      values[key] = serializeParams(raw as Record<string, string>);
    } else if (Array.isArray(raw)) values[key] = raw.join(", ");
    else if (typeof raw === "boolean") values[key] = String(raw);
    else if (raw != null && typeof raw === "object") values[key] = JSON.stringify(raw);
    else if (raw != null) values[key] = String(raw);
  }
  return values;
}

function buildConfig(kind: ProviderKind, values: Values, isEdit: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const field of FIELDS[kind]) {
    if (!fieldVisible(field, values)) continue;
    const raw = (values[field.key] ?? "").trim();
    if (field.kind === "bool") {
      if (raw === "true") config[field.key] = true;
      continue;
    }
    if (raw === "") continue;
    if (SECRET_KEYS.has(field.key) && isEdit && raw === KEEP_SECRET) continue;
    if (field.kind === "params") {
      const parsed = parseParams(raw, reservedParamsFor(field.key));
      if (Object.keys(parsed.value).length > 0) config[field.key] = parsed.value;
    } else if (field.kind === "list") {
      config[field.key] = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      config[field.key] = raw;
    }
  }
  return config;
}

const KEEP_SECRET = "";

function fieldVisible(field: ProviderField, values: Values): boolean {
  if (!field.dependsOn) return true;
  return Object.entries(field.dependsOn).every(([key, expected]) => {
    const current = values[key] ?? defaultFor(key);
    return current === expected;
  });
}

function defaultFor(key: string): string {
  if (key === "auth_location") return "header";
  if (key === "client_auth_method") return "client_secret_basic";
  return "";
}

export function ProviderFormModal({
  open,
  mode,
  provider,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  provider?: Provider;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: ProviderInput) => Promise<ProviderTestResult | undefined>;
}) {
  const isEdit = mode === "edit";
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [kind, setKind] = useState<ProviderKind>("caracal_mandate");
  const [values, setValues] = useState<Values>({});
  const [touched, setTouched] = useState(false);
  const [checkFailed, setCheckFailed] = useState<ProviderTestResult | null>(null);
  const [action, setAction] = useState<"connect" | "skip">("connect");

  // Seed (or fully reset) the form each time the modal opens. Resetting the seed ref on
  // close is essential: for "create" the seed key is constant, so without this the previous
  // entry - including secret fields - would persist into the next New. Clearing on close
  // guarantees every reopen starts from a clean slate.
  const seedKey = `${provider?.id ?? "new"}:${mode}`;
  const [seedRef, setSeedRef] = useState<string | null>(null);
  if (open && seedKey !== seedRef) {
    setSeedRef(seedKey);
    setName(provider?.name ?? "");
    setIdentifier(provider?.identifier ?? "");
    setKind(provider?.kind ?? "caracal_mandate");
    setValues(initialValues(provider));
    setTouched(false);
    setCheckFailed(null);
  } else if (!open && seedRef !== null) {
    setSeedRef(null);
  }

  const fields = FIELDS[kind];
  const visibleFields = fields.filter((f) => fieldVisible(f, values));
  const basicFields = visibleFields.filter((f) => !f.advanced);
  const advancedFields = visibleFields.filter((f) => f.advanced);

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setCheckFailed(null);
  }

  function missingRequired(): string | null {
    if (!isEdit && !name.trim()) return "Provider name is required.";
    const kindUnchanged = isEdit && kind === provider?.kind;
    const secretStored = (key: string) =>
      kindUnchanged && Boolean(provider?.secret_config_keys.includes(key as never));
    for (const field of basicFields) {
      if (!field.required) continue;
      const raw = (values[field.key] ?? "").trim();
      if (SECRET_KEYS.has(field.key) && secretStored(field.key)) continue;
      if (raw === "") return `${field.label} is required.`;
    }
    // OAuth client authentication makes a credential conditionally mandatory, exactly as the
    // control plane enforces: a client secret for the secret-based methods, or a private key
    // for private_key_jwt. 'none' needs neither.
    if (kind === "oauth2_authorization_code" || kind === "oauth2_client_credentials") {
      const method = (values.client_auth_method || "client_secret_basic").trim();
      if (method === "private_key_jwt") {
        if ((values.private_key ?? "").trim() === "" && !secretStored("private_key")) {
          return "A private key is required for private_key_jwt.";
        }
      } else if (method !== "none") {
        if ((values.client_secret ?? "").trim() === "" && !secretStored("client_secret")) {
          return "Client secret is required for this authentication method.";
        }
      }
    }
    return null;
  }

  // Field-level format and cross-field credential errors at control-plane parity, so invalid
  // input is caught and pinpointed in the form before any round-trip.
  function fieldErrors(): Record<string, string> {
    const errors: Record<string, string> = {};
    const identifierError = validateIdentifier(identifier);
    if (identifierError) errors.identifier = identifierError;
    for (const field of visibleFields) {
      if (field.kind === "bool" || field.kind === "select") continue;
      const message = validateFieldFormat(field.key, values[field.key] ?? "");
      if (message) errors[field.key] = message;
    }
    for (const issue of crossFieldIssues(kind, values)) {
      if (issue.key && !errors[issue.key]) errors[issue.key] = issue.message;
    }
    return errors;
  }

  async function submit(check: boolean) {
    setAction(check ? "connect" : "skip");
    setTouched(true);
    if (missingRequired()) return;
    if (Object.keys(fieldErrors()).length > 0) return;
    const config = buildConfig(kind, values, isEdit);
    const input: ProviderInput = {
      kind,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
      ...(kind === "none" || kind === "caracal_mandate" ? {} : { config_json: config }),
      ...(check ? { check: true } : {}),
    };
    setCheckFailed(null);
    const failed = await onSubmit(input);
    if (failed) setCheckFailed(failed);
  }

  const errors = touched ? fieldErrors() : {};
  const error = touched ? missingRequired() : null;
  const hasFieldError = Object.keys(errors).length > 0;
  const hasAdvancedError = advancedFields.some((f) => errors[f.key]);
  // Only OAuth kinds own a token endpoint Caracal can genuinely verify before creation.
  // Every other kind gets the plain create flow: presenting a check that cannot fail
  // would be a fake validation experience.
  const canConnect = kind === "oauth2_authorization_code" || kind === "oauth2_client_credentials";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit provider" : "New provider"}
      description={
        isEdit
          ? "Update routing and credentials. Leave secrets blank to keep the stored value."
          : "Configure an upstream credential source for this zone."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {isEdit ? (
            <Button onClick={() => void submit(false)} loading={busy}>
              Save changes
            </Button>
          ) : canConnect ? (
            <>
              <Button
                onClick={() => void submit(true)}
                loading={busy && action === "connect"}
                disabled={busy}
              >
                Connect
              </Button>
              <button
                type="button"
                className="basis-full text-right text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
                onClick={() => void submit(false)}
                disabled={busy}
              >
                Skip for now
              </button>
            </>
          ) : (
            <Button onClick={() => void submit(false)} loading={busy}>
              Create provider
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            info="Human-readable name for this credential source, shown across the console. Use a short operational name."
            placeholder="Hooli OIDC"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!isEdit}
          />
          <Select
            label="Type"
            info="The credential mechanism this provider uses to obtain upstream access. Selecting a type determines the rest of the configuration fields."
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ProviderKind);
              setCheckFailed(null);
            }}
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {basicFields.map((field) => (
          <ProviderFieldInput
            key={field.key}
            field={field}
            value={values[field.key] ?? ""}
            stored={Boolean(provider?.secret_config_keys.includes(field.key as never))}
            isEdit={isEdit}
            error={errors[field.key]}
            onChange={(v) => setValue(field.key, v)}
          />
        ))}

        <Disclosure
          title="Advanced options"
          description="Identifier, auth scheme, and other rarely-changed settings."
          count={advancedFields.length}
          hasError={hasAdvancedError || Boolean(errors.identifier)}
        >
          {advancedFields.map((field) => (
            <ProviderFieldInput
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              stored={Boolean(provider?.secret_config_keys.includes(field.key as never))}
              isEdit={isEdit}
              error={errors[field.key]}
              onChange={(v) => setValue(field.key, v)}
            />
          ))}
          <Field
            label="Identifier"
            info="The stable identifier used to reference this provider in resources and tokens. Generated from the name when blank; must use the provider:// namespace."
            placeholder="provider://hooli-oidc"
            hint="Optional. Generated from the name when blank. Must match provider://lowercase-slug."
            value={identifier}
            error={errors.identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </Disclosure>

        {checkFailed ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Badge tone={TEST_STATUS[checkFailed.status].tone}>
                {TEST_STATUS[checkFailed.status].label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(checkFailed.checked_at).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-xs text-foreground">{checkFailed.detail}</p>
            <p className="text-xs text-muted-foreground">
              The provider was not created. Fix the configuration and connect again, or use
              &quot;Skip for now&quot; to create it with a Failed badge until a check passes.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : hasFieldError ? (
          <p className="text-sm text-destructive">Fix the highlighted fields before continuing.</p>
        ) : null}
      </div>
    </Modal>
  );
}

function ProviderFieldInput({
  field,
  value,
  stored,
  isEdit,
  error,
  onChange,
}: {
  field: ProviderField;
  value: string;
  stored: boolean;
  isEdit: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const isSecret = field.kind === "secret" || field.kind === "secret-multiline";
  const hint =
    isSecret && isEdit && stored ? "Stored. Leave blank to keep the current value." : field.hint;
  const note = error ? (
    <span className="mt-1 block text-xs text-destructive">{error}</span>
  ) : hint ? (
    <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
  ) : null;

  if (field.kind === "bool") {
    return (
      <label className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="text-sm font-medium text-foreground">{field.label}</span>
          {field.hint ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{field.hint}</span>
          ) : null}
        </span>
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          className="h-4 w-4 flex-shrink-0 accent-primary"
        />
      </label>
    );
  }

  if (field.kind === "select") {
    return (
      <Select
        label={field.label}
        info={field.hint}
        value={value || field.options?.[0]}
        onChange={(e) => onChange(e.target.value)}
      >
        {field.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }

  if (field.kind === "secret-multiline") {
    return (
      <div>
        <Textarea
          label={field.label}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {note}
      </div>
    );
  }

  if (field.kind === "secret") {
    return (
      <div>
        <PasswordField
          label={field.label}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {note}
      </div>
    );
  }

  return (
    <Field
      label={field.label}
      hint={hint}
      error={error}
      placeholder={field.placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
