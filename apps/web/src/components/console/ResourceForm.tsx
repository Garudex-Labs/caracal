/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file builds the create and edit form for Gateway-routed resources, including scope, binding, and operation editing.
*/
import { useMemo, useState } from "react";

import { Button, Disclosure, Field, Modal, Select } from "@/components/ui";
import { validateResourceIdentifier } from "@/platform/api/validation";
import type {
  Application,
  Provider,
  Resource,
  ResourceInput,
  ResourceOperation,
  ResourceOperationEnforcement,
} from "@/platform/api/types";

// Common methods offered as type-ahead suggestions. The Gateway authorizes any non-empty
// method token (the control plane uppercases it), so the editor accepts free-form verbs
// such as WebDAV or custom methods rather than restricting to this list.
const METHOD_SUGGESTIONS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

interface OperationRow {
  method: string;
  path: string;
  scope: string;
}

function seedScopes(resource?: Resource): string {
  return (resource?.scopes ?? []).join(", ");
}

export function ResourceFormModal({
  open,
  mode,
  resource,
  applications,
  providers,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  resource?: Resource;
  applications: Application[];
  providers: Provider[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: ResourceInput) => void;
}) {
  const isEdit = mode === "edit";

  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [upstreamUrl, setUpstreamUrl] = useState("");
  const [scopesText, setScopesText] = useState("");
  const [gatewayApp, setGatewayApp] = useState("");
  const [credentialProvider, setCredentialProvider] = useState("");
  const [enforcement, setEnforcement] = useState<ResourceOperationEnforcement>("enforced");
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const [touched, setTouched] = useState(false);

  // Seed (or fully reset) the form each time the modal opens, and clear the seed ref on
  // close so every reopen starts fresh. Without the close-reset, "create" keeps a constant
  // seed key and would carry the previous entry into the next New.
  const seedKey = `${resource?.id ?? "new"}:${mode}`;
  const [seedRef, setSeedRef] = useState<string | null>(null);
  if (open && seedKey !== seedRef) {
    setSeedRef(seedKey);
    setName(resource?.name ?? "");
    setIdentifier(resource?.identifier ?? "");
    setUpstreamUrl(resource?.upstream_url ?? "");
    setScopesText(seedScopes(resource));
    setGatewayApp(resource?.gateway_application_id ?? "");
    setCredentialProvider(resource?.credential_provider_id ?? "");
    setEnforcement(resource?.operation_enforcement ?? "enforced");
    setOperations((resource?.operations ?? []).map((op) => ({ ...op })));
    setTouched(false);
  } else if (!open && seedRef !== null) {
    setSeedRef(null);
  }

  const managedApps = useMemo(
    () => applications.filter((app) => app.registration_method === "managed"),
    [applications],
  );

  const scopes = useMemo(
    () =>
      scopesText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    [scopesText],
  );

  function validate(): string | null {
    if (!isEdit && !name.trim()) return "Resource name is required.";
    if (scopes.length === 0) return "At least one scope is required.";
    // The control plane requires the full Gateway binding for every resource.
    if (!upstreamUrl.trim()) return "Upstream URL is required.";
    try {
      const protocol = new URL(upstreamUrl.trim()).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        return "Upstream URL must use http:// or https://.";
      }
    } catch {
      return "Upstream URL must be a valid http(s) URL.";
    }
    if (!gatewayApp) return "Gateway application is required.";
    if (!credentialProvider) return "Credential provider is required.";
    const identifierError = validateResourceIdentifier(identifier);
    if (identifierError) return identifierError;
    if (enforcement === "enforced") {
      const seen = new Set<string>();
      for (const op of operations) {
        if (!op.path.trim()) continue;
        if (!op.method.trim()) return `Operation "${op.path.trim()}" must declare a method.`;
        if (!op.path.startsWith("/")) return `Operation path "${op.path}" must be absolute.`;
        if (!scopes.includes(op.scope))
          return `Operation scope "${op.scope}" must be a declared scope.`;
        const key = `${op.method.trim().toUpperCase()} ${op.path.trim()}`;
        if (seen.has(key)) return `Operation "${key}" is listed more than once.`;
        seen.add(key);
      }
    }
    return null;
  }

  // Enforced operations with a blank path are dropped on submit; warn before that
  // happens so an operator does not silently lose a half-filled row.
  const droppedOps =
    enforcement === "enforced" ? operations.filter((op) => !op.path.trim()).length : 0;

  function submit() {
    setTouched(true);
    if (validate()) return;
    const cleanOps: ResourceOperation[] =
      enforcement === "transport_uniform"
        ? []
        : operations
            .filter((op) => op.path.trim())
            .map((op) => ({
              method: op.method.trim().toUpperCase(),
              path: op.path.trim(),
              scope: op.scope,
            }));

    const input: ResourceInput = {
      scopes,
      operation_enforcement: enforcement,
      operations: cleanOps,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(identifier.trim() ? { identifier: identifier.trim() } : {}),
      ...(upstreamUrl.trim() ? { upstream_url: upstreamUrl.trim() } : { upstream_url: null }),
      ...(gatewayApp ? { gateway_application_id: gatewayApp } : { gateway_application_id: null }),
      ...(credentialProvider
        ? { credential_provider_id: credentialProvider }
        : { credential_provider_id: null }),
    };
    onSubmit(input);
  }

  const error = touched ? validate() : null;

  function addOperation() {
    setOperations((prev) => [...prev, { method: "GET", path: "", scope: scopes[0] ?? "" }]);
  }

  function updateOperation(index: number, patch: Partial<OperationRow>) {
    setOperations((prev) => prev.map((op, i) => (i === index ? { ...op, ...patch } : op)));
  }

  function removeOperation(index: number) {
    setOperations((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit resource" : "New resource"}
      description={
        isEdit
          ? "Update the protected upstream, its Gateway binding, and authorized operations."
          : "Register a protected upstream the Gateway authorizes in this zone."
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
      <div className="flex max-h-[62vh] flex-col gap-4 overflow-y-auto pr-1">
        {!isEdit && (managedApps.length === 0 || providers.length === 0) ? (
          <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            A resource needs a managed application and a credential provider to bind to.
            {managedApps.length === 0 ? " Create a managed application first." : ""}
            {providers.length === 0 ? " Create a provider first." : ""}
          </div>
        ) : null}
        <Field
          label="Name"
          info="Human-readable name for this protected upstream, shown across the console. Use a short operational name, not an internal ID."
          placeholder="payments-api"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus={!isEdit}
        />

        <div>
          <Field
            label="Scopes"
            info="The grantable permissions this resource exposes. Policies grant these scopes to applications, and operations below map to them. At least one is required."
            placeholder="invoices:read, invoices:write"
            hint="Comma-separated authorization scopes. At least one is required."
            value={scopesText}
            onChange={(e) => setScopesText(e.target.value)}
          />
          {scopes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {scopes.map((scope) => (
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

        <div className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Gateway binding
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every resource binds an upstream, a managed gateway application, and a credential
            provider.
          </p>
          <div className="mt-3 flex flex-col gap-4">
            <Field
              label="Upstream URL"
              info="The base URL the Gateway proxies authorized requests to. Use the internal address of the protected service."
              placeholder="https://api.internal.example.com"
              value={upstreamUrl}
              onChange={(e) => setUpstreamUrl(e.target.value)}
            />
            <Select
              label="Gateway application"
              info="The managed application that fronts this resource at the Gateway. Requests are authorized as this identity before reaching the upstream."
              value={gatewayApp}
              onChange={(e) => setGatewayApp(e.target.value)}
            >
              <option value="">Select a managed application…</option>
              {managedApps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </Select>
            <Select
              label="Credential provider"
              info="The provider that supplies upstream credentials at runtime when the Gateway calls this resource."
              value={credentialProvider}
              onChange={(e) => setCredentialProvider(e.target.value)}
            >
              <option value="">Select a provider…</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="border-t border-border pt-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Operation authority
          </h3>
          <div className="mt-3 flex flex-col gap-3">
            <Select
              label="Enforcement"
              info="Enforced authorizes only the operations you list below. Transport uniform trusts the whole upstream surface as one unit (MCP-style), without per-operation rules."
              value={enforcement}
              onChange={(e) => setEnforcement(e.target.value as ResourceOperationEnforcement)}
            >
              <option value="enforced">Enforced: only listed operations are authorized</option>
              <option value="transport_uniform">
                Transport uniform: trust a single upstream surface (MCP-style)
              </option>
            </Select>

            {enforcement === "enforced" ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    Operations authorized by the Gateway
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={addOperation}
                    disabled={scopes.length === 0}
                  >
                    Add operation
                  </Button>
                </div>
                {scopes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Declare scopes first.</p>
                ) : operations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No operations listed. Add operations to restrict the Gateway surface.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {operations.map((op, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          value={op.method}
                          onChange={(e) =>
                            updateOperation(index, { method: e.target.value.toUpperCase() })
                          }
                          list="resource-operation-methods"
                          placeholder="GET"
                          aria-label="Method"
                          className="h-9 w-24 shrink-0 rounded-md border border-border bg-background px-2 font-mono text-xs uppercase text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/25"
                        />
                        <input
                          value={op.path}
                          onChange={(e) => updateOperation(index, { path: e.target.value })}
                          placeholder="/v1/invoices"
                          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/25"
                        />
                        <select
                          value={op.scope}
                          onChange={(e) => updateOperation(index, { scope: e.target.value })}
                          className="h-9 w-32 shrink-0 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/25"
                        >
                          {scopes.map((scope) => (
                            <option key={scope} value={scope}>
                              {scope}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeOperation(index)}
                          aria-label="Remove operation"
                          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
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
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Authorization is uniform across the transport. Individual operations are not listed.
              </p>
            )}
          </div>
        </div>

        <Disclosure title="Advanced options" description="Override the auto-generated identifier.">
          <Field
            label="Identifier"
            info="The stable audience URI used in tokens and policy. Generated from the name when blank; must use the resource:// namespace or be an absolute URI."
            placeholder="resource://payments-api"
            hint="Optional. Generated from the name when blank. Must match resource:// or an absolute URI."
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </Disclosure>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!error && droppedOps > 0 ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            {droppedOps} operation{droppedOps === 1 ? "" : "s"} with an empty path will be discarded
            on save.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
