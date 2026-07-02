/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings AI Operator page for model providers, connectivity, and attribution.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Modal,
  PasswordField,
  Skeleton,
  useToast,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useActiveZone,
  useCreateOperatorAiProvider,
  useDeleteOperatorAiProvider,
  useOperatorAiCheck,
  useOperatorAiProviders,
  useOperatorAiStatus,
  useRotateOperatorAiProviderKey,
  useUpdateOperatorAiProvider,
  useUpdateZone,
} from "@/platform/api/hooks";
import type { OperatorAiAuth, OperatorAiProvider } from "@/platform/api/types";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/operator")({
  component: OperatorPage,
});

// Common OpenAI-compatible base URLs across providers, offered as endpoint suggestions. The model
// id is whatever the endpoint serves, so it is typed in rather than chosen from a list; only the
// endpoint, which genuinely varies by provider, is worth suggesting. Each is the provider's
// OpenAI-compatible /chat/completions surface (Anthropic and Gemini expose one natively; others go
// through a proxy), with placeholders the operator fills in for their own resource.
const ENDPOINT_SUGGESTIONS: { name: string; url: string }[] = [
  { name: "OpenAI", url: "https://api.openai.com/v1" },
  { name: "Anthropic", url: "https://api.anthropic.com/v1" },
  { name: "Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "OpenRouter", url: "https://openrouter.ai/api/v1" },
];

// The Operator addresses a provider by a slug used to build its configuration keys, so the slug
// is constrained to the shape the API enforces: lowercase letters, digits, and underscores.
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
}

function checkErrorMessage(err: unknown): string {
  if (err instanceof ConsoleApiError) {
    if (err.code === "ai_unavailable") return "No AI provider is configured for the Operator.";
    if (err.code === "ai_unreachable") {
      // Surface the upstream's own status so a rejected key (401/403) reads differently from a
      // wrong endpoint (404) or an unreachable host, rather than one ambiguous message.
      const attempts = (err.detail as { attempts?: { reason?: string }[] } | undefined)?.attempts;
      const reason = attempts?.[0]?.reason ?? "";
      const status = reason.match(/status (\d{3})/)?.[1];
      if (status === "401" || status === "403")
        return "The provider rejected the key. Check the API key.";
      if (status === "404") return "The endpoint was not found. Check the base URL.";
      if (status) return `The provider returned ${status}. Check the endpoint and key.`;
      return "The provider could not be reached. Check the endpoint.";
    }
  }
  return "The connectivity check failed. Try again.";
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof ConsoleApiError) {
    if (err.code === "governed_execution_unconfigured")
      return "Self-governance is not configured, so a key cannot be sealed.";
    if (err.code === "invalid_provider")
      return "Some fields are invalid. Check the form and try again.";
    if (err.code === "provider_not_found") return "That provider no longer exists.";
  }
  return "The change could not be saved. Try again.";
}

