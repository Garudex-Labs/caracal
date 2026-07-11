/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the Rego data-document policy editor with templates and inline validation.
*/
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge, Button, Field, Modal } from "@/components/ui";
import { cx } from "@/lib/cx";
import { consoleApi, ConsoleApiError } from "@/platform/api/client";
import type { PolicyPreview } from "@/platform/api/types";

// A valid adopter policy is a Rego DATA document: it supplies data the signed platform
// decision contract reads, and must never define `result`. This starter mirrors the
// backend contract so the prefilled example saves cleanly.
const STARTER = `# caracal:data-document
package caracal.authz

import rego.v1

# Adopter policies supply DATA only. The platform decision contract reads this
# data and owns every allow/deny decision. Never define \`result\` here.

# Map the application keys used in grants to control-plane application ids.
app_ids := {
\t"anton": "app-anton",
}

# Grant a scope set to each role on a resource view.
grants := {
\t"resource://pipernet": {
\t\t"application": "anton",
\t\t"roles": {"pipernet-operator": ["pipernet:read"]},
\t},
}
`;

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; preview: PolicyPreview | null }
  | { status: "invalid"; message: string };

// GitHub-dark token palette matching the editor surface. Comments, strings, keywords,
// and literals are colored; everything else renders in the base foreground.
const REGO_TOKEN =
  /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?)|\b(package|import|default|if|else|some|every|in|not|with|as|contains)\b|\b(true|false|null|\d+(?:\.\d+)?)\b/g;

