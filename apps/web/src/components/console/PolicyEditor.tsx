/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the Rego data-document policy editor with templates, inline validation, and contract preview.
*/
import { useEffect, useRef, useState } from "react";

import { Button, Field, Modal } from "@/components/ui";
import { cx } from "@/lib/cx";
import { consoleApi } from "@/platform/api/client";
import type { PolicyPreview, PolicyTemplate, PolicyValidateResult } from "@/platform/api/types";

// A valid adopter policy is a Rego DATA document: it supplies data the signed platform
// decision contract reads, and must never define `result`. This starter mirrors the
// backend contract so the prefilled example saves cleanly.
const STARTER = `# caracal:data-document
package caracal.authz

import rego.v1

# Adopter policies supply DATA only. The platform decision contract reads this
# data and owns every allow/deny decision — never define \`result\` here.

# Map the application keys used in grants to control-plane application ids.
app_ids := {
\t"payments": "app-payments",
}

# Grant a scope set to each role on a resource view.
grants := {
\t"resource://example": {
\t\t"application": "payments",
\t\t"roles": {"payment-execution": ["example:read"]},
\t},
}
`;

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; result: PolicyValidateResult }
  | { status: "invalid"; message: string };

export function PolicyEditorModal({
  open,
  mode,
  policyName,
  initialContent,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "version";
  policyName?: string;
  initialContent?: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (values: { name?: string; description?: string; content: string }) => void;
}) {
  const isCreate = mode === "create";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [templates, setTemplates] = useState<PolicyTemplate[] | null>(null);
  const seedRef = useRef("");

  if (open && seedRef.current !== `${open}:${mode}:${policyName ?? ""}`) {
    seedRef.current = `${open}:${mode}:${policyName ?? ""}`;
    setName("");
    setDescription("");
    setContent(initialContent ?? (isCreate ? STARTER : ""));
    setValidation({ status: "idle" });
  }

  // The canonical data-document starters come from the control plane so the editor
  // always offers the same building blocks the platform contract is designed to read.
  useEffect(() => {
    if (!open || templates !== null) return;
    let cancelled = false;
    consoleApi.policies
      .templates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, templates]);

  // Validation is invalidated whenever content changes.
  useEffect(() => {
    setValidation({ status: "idle" });
  }, [content]);

  async function validate(): Promise<boolean> {
    if (!content.trim()) {
      setValidation({ status: "invalid", message: "Policy content is required." });
      return false;
    }
    setValidation({ status: "validating" });
    try {
      const result = await consoleApi.policies.validate(content);
      if (result.valid) {
        setValidation({ status: "valid", result });
        return true;
      }
      setValidation({
        status: "invalid",
        message: humanizeRegoError(result.detail ?? result.error),
      });
      return false;
    } catch (error) {
      const message =
        error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "Validation failed.";
      setValidation({ status: "invalid", message });
      return false;
    }
  }

  async function submit() {
    if (isCreate && !name.trim()) return;
    const ok = await validate();
    if (!ok) return;
    onSubmit({
      content,
      ...(isCreate ? { name: name.trim(), description: description.trim() || undefined } : {}),
    });
  }

  function applyTemplate(id: string) {
    const template = templates?.find((t) => t.id === id);
    if (!template) return;
    setContent(template.content);
    setValidation({ status: "idle" });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isCreate ? "New policy" : `New version · ${policyName ?? ""}`}
      description={
        isCreate
          ? "Author a Rego data document. It supplies data the platform decision contract reads — it never decides on its own. Validated before it is saved."
          : "Add an immutable version. Existing versions are never modified."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => void validate()} disabled={busy}>
            Validate
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={isCreate && !name.trim()}>
            {isCreate ? "Validate & create" : "Validate & add version"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[64vh] flex-col gap-4 overflow-y-auto pr-1">
        {isCreate ? (
          <>
            <Field
              label="Name"
              placeholder="billing-read-access"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <Field
              label="Description"
              placeholder="Optional summary of what data this policy supplies"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </>
        ) : null}

        {templates && templates.length > 0 ? (
          <div>
            <div className="mb-1.5 text-sm font-medium text-foreground">Start from a template</div>
            <div className="flex flex-wrap gap-2">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  title={template.description}
                  onClick={() => applyTemplate(template.id)}
                  className="rounded-md border border-border px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:border-foreground/40"
                >
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">Rego data document</span>
            <label className="cursor-pointer font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground">
              Load from file
              <input
                type="file"
                accept=".rego,text/plain"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    setContent(String(reader.result ?? ""));
                    setValidation({ status: "idle" });
                  };
                  reader.readAsText(file);
                }}
              />
            </label>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            rows={16}
            className="scrollbar-thin w-full resize-y rounded-md border border-border bg-[#0d1117] px-3 py-2.5 font-mono text-xs leading-relaxed text-[#e6edf3] outline-none focus:border-ring dark:bg-[#0d1117]"
            placeholder="# caracal:data-document&#10;package caracal.authz…"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Must start with <span className="font-mono">{"# caracal:data-document"}</span>, use
            package <span className="font-mono">caracal.authz</span>, and define data only — never{" "}
            <span className="font-mono">result</span>.
          </p>
        </div>

        <ValidationBanner state={validation} />
      </div>
    </Modal>
  );
}

