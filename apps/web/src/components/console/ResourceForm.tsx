/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file builds the create and edit dialog for Gateway-routed resources, covering routing, caller allowlist, scopes, and operation authority.
*/
import { useMemo, useState } from "react";

import { Button, Disclosure, Field, InfoHint, Modal, Select } from "@/components/ui";
import {
  RESOURCE_IDENTIFIER_PREFIX,
  stripResourceIdentifierPrefix,
  validateResourceIdentifier,
} from "@/platform/api/validation";
import { PROVIDER_KIND_LABEL } from "@/platform/api/types";
import type {
  Application,
  Provider,
  Resource,
  ResourceInput,
  ResourceOperationEnforcement,
} from "@/platform/api/types";

// Common methods offered as type-ahead suggestions. The Gateway authorizes any non-empty
// method token (the control plane uppercases it), so the editor accepts free-form verbs
// such as WebDAV or custom methods rather than restricting to this list.
const METHOD_SUGGESTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const opFieldClass =
  "h-9 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/25";

interface OperationRow {
  method: string;
  path: string;
  scope: string;
}

type FieldErrors = Partial<
  Record<
    "name" | "scopes" | "upstreamUrl" | "credentialProvider" | "identifier" | "operations",
    string
  >
>;

// Mirrors the control plane's identifier generation so the dialog can preview the exact
// audience URI a name produces before the resource exists.
function slugOf(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface ResourceFormProps {
  open: boolean;
  mode: "create" | "edit";
  resource?: Resource;
  applications: Application[];
  providers: Provider[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: ResourceInput) => void;
}

// The form body only mounts while the dialog is open and remounts per target, so every
// open starts from a clean seed without any cross-open state bookkeeping.
export function ResourceFormModal(props: ResourceFormProps) {
  if (!props.open) return null;
  return <ResourceFormBody key={`${props.resource?.id ?? "new"}:${props.mode}`} {...props} />;
}

function ResourceFormBody({
  mode,
  resource,
  applications,
  providers,
  busy,
  onClose,
  onSubmit,
}: ResourceFormProps) {
  const isEdit = mode === "edit";

  const managedApps = useMemo(
    () => applications.filter((app) => app.registration_method === "managed"),
    [applications],
  );

  const [name, setName] = useState(resource?.name ?? "");
  const [identifier, setIdentifier] = useState(
    stripResourceIdentifierPrefix(resource?.identifier ?? ""),
  );
  const [upstreamUrl, setUpstreamUrl] = useState(resource?.upstream_url ?? "");
  // Operation rows carry their own scopes, so under operation enforcement the text
  // field seeds with only the extras that no operation references.
  const [scopesText, setScopesText] = useState(() => {
    const declared = resource?.scopes ?? [];
    if ((resource?.operation_enforcement ?? "enforced") !== "enforced") {
      return declared.join(", ");
    }
    const referenced = new Set((resource?.operations ?? []).map((op) => op.scope));
    return declared.filter((scope) => !referenced.has(scope)).join(", ");
  });
  // An empty allowlist leaves minting policy-governed, so nothing is preselected; capping
  // callers stays a deliberate operator decision.
  const [allowedApps, setAllowedApps] = useState<string[]>(resource?.allowed_application_ids ?? []);
  // When the zone has exactly one candidate the choice is unambiguous, so the dialog
  // preselects it; anything less certain stays a deliberate operator decision.
  const [credentialProvider, setCredentialProvider] = useState(
    resource?.credential_provider_id ?? (providers.length === 1 ? providers[0].id : ""),
  );
  const [enforcement, setEnforcement] = useState<ResourceOperationEnforcement>(
    resource?.operation_enforcement ?? "enforced",
  );
  const [operations, setOperations] = useState<OperationRow[]>(
    (resource?.operations ?? []).map((op) => ({ ...op })),
  );
  const [touched, setTouched] = useState(false);

  const declaredScopes = useMemo(
    () =>
      scopesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [scopesText],
  );

  // The grantable set unions operation-row scopes with the extras field, so every
  // operation scope is declared by construction as the control plane requires.
  const grantable = useMemo(() => {
    if (enforcement !== "enforced") return declaredScopes;
    const set = new Set<string>();
    for (const op of operations) {
      const scope = op.scope.trim();
      if (scope) set.add(scope);
    }
    for (const scope of declaredScopes) set.add(scope);
    return [...set];
  }, [enforcement, operations, declaredScopes]);

  const slug = slugOf(name);
  const overrideSlug = identifier.trim();
  const previewSlug =
    overrideSlug && !validateResourceIdentifier(overrideSlug) ? overrideSlug : slug;
  const previewIdentifier = previewSlug ? `${RESOURCE_IDENTIFIER_PREFIX}${previewSlug}` : "";

  const errors = useMemo<FieldErrors>(() => {
    const next: FieldErrors = {};
    if (!name.trim()) next.name = "Name is required.";
    if (grantable.length === 0) {
      next.scopes =
        enforcement === "enforced"
          ? "Declare at least one operation or scope."
          : "Declare at least one scope.";
    }
    const upstream = upstreamUrl.trim();
    // The control plane requires upstream routing for every resource.
    if (!upstream) {
      next.upstreamUrl = "Upstream URL is required.";
    } else {
      try {
        const protocol = new URL(upstream).protocol;
        if (protocol !== "http:" && protocol !== "https:") {
          next.upstreamUrl = "Use an http:// or https:// URL.";
        }
      } catch {
        next.upstreamUrl = "Enter a valid http(s) URL.";
      }
    }
    if (!credentialProvider) {
      next.credentialProvider = "Select the provider that supplies upstream credentials.";
    }
    const identifierError = validateResourceIdentifier(identifier);
    if (identifierError) next.identifier = identifierError;
    if (enforcement === "enforced") {
      const seen = new Set<string>();
      for (const op of operations) {
        const method = op.method.trim();
        const path = op.path.trim();
        if (!method || !path || !op.scope.trim()) {
          next.operations = "Complete or remove unfinished operation rows.";
          break;
        }
        if (!path.startsWith("/")) {
          next.operations = `Path "${op.path}" must start with /.`;
          break;
        }
        const key = `${method.toUpperCase()} ${path}`;
        if (seen.has(key)) {
          next.operations = `"${key}" is listed more than once.`;
          break;
        }
        seen.add(key);
      }
    }
    return next;
  }, [name, grantable, upstreamUrl, credentialProvider, identifier, enforcement, operations]);

  const show = (key: keyof FieldErrors) => (touched ? errors[key] : undefined);

  function submit() {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    const input: ResourceInput = {
      name: name.trim(),
      scopes: grantable,
      operation_enforcement: enforcement,
      operations:
        enforcement === "enforced"
          ? operations.map((op) => ({
              method: op.method.trim().toUpperCase(),
              path: op.path.trim(),
              scope: op.scope.trim(),
            }))
          : [],
      upstream_url: upstreamUrl.trim(),
      allowed_application_ids: allowedApps,
      credential_provider_id: credentialProvider,
      ...(identifier.trim()
        ? { identifier: `${RESOURCE_IDENTIFIER_PREFIX}${identifier.trim()}` }
        : {}),
    };
    onSubmit(input);
  }

  function addOperation() {
    setOperations((prev) => [
      ...prev,
      { method: "GET", path: "", scope: prev.at(-1)?.scope ?? "" },
    ]);
  }

  function updateOperation(index: number, patch: Partial<OperationRow>) {
    setOperations((prev) => prev.map((op, i) => (i === index ? { ...op, ...patch } : op)));
  }

  function removeOperation(index: number) {
    setOperations((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleAllowedApp(id: string) {
    setAllowedApps((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }

  const missingPrereqs = !isEdit && providers.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Edit resource" : "New resource"}
      description={
        isEdit
          ? "Update routing and authorization for this upstream."
          : "Register a protected upstream in this zone."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {isEdit ? "Save changes" : "Create resource"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {missingPrereqs ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            This zone has no provider yet.
          </div>
        ) : null}

        <div>
          <Field
            label="Name"
            info="Display name shown across the console."
            placeholder="PiperNet"
            value={name}
            error={show("name")}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!isEdit}
          />
          {!isEdit && previewIdentifier && !show("name") ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Identifier <span className="font-mono text-foreground/80">{previewIdentifier}</span>
            </p>
          ) : null}
        </div>

        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Gateway routing
          </h3>
          <div className="mt-3 flex flex-col gap-4">
            <Field
              label="Upstream URL"
              info="Base URL the Gateway proxies authorized requests to."
              placeholder="https://api.pipernet.example"
              value={upstreamUrl}
              error={show("upstreamUrl")}
              onChange={(e) => setUpstreamUrl(e.target.value)}
            />
            <div>
              <span className="flex items-center gap-1.5">
                <span className="text-sm font-medium text-foreground">Caller allowlist</span>
                <InfoHint label="Caps which applications may mint tokens for this resource at the STS. Leave empty to let grants and policies govern callers." />
              </span>
              {managedApps.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  No managed applications in this zone. Minting stays policy governed.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border rounded-md border border-border">
                  {managedApps.map((app) => (
                    <li key={app.id} className="flex items-center gap-3 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={allowedApps.includes(app.id)}
                        onChange={() => toggleAllowedApp(app.id)}
                        aria-label={`Allow ${app.name}`}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {app.name}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {allowedApps.length === 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Empty: any application a grant and policy permits may mint for this resource.
                </p>
              ) : null}
            </div>
            <div>
              <Select
                label="Credential provider"
                info="Provider that supplies upstream credentials at runtime when the Gateway calls this resource."
                value={credentialProvider}
                onChange={(e) => setCredentialProvider(e.target.value)}
              >
                <option value="">
                  {providers.length === 0 ? "No providers in this zone" : "Select a provider…"}
                </option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name} · {PROVIDER_KIND_LABEL[provider.kind]}
                  </option>
                ))}
              </Select>
              {show("credentialProvider") ? (
                <p className="mt-1 text-xs text-destructive">{show("credentialProvider")}</p>
              ) : null}
            </div>
          </div>
        </section>

        <section className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Authorization
          </h3>
          <div className="mt-3 flex flex-col gap-4">
            <Select
              label="Enforcement"
              info="Operation enforced: each call must match a declared method, path, and scope; fits REST-style APIs. Transport uniform: granted scopes are the only boundary with no operation list; fits MCP servers, streaming transports, and upstreams that enforce their own authorization."
              value={enforcement}
              onChange={(e) => {
                const next = e.target.value as ResourceOperationEnforcement;
                // Switching to uniform folds operation scopes into the text field so
                // the grantable set survives the mode change.
                if (next === "transport_uniform") setScopesText(grantable.join(", "));
                setEnforcement(next);
              }}
            >
              <option value="enforced">Operation enforced</option>
              <option value="transport_uniform">Transport uniform</option>
            </Select>

            {enforcement === "enforced" ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground">Operations</span>
                    <InfoHint label="Calls must match a listed method, path, and scope. Anything else is denied." />
                  </span>
                  <Button variant="ghost" size="sm" onClick={addOperation}>
                    Add
                  </Button>
                </div>
                {operations.length === 0 ? (
                  <div className="grid h-9 place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                    No operations
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-[6rem_1fr_8rem_2.25rem] gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      <span>Method</span>
                      <span>Path</span>
                      <span>Scope</span>
                      <span />
                    </div>
                    {operations.map((op, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-[6rem_1fr_8rem_2.25rem] items-center gap-2"
                      >
                        <input
                          value={op.method}
                          onChange={(e) =>
                            updateOperation(index, { method: e.target.value.toUpperCase() })
                          }
                          list="resource-operation-methods"
                          placeholder="GET"
                          aria-label="Method"
                          className={`${opFieldClass} uppercase`}
                        />
                        <input
                          value={op.path}
                          onChange={(e) => updateOperation(index, { path: e.target.value })}
                          placeholder="/v1/nodes"
                          aria-label="Path"
                          className={`${opFieldClass} min-w-0`}
                        />
                        <input
                          value={op.scope}
                          onChange={(e) => updateOperation(index, { scope: e.target.value })}
                          list="resource-operation-scopes"
                          placeholder={slug ? `${slug}:read` : "pipernet:read"}
                          aria-label="Scope"
                          className={`${opFieldClass} min-w-0`}
                        />
                        <button
                          type="button"
                          onClick={() => removeOperation(index)}
                          aria-label="Remove operation"
                          className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M6 6l12 12M6 18 18 6" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <datalist id="resource-operation-methods">
                      {METHOD_SUGGESTIONS.map((method) => (
                        <option key={method} value={method} />
                      ))}
                    </datalist>
                    <datalist id="resource-operation-scopes">
                      {grantable.map((scope) => (
                        <option key={scope} value={scope} />
                      ))}
                    </datalist>
                  </div>
                )}
                {show("operations") ? (
                  <p className="text-xs text-destructive">{show("operations")}</p>
                ) : null}
              </div>
            ) : null}

            <div>
              <Field
                label={enforcement === "enforced" ? "Additional scopes" : "Scopes"}
                info={
                  enforcement === "enforced"
                    ? "Extra grantable scopes beyond the ones operations declare. Comma-separated."
                    : "Grantable permissions this resource exposes. Policies grant these to applications. Comma-separated."
                }
                placeholder={
                  enforcement === "enforced"
                    ? slug
                      ? `${slug}:admin`
                      : "pipernet:admin"
                    : slug
                      ? `${slug}:read, ${slug}:write`
                      : "pipernet:read, pipernet:write"
                }
                hint={enforcement === "enforced" ? "Optional" : undefined}
                value={scopesText}
                error={show("scopes")}
                onChange={(e) => setScopesText(e.target.value)}
              />
              {grantable.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {grantable.map((scope) => (
                    <span
                      key={scope}
                      className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <Disclosure
          title="Advanced"
          description={
            isEdit
              ? "Identifier changes rewrite the audience that grants, policies, and tokens reference."
              : "Override the generated identifier."
          }
        >
          <Field
            label="Identifier"
            info="Stable audience URI used in tokens, grants, and policy references. The resource:// namespace is fixed, so only the slug varies. Blank uses the slug generated from the name."
            prefix="resource://"
            placeholder={slug || "pipernet"}
            hint={isEdit ? "Grants and policies reference this URI." : undefined}
            value={identifier}
            error={show("identifier")}
            onChange={(e) => setIdentifier(stripResourceIdentifierPrefix(e.target.value))}
          />
        </Disclosure>
      </div>
    </Modal>
  );
}