function OperatorPage() {
  const status = useOperatorAiStatus(true);
  const list = useOperatorAiProviders();
  const check = useOperatorAiCheck();
  const remove = useDeleteOperatorAiProvider();
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OperatorAiProvider | null>(null);
  const [rotating, setRotating] = useState<OperatorAiProvider | null>(null);
  const [deleting, setDeleting] = useState<OperatorAiProvider | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const available = list.data?.available ?? false;
  const providers = list.data?.providers ?? [];
  const runtime = status.data?.providers ?? [];
  const connected = status.data?.enabled ?? false;

  function runtimeReady(slug: string, model: string): boolean {
    return runtime.some(
      (entry) =>
        entry.available &&
        (entry.id === slug || entry.id.startsWith(`${slug}__`) || entry.model === model),
    );
  }

  function runCheck() {
    setCheckResult(null);
    check.mutate(undefined, {
      onSuccess: (data) =>
        setCheckResult({
          ok: true,
          message: `Operator connected: ${data.provider} · ${data.model} · ${data.latency_ms} ms`,
        }),
      onError: (err) => setCheckResult({ ok: false, message: checkErrorMessage(err) }),
    });
  }

  return (
    <div>
      <SettingsGroup
        title="Models"
        description="Add a provider, and Caracal securely routes the Operator to model through the governed gateway."
        action={
          <>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              loading={check.isPending}
              disabled={!connected}
              onClick={runCheck}
            >
              Test connectivity
            </Button>
            <Button
              size="sm"
              mutating
              disabled={!available}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              Add provider
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!available ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-400">
              Self-governance is not configured for this deployment, so a key cannot be sealed.
              Enable the Operator control plane to manage models here.
            </div>
          ) : null}

          {checkResult ? (
            <div
              role="status"
              className={
                checkResult.ok
                  ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400"
                  : "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs text-destructive"
              }
            >
              {checkResult.message}
            </div>
          ) : null}

          {list.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : providers.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No models yet. Add a provider to bring the Operator online.
            </p>
          ) : (
            <div className="scrollbar-thin max-h-[420px] divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {providers.map((provider) => (
                <div
                  key={provider.slug}
                  className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {provider.label}
                      </span>
                      {!provider.enabled ? <Badge tone="muted">Disabled</Badge> : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {provider.baseUrl}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {provider.models.map((model) => (
                        <Badge
                          key={model}
                          tone={runtimeReady(provider.slug, model) ? "success" : "neutral"}
                        >
                          {model}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => {
                        setEditing(provider);
                        setFormOpen(true);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => setRotating(provider)}
                    >
                      Rotate key
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      mutating
                      onClick={() => setDeleting(provider)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SettingsGroup>

      <AttributionGroup />

      <ProviderFormModal
        open={formOpen}
        editing={editing}
        existingSlugs={providers.map((provider) => provider.slug)}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          toast({ tone: "success", title: editing ? "Provider updated" : "Provider added" });
        }}
      />

      {rotating ? (
        <RotateKeyModal
          provider={rotating}
          onClose={() => setRotating(null)}
          onRotated={() => {
            setRotating(null);
            toast({ tone: "success", title: "Key rotated" });
          }}
        />
      ) : null}

      <ConfirmModal
        open={deleting !== null}
        title="Delete provider"
        description={
          deleting
            ? `Remove ${deleting.label}? Its sealed key is destroyed and the Operator's grant to it is revoked.`
            : ""
        }
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.slug);
            toast({ tone: "info", title: "Provider deleted" });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: writeErrorMessage(err) });
          }
        }}
      />
    </div>
  );
}

// The co-author badge is a per-zone property of the Operator's output, so it lives with the rest
// of the Operator configuration rather than in personal preferences.
function AttributionGroup() {
  const { activeZone } = useActiveZone();
  const updateZone = useUpdateZone();
  const toast = useToast();
  const badgeOn = activeZone?.operator_coauthor_badge ?? true;

  async function toggleBadge(next: boolean) {
    if (!activeZone) return;
    try {
      await updateZone.mutateAsync({
        id: activeZone.id,
        input: { operator_coauthor_badge: next },
      });
    } catch {
      toast({ title: "Could not update the operator badge setting.", tone: "error" });
    }
  }

  return (
    <SettingsGroup
      title="Attribution"
      description="Show a co-author badge on items the Caracal Operator creates in this zone."
      action={
        <button
          type="button"
          role="switch"
          aria-checked={badgeOn}
          aria-label="Operator co-author badge"
          disabled={!activeZone || updateZone.isPending}
          onClick={() => toggleBadge(!badgeOn)}
          className={[
            "relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors",
            badgeOn ? "bg-foreground" : "bg-muted",
            !activeZone || updateZone.isPending ? "opacity-60" : "",
          ].join(" ")}
        >
          <span
            className={[
              "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
              badgeOn ? "translate-x-4" : "translate-x-0.5",
            ].join(" ")}
          />
        </button>
      }
    />
  );
}