// The backend returns machine error codes; translate the ones an author can act on into
// guidance that names the data-document contract rather than leaking internal tokens.
function humanizeRegoError(code: string | undefined): string {
  switch (code) {
    case "must_be_data_document":
      return "Add the `# caracal:data-document` directive at the top. Adopter policies supply data, not decisions.";
    case "must_use_package_caracal_authz":
      return "The policy must declare `package caracal.authz`.";
    case "data_document_must_not_define_result":
      return "Remove the `result` rule. The platform decision contract owns every allow/deny — your policy supplies data only.";
    case "data_document_must_define_data":
      return "Define at least one data rule (for example `grants`, `app_ids`, `confinement`, or `restrict`).";
    case "missing_package_declaration":
      return "Add a `package caracal.authz` declaration.";
    case "unbalanced_delimiters":
      return "Unbalanced delimiters: check your braces, brackets, and parentheses.";
    case "unterminated_string":
      return "A string literal is not closed.";
    case "empty_policy":
      return "Policy content is required.";
    default:
      if (code?.startsWith("forbidden_builtin:")) {
        return `Built-in ${code.slice("forbidden_builtin:".length)} is not allowed in tenant policies.`;
      }
      if (code?.startsWith("unsupported_schema_version:")) {
        return `Unsupported schema version ${code.slice("unsupported_schema_version:".length)}.`;
      }
      return code ?? "Invalid Rego.";
  }
}

function ValidationBanner({ state }: { state: ValidationState }) {
  if (state.status === "idle") {
    return (
      <p className="text-xs text-muted-foreground">
        Validation checks Rego syntax and the data-document contract before saving.
      </p>
    );
  }
  if (state.status === "validating") {
    return <p className="text-xs text-muted-foreground">Validating…</p>;
  }
  if (state.status === "valid") {
    return <ValidPreview result={state.result} />;
  }
  return (
    <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <Dot className="mt-1 bg-destructive" />
      <div>
        <div className="font-medium">Validation failed</div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-destructive/80">
          {state.message}
        </div>
      </div>
    </div>
  );
}

function ValidPreview({ result }: { result: PolicyValidateResult }) {
  const preview: PolicyPreview | null = result.preview ?? null;
  return (
    <div className="flex flex-col gap-2 border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
      <div className="flex items-start gap-2">
        <Dot className="mt-1 bg-emerald-500" />
        <div>
          <div className="font-medium">Valid data document</div>
          <div className="mt-0.5 text-emerald-700/80 dark:text-emerald-400/80">
            Schema {result.schema_version ?? "current"} · package{" "}
            {preview?.package ?? "caracal.authz"}
          </div>
        </div>
      </div>
      {preview ? (
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 pl-4 text-emerald-700/80 dark:text-emerald-400/80">
          {preview.rules.length > 0 ? (
            <>
              <dt className="font-medium">Data</dt>
              <dd className="break-words font-mono">{preview.rules.join(", ")}</dd>
            </>
          ) : null}
          {preview.data_referenced.length > 0 ? (
            <>
              <dt className="font-medium">Reads</dt>
              <dd className="break-words font-mono">{preview.data_referenced.join(", ")}</dd>
            </>
          ) : null}
          {preview.inputs_referenced.length > 0 ? (
            <>
              <dt className="font-medium">Input</dt>
              <dd className="break-words font-mono">{preview.inputs_referenced.join(", ")}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function Dot({ className }: { className: string }) {
  return <span className={cx("inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full", className)} />;
}