function highlightRego(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of source.matchAll(REGO_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(source.slice(last, start));
    const [text, comment, string, keyword] = match;
    const color = comment ? "#8b949e" : string ? "#a5d6ff" : keyword ? "#ff7b72" : "#79c0f3";
    nodes.push(
      <span key={key++} style={{ color }}>
        {text}
      </span>,
    );
    last = start + text.length;
  }
  if (last < source.length) nodes.push(source.slice(last));
  return nodes;
}

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
  const highlightRef = useRef<HTMLPreElement>(null);
  const seedRef = useRef("");

  // Seed on open; clear the seed ref on close so every reopen re-seeds. For "create" the
  // seed key is otherwise constant, which would carry the previous draft (name, description,
  // policy content) into the next New - fixed by resetting when the editor closes.
  const seedKey = `${mode}:${policyName ?? ""}`;
  if (open && seedRef.current !== seedKey) {
    seedRef.current = seedKey;
    setName("");
    setDescription("");
    setContent(initialContent ?? (isCreate ? STARTER : ""));
    setValidation({ status: "idle" });
  } else if (!open && seedRef.current !== "") {
    seedRef.current = "";
  }

  // Live validation: the validate endpoint is read-only and cheap, so every pause in
  // typing checks the document and surfaces the parsed preview. The contract teaches
  // itself - authors see the data keys and inputs their document defines as they write.
  useEffect(() => {
    if (!open) return;
    if (!content.trim()) {
      setValidation({ status: "idle" });
      return;
    }
    setValidation({ status: "validating" });
    const timer = setTimeout(async () => {
      try {
        const result = await consoleApi.policies.validate(content);
        setValidation({ status: "valid", preview: result.preview ?? null });
      } catch (error) {
        if (error instanceof ConsoleApiError) {
          const body = error.detail as { error_description?: string } | undefined;
          setValidation({
            status: "invalid",
            message: humanizeRegoError(body?.error_description ?? error.code),
          });
        } else {
          setValidation({ status: "invalid", message: "Validation failed." });
        }
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [open, content]);

  async function validate(): Promise<boolean> {
    if (!content.trim()) {
      setValidation({ status: "invalid", message: "Policy content is required." });
      return false;
    }
    setValidation({ status: "validating" });
    try {
      const result = await consoleApi.policies.validate(content);
      setValidation({ status: "valid", preview: result.preview ?? null });
      return true;
    } catch (error) {
      if (error instanceof ConsoleApiError) {
        const body = error.detail as { error_description?: string } | undefined;
        setValidation({
          status: "invalid",
          message: humanizeRegoError(body?.error_description ?? error.code),
        });
      } else {
        setValidation({ status: "invalid", message: "Validation failed." });
      }
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isCreate ? "New policy" : `New version · ${policyName ?? ""}`}
      description={
        isCreate
          ? "Author a Rego data document. It supplies data the platform decision contract reads. It never decides on its own. Validated before it is saved."
          : "Add an immutable version. Existing versions are never modified."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={(isCreate && !name.trim()) || validation.status === "invalid"}
          >
            {isCreate ? "Create" : "Add version"}
          </Button>
        </>
      }
    >
      <div className="flex max-h-[64vh] flex-col gap-4 overflow-y-auto pr-1">
        {isCreate ? (
          <>
            <Field
              label="Name"
              placeholder="pipernet-baseline"
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
          <div className="relative overflow-hidden rounded-md border border-border bg-[#0d1117] focus-within:border-ring">
            <pre
              ref={highlightRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs leading-relaxed text-[#e6edf3]"
            >
              {highlightRego(content)}
              {"\n"}
            </pre>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onScroll={(e) => {
                const pre = highlightRef.current;
                if (pre) {
                  pre.scrollTop = e.currentTarget.scrollTop;
                  pre.scrollLeft = e.currentTarget.scrollLeft;
                }
              }}
              spellCheck={false}
              rows={16}
              className="scrollbar-thin relative block w-full resize-none bg-transparent px-3 py-2.5 font-mono text-xs leading-relaxed text-transparent caret-[#e6edf3] outline-none placeholder:text-[#6e7681]"
              placeholder="# caracal:data-document&#10;package caracal.authz…"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Must start with <span className="font-mono">{"# caracal:data-document"}</span>, use
            package <span className="font-mono">caracal.authz</span>, and define data only, never{" "}
            <span className="font-mono">result</span>.
          </p>
        </div>

        {validation.status === "invalid" ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <Dot className="mt-1 bg-destructive" />
            <div>
              <div className="font-medium">Validation failed</div>
              <div className="mt-0.5 whitespace-pre-wrap break-words text-destructive/80">
                {validation.message}
              </div>
            </div>
          </div>
        ) : validation.status === "valid" ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-xs">
            <div className="flex items-center gap-2">
              <Dot className="bg-emerald-500" />
              <span className="font-medium text-foreground">Valid data document</span>
            </div>
            {validation.preview ? (
              <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                {validation.preview.rules.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Defines</dt>
                    <dd className="flex flex-wrap gap-1">
                      {validation.preview.rules.map((rule) => (
                        <Badge key={rule} tone="neutral">
                          {rule}
                        </Badge>
                      ))}
                    </dd>
                  </>
                ) : null}
                {validation.preview.inputs_referenced.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Reads input</dt>
                    <dd className="font-mono text-[11px] text-muted-foreground">
                      {validation.preview.inputs_referenced.join(", ")}
                    </dd>
                  </>
                ) : null}
                {validation.preview.data_referenced.length > 0 ? (
                  <>
                    <dt className="text-muted-foreground">Reads data</dt>
                    <dd className="font-mono text-[11px] text-muted-foreground">
                      {validation.preview.data_referenced.join(", ")}
                    </dd>
                  </>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : validation.status === "validating" ? (
          <p className="text-xs text-muted-foreground">Checking document…</p>
        ) : null}
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
      return "Remove the `result` rule. The platform decision contract owns every allow/deny. Your policy supplies data only.";
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
    case "content_too_large":
      return "Policy exceeds the 256 KiB size limit. Split it into smaller data documents.";
    default:
      if (code?.startsWith("data_document_rule_not_allowed:")) {
        return `Remove rule ${code.slice("data_document_rule_not_allowed:".length)}. Adopter documents may define only app_ids, grants, confinement, restrict, risk, and approval_tiers.`;
      }
      if (code?.startsWith("forbidden_builtin:")) {
        return `Built-in ${code.slice("forbidden_builtin:".length)} is not allowed in tenant policies.`;
      }
      if (code?.startsWith("unsupported_schema_version:")) {
        return `Unsupported schema version ${code.slice("unsupported_schema_version:".length)}.`;
      }
      return code ?? "Invalid Rego.";
  }
}

function Dot({ className }: { className: string }) {
  return <span className={cx("inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full", className)} />;
}