// The endpoint base-URL field with a focus-triggered suggestions menu. Each provider's
// OpenAI-compatible base URL is clickable to fill the field; a final non-clickable row makes clear
// that any other OpenAI-compatible URL can be typed in directly, so the list reads as a shortcut
// rather than a closed set. A native datalist cannot show a non-selectable hint, so this is a
// small popover that closes on outside click or Escape.
function EndpointField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative block">
      <FieldLabel label="Endpoint base URL" info="Any OpenAI-compatible endpoint works." />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setOpen(true)}
        placeholder="https://api.openai.com/v1"
        className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
      />
      {open ? (
        <div className="animate-pop-in absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-xl">
          {ENDPOINT_SUGGESTIONS.map((item) => (
            <button
              key={item.url}
              type="button"
              onClick={() => {
                onChange(item.url);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
            >
              <span className="text-sm text-foreground">{item.name}</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {item.url}
              </span>
            </button>
          ))}
          <div className="mt-1 border-t border-border px-2 py-1.5 text-[11px] text-muted-foreground">
            Custom (Any OpenAI-compatible URL).
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The add and edit form. Adding starts empty so the operator supplies only what matters: an
// OpenAI-compatible endpoint, a key, and the model ids the endpoint serves. The slug defaults
// from the label. Editing locks the slug and omits the key, which is changed through rotate. The
// provider and resource details Caracal sets automatically (api-key auth, an Authorization Bearer
// header, the llm:invoke and agent:lifecycle scopes, and the gateway binding) are explained
// rather than asked for.
function ProviderFormModal({
  open,
  editing,
  existingSlugs,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: OperatorAiProvider | null;
  existingSlugs: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const create = useCreateOperatorAiProvider();
  const update = useUpdateOperatorAiProvider();

  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelDraft, setModelDraft] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authLocation, setAuthLocation] = useState<"header" | "query">("header");
  const [headerName, setHeaderName] = useState("Authorization");
  const [authScheme, setAuthScheme] = useState("Bearer");
  const [queryParamName, setQueryParamName] = useState("api_key");
  const [showPlacement, setShowPlacement] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form whenever it opens: an edit loads the provider, a fresh add starts empty so the
  // operator supplies only what matters - endpoint, key, and the model ids the endpoint serves.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setModelDraft("");
    if (editing) {
      setSlug(editing.slug);
      setSlugEdited(true);
      setLabel(editing.label);
      setBaseUrl(editing.baseUrl);
      setModels(editing.models);
      setContextWindow(editing.contextWindow ? String(editing.contextWindow) : "");
      setApiKey("");
      setAuthLocation(editing.auth.location);
      setHeaderName(editing.auth.headerName ?? "Authorization");
      setAuthScheme(editing.auth.authScheme ?? "");
      setQueryParamName(editing.auth.queryParamName ?? "api_key");
      setShowPlacement(
        editing.auth.location !== "header" ||
          (editing.auth.headerName ?? "Authorization") !== "Authorization",
      );
    } else {
      setSlug("");
      setSlugEdited(false);
      setLabel("");
      setBaseUrl("");
      setModels([]);
      setContextWindow("");
      setApiKey("");
      setAuthLocation("header");
      setHeaderName("Authorization");
      setAuthScheme("Bearer");
      setQueryParamName("api_key");
      setShowPlacement(false);
    }
  }, [open, editing]);

  // The slug defaults to a sanitized form of the label so a new provider needs no separate id,
  // unless the operator edits the slug directly, after which it is left alone.
  function changeLabel(value: string) {
    setLabel(value);
    if (!editing && !slugEdited) setSlug(sanitizeSlug(value));
  }

  function addModel() {
    const value = modelDraft.trim();
    if (!value || models.includes(value)) {
      setModelDraft("");
      return;
    }
    setModels((prev) => [...prev, value]);
    setModelDraft("");
  }

  const slugTaken = !editing && existingSlugs.includes(slug);
  const valid =
    slug.length > 0 &&
    !slugTaken &&
    label.trim().length > 0 &&
    baseUrl.trim().length > 0 &&
    models.length > 0 &&
    (editing !== null || apiKey.length > 0);
  const busy = create.isPending || update.isPending;

  async function save() {
    setError(null);
    const ctx = contextWindow.trim() ? Number(contextWindow) : 0;
    const auth: OperatorAiAuth =
      authLocation === "query"
        ? { location: "query", queryParamName: queryParamName.trim() || "api_key" }
        : {
            location: "header",
            headerName: headerName.trim() || "Authorization",
            authScheme: authScheme.trim() || undefined,
          };
    try {
      if (editing) {
        await update.mutateAsync({
          slug: editing.slug,
          patch: { label, baseUrl, models, contextWindow: ctx, auth },
        });
      } else {
        await create.mutateAsync({
          slug,
          label,
          baseUrl,
          models,
          contextWindow: ctx,
          apiKey,
          enabled: true,
          auth,
        });
      }
      onSaved();
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit provider" : "Add a model provider"}
      description={
        editing
          ? "Update the endpoint and models. Rotate the key from the provider's menu."
          : "Supply an OpenAI-compatible endpoint and key; Caracal seals and governs it."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            {editing ? "Save changes" : "Add provider"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Label"
            value={label}
            onChange={(event) => changeLabel(event.target.value)}
            placeholder="OpenAI production"
          />
          <Field
            label="Provider id"
            info="A short slug Caracal uses to name the sealed provider and resource."
            value={slug}
            onChange={(event) => {
              setSlug(sanitizeSlug(event.target.value));
              setSlugEdited(true);
            }}
            placeholder="openai"
            disabled={editing !== null}
            error={slugTaken ? "That id is already in use." : undefined}
          />
          <div className="sm:col-span-2">
            <EndpointField value={baseUrl} onChange={setBaseUrl} />
          </div>
          <Field
            label="Context window"
            info="Optional. The model's token window, used for the usage gauge."
            value={contextWindow}
            onChange={(event) => setContextWindow(event.target.value.replace(/[^0-9]/g, ""))}
            placeholder="128000"
            inputMode="numeric"
          />
          {!editing ? (
            <PasswordField
              label="API key"
              info="Sent once and sealed into Caracal; it is never stored in the console or read back."
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
            />
          ) : null}
        </div>

        <div className="grid gap-2">
          <FieldLabel
            label="Models"
            info="The exact model ids this endpoint serves. One provider can serve several behind the same key."
          />
          <div className="flex gap-2">
            <input
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addModel();
                }
              }}
              placeholder="e.g. gpt-5.5, then Enter"
              className="h-9 w-full rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/25"
            />
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={addModel}
              disabled={!modelDraft.trim()}
            >
              Add
            </Button>
          </div>
          {models.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {models.map((model) => (
                <span
                  key={model}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {model}
                  <button
                    type="button"
                    aria-label={`Remove ${model}`}
                    onClick={() => setModels((prev) => prev.filter((value) => value !== model))}
                    className="text-muted-foreground transition-colors hover:text-destructive"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowPlacement((v) => !v)}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showPlacement ? "Hide" : "Advanced:"} key placement
          </button>
          {showPlacement ? (
            <div className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Where the sealed key is sent. Default is an Authorization Bearer header. Some
                upstreams differ - Azure uses an <span className="font-mono">api-key</span> header,
                a LiteLLM/OpenRouter proxy expects <span className="font-mono">X-API-Key</span>, and
                a few take it in the query string.
              </p>
              <div className="flex gap-2">
                {(["header", "query"] as const).map((loc) => (
                  <button
                    key={loc}
                    type="button"
                    onClick={() => setAuthLocation(loc)}
                    className={[
                      "h-8 px-3 text-xs font-medium capitalize transition-colors",
                      authLocation === loc
                        ? "bg-foreground text-background"
                        : "border border-border text-muted-foreground hover:bg-surface",
                    ].join(" ")}
                  >
                    {loc}
                  </button>
                ))}
              </div>
              {authLocation === "header" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Header name"
                    value={headerName}
                    onChange={(e) => setHeaderName(e.target.value)}
                    placeholder="Authorization"
                  />
                  <Field
                    label="Scheme prefix"
                    info="Optional. Blank sends the raw key (e.g. Azure)."
                    value={authScheme}
                    onChange={(e) => setAuthScheme(e.target.value)}
                    placeholder="Bearer"
                  />
                </div>
              ) : (
                <Field
                  label="Query parameter"
                  value={queryParamName}
                  onChange={(e) => setQueryParamName(e.target.value)}
                  placeholder="api_key"
                />
              )}
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          The endpoint must speak the OpenAI <span className="font-mono">/chat/completions</span>{" "}
          format - OpenAI and Azure work directly; for Claude, Gemini, or others, point this at an
          OpenAI-compatible proxy such as LiteLLM or OpenRouter. Caracal seals the key into the
          caracal.sys system zone, sets the scopes and gateway binding, and routes the Operator only
          through the governed gateway.
        </div>

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function RotateKeyModal({
  provider,
  onClose,
  onRotated,
}: {
  provider: OperatorAiProvider;
  onClose: () => void;
  onRotated: () => void;
}) {
  const rotate = useRotateOperatorAiProviderKey();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await rotate.mutateAsync({ slug: provider.slug, apiKey });
      onRotated();
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Rotate key - ${provider.label}`}
      description="The new key is sealed into Caracal, replacing the old one. The model stays online."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={rotate.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={rotate.isPending} disabled={apiKey.length === 0}>
            Rotate key
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <PasswordField
          label="New API key"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="sk-…"
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
