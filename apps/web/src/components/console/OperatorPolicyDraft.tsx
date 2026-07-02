// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// The dedicated policy-draft artifact: the authoring specialist's validated documents, their explanations and previews, risks, simulations, activation readiness, and the governed create action.

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import { LinkGlyph, PlanGlyph } from "@/components/console/OperatorGlyphs";
import {
  Badge,
  Button,
  SegmentedTabs,
  useCopyToClipboard,
  useToast,
  type Segment,
} from "@/components/ui";
import { TERMINAL_HIGHLIGHT, highlightCode } from "@/lib/codeHighlight";
import { appLink } from "@/platform/nav/appLink";
import { useCreateOperatorPlan } from "@/platform/api/hooks";
import type {
  PolicyDocumentView,
  PolicyDraftView,
  PolicyRiskSeverity,
  PolicySimulationView,
} from "@/platform/operator/timeline";

// The console cap on a created policy's description; the draft's explanation is trimmed to fit so
// the governed create step always carries valid arguments the control plane accepts unchanged.
const DESCRIPTION_LIMIT = 500;
// The console cap on a policy name; a concern longer than this is trimmed so the create step's name
// argument stays within the capability contract.
const NAME_LIMIT = 200;

// Derives a policy name from a document's concern, falling back to its file name so a document with
// no stated concern still names cleanly. The result is trimmed to the capability's name limit.
function deriveName(doc: PolicyDocumentView): string {
  const source = doc.concern.trim() || doc.filename.replace(/\.rego$/i, "").trim() || "policy";
  return source.slice(0, NAME_LIMIT);
}

// Composes the created policy's description so the artifact stays traceable to its origin: the
// serving model is named first, then the specialist's explanation, trimmed to the capability limit.
function deriveDescription(doc: PolicyDocumentView, model: string): string {
  const origin = `AI-assisted via ${model}.`;
  const explanation = doc.explanation.trim();
  const full = explanation.length > 0 ? `${origin} ${explanation}` : origin;
  return full.slice(0, DESCRIPTION_LIMIT);
}

// Builds the governed plan a draft's create action proposes: one createPolicy step per validated
// document, each carrying the exact validated content and a provenance-stamped description. The plan
// is only proposed here; approval and application stay on the existing gate.
function buildCreatePlan(draft: PolicyDraftView) {
  const model = draft.provenance?.model ?? "an AI provider";
  const steps = draft.documents.map((doc, index) => ({
    id: `create-${index + 1}`,
    capability: "createPolicy",
    args: {
      name: deriveName(doc),
      description: deriveDescription(doc, model),
      content: doc.content,
      ...(draft.schemaVersion.length > 0 ? { schema_version: draft.schemaVersion } : {}),
    },
  }));
  const noun = steps.length === 1 ? "policy" : "policies";
  return {
    summary: `Create ${steps.length} ${noun} from AI-assisted draft`,
    steps,
  };
}

const RISK_TONE: Record<PolicyRiskSeverity, "neutral" | "warning" | "danger"> = {
  info: "neutral",
  caution: "warning",
  warning: "danger",
};

// The deterministic preview Caracal computed from a document's own content: the package, the data
// rules it defines, the decisions it names, and the input and data paths it reads. It is Caracal's
// reading of the validated document, never the model's claim, so it grounds the explanation in fact.
function DocumentPreview({ doc }: { doc: PolicyDocumentView }) {
  const preview = doc.preview;
  if (!preview) return null;
  const rows: [string, string[]][] = [
    ["Package", [preview.package]],
    ["Data", preview.rules],
    ["Decisions", preview.decisions],
    ["Reads input", preview.inputsReferenced],
    ["Reads data", preview.dataReferenced],
  ];
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {rows
        .filter(([, values]) => values.length > 0)
        .map(([label, values]) => (
          <div key={label} className="contents">
            <dt className="font-medium text-foreground/70">{label}</dt>
            <dd className="break-words font-mono">{values.join(", ")}</dd>
          </div>
        ))}
      {preview.defaultResult ? (
        <div className="contents">
          <dt className="font-medium text-foreground/70">Default</dt>
          <dd className="font-mono">sets a default result</dd>
        </div>
      ) : null}
    </dl>
  );
}

// A single validated data document: its concern, its Rego content shown with syntax highlighting,
// the plain-English explanation, Caracal's deterministic preview, and per-document copy and download.
function DocumentCard({ doc, index }: { doc: PolicyDocumentView; index: number }) {
  const copy = useCopyToClipboard();
  const filename = doc.filename.trim() || `policy-${index + 1}.rego`;
  const highlighted = useMemo(
    () => highlightCode(doc.content, "Rego", TERMINAL_HIGHLIGHT),
    [doc.content],
  );

  function download() {
    const blob = new Blob([doc.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-2">
      {doc.concern.trim() ? (
        <div className="text-xs font-medium text-foreground">{doc.concern}</div>
      ) : null}
      {doc.explanation.trim() ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{doc.explanation}</p>
      ) : null}
      <div className="overflow-hidden rounded-md border border-border bg-[#0d1117]">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wide text-[#8b949e]">
            {filename}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void copy(doc.content, { successTitle: "Rego copied" })}
              className="font-mono text-[10px] uppercase tracking-wide text-[#8b949e] transition-colors hover:text-white"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={download}
              className="font-mono text-[10px] uppercase tracking-wide text-[#8b949e] transition-colors hover:text-white"
            >
              Download
            </button>
          </div>
        </div>
        <pre className="scrollbar-thin overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-[#e6edf3]">
          <code>{highlighted}</code>
        </pre>
      </div>
      <DocumentPreview doc={doc} />
    </div>
  );
}

// One proposed authorization case: the scenario, the decision it should yield, its description, and
// the exact input the decision contract would read, with a copy for exercising it directly.
function SimulationCard({ sim }: { sim: PolicySimulationView }) {
  const copy = useCopyToClipboard();
  const inputText = useMemo(() => JSON.stringify(sim.input, null, 2), [sim.input]);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge tone={sim.expectedDecision === "allow" ? "success" : "danger"}>
          {sim.expectedDecision}
        </Badge>
        <span className="text-xs font-medium text-foreground">{sim.name}</span>
      </div>
      {sim.description.trim() ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{sim.description}</p>
      ) : null}
      <div className="flex items-start justify-between gap-2 rounded bg-muted/60 px-2 py-1.5">
        <pre className="scrollbar-thin overflow-x-auto font-mono text-[10px] leading-relaxed text-muted-foreground">
          {inputText}
        </pre>
        <button
          type="button"
          onClick={() => void copy(inputText, { successTitle: "Input copied" })}
          className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          Copy
        </button>
      </div>
    </div>
  );
}

// The dedicated rendering of an authoring specialist's policy draft. When the intent was too
// ambiguous to author safely the draft carries clarifying questions and no documents, so this shows
// what the specialist needs answered rather than an empty artifact. When documents are present it
// renders each validated document with its explanation and deterministic preview, the risks and
// least-privilege recommendations found, the ready-to-run simulations, activation readiness,
// provenance, and the single governed action that proposes their creation for approval.
export function OperatorPolicyDraft({
  draft,
  zoneId,
  conversationId,
}: {
  draft: PolicyDraftView;
  zoneId: string | null;
  conversationId: string;
}) {
  const toast = useToast();
  const copy = useCopyToClipboard();
  const createPlan = useCreateOperatorPlan(zoneId, conversationId);
  const hasDocuments = draft.documents.length > 0;

  const allRego = useMemo(
    () => draft.documents.map((doc) => doc.content).join("\n\n"),
    [draft.documents],
  );
  const exportJson = useMemo(() => JSON.stringify(draft, null, 2), [draft]);

  function propose() {
    if (!hasDocuments || createPlan.isPending || createPlan.isSuccess) return;
    createPlan.mutate(buildCreatePlan(draft), {
      onSuccess: () =>
        toast({
          tone: "success",
          title: "Create proposed",
          description: "Review and approve the plan to apply it.",
        }),
      onError: (error) =>
        toast({
          tone: "error",
          title: "Could not propose the change",
          description: error instanceof Error ? error.message : "Try again.",
        }),
    });
  }

  function exportDraft() {
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "policy-draft.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  // Each concern the specialist produced becomes one segment of a single-select row, so only the
  // chosen panel occupies vertical space and the artifact stays compact regardless of how much the
  // draft carries. Only segments with content are offered, and the policy itself leads.
  const segments: Segment[] = [];

  if (hasDocuments) {
    segments.push({
      key: "policy",
      label: draft.documents.length === 1 ? "Policy" : "Policies",
      count: draft.documents.length > 1 ? draft.documents.length : undefined,
      panel: (
        <div className="flex flex-col gap-4">
          {draft.documents.map((doc, index) => (
            <DocumentCard key={doc.filename || index} doc={doc} index={index} />
          ))}
        </div>
      ),
    });
  }

  if (draft.risks.length > 0) {
    segments.push({
      key: "risks",
      label: "Risks",
      count: draft.risks.length,
      panel: (
        <ul className="flex flex-col gap-2">
          {draft.risks.map((risk) => (
            <li key={risk.note} className="flex items-start gap-2">
              <Badge tone={RISK_TONE[risk.severity]}>{risk.severity}</Badge>
              <span className="text-xs leading-relaxed text-foreground/90">{risk.note}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (draft.recommendations.length > 0) {
    segments.push({
      key: "leastPrivilege",
      label: "Least privilege",
      count: draft.recommendations.length,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {draft.recommendations.map((rec) => (
            <li key={rec} className="flex gap-2 text-xs text-foreground/90">
              <span className="text-emerald-500">✓</span>
              <span>{rec}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (draft.simulations.length > 0) {
    segments.push({
      key: "simulations",
      label: "Simulations",
      count: draft.simulations.length,
      panel: (
        <div className="flex flex-col gap-2">
          {draft.simulations.map((sim) => (
            <SimulationCard key={sim.name} sim={sim} />
          ))}
        </div>
      ),
    });
  }

  if (draft.assumptions.length > 0) {
    segments.push({
      key: "assumptions",
      label: "Assumptions",
      count: draft.assumptions.length,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {draft.assumptions.map((note) => (
            <li key={note} className="flex gap-2 text-xs text-muted-foreground">
              <span>•</span>
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  if (hasDocuments && draft.clarifications.length > 0) {
    segments.push({
      key: "questions",
      label: "Open questions",
      count: draft.clarifications.length,
      panel: (
        <ul className="flex flex-col gap-1.5">
          {draft.clarifications.map((question) => (
            <li key={question} className="flex gap-2 text-xs text-foreground/90">
              <span className="text-muted-foreground">•</span>
              <span>{question}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  const activation = draft.activation;
  if (activation && (activation.guidance.trim().length > 0 || activation.blockers.length > 0)) {
    segments.push({
      key: "activation",
      label: "Activation",
      panel: (
        <div className="flex flex-col gap-1.5 text-xs">
          {activation.guidance.trim() ? (
            <p className="leading-relaxed text-foreground/90">{activation.guidance}</p>
          ) : null}
          {activation.blockers.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {activation.blockers.map((blocker) => (
                <li key={blocker} className="flex gap-2 text-foreground/80">
                  <span>•</span>
                  <span>{blocker}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-card/60 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-accent-purple">
          <PlanGlyph className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-foreground">Policy draft</span>
            {draft.schemaVersion.length > 0 ? (
              <Badge tone="neutral">schema {draft.schemaVersion}</Badge>
            ) : null}
            {draft.activation ? (
              <Badge tone={draft.activation.ready ? "success" : "warning"}>
                {draft.activation.ready ? "ready to activate" : "not yet ready"}
              </Badge>
            ) : null}
          </div>
          {draft.summary.trim() ? (
            <p className="mt-1 text-sm leading-relaxed text-foreground/90">{draft.summary}</p>
          ) : null}
        </div>
      </div>

      {segments.length > 0 ? (
        <SegmentedTabs segments={segments} />
      ) : draft.clarifications.length > 0 ? (
        <div className="rounded-lg border border-border bg-background/40 p-3">
          <div className="mb-2 text-sm font-medium text-foreground">Needs clarification</div>
          <ul className="flex flex-col gap-1.5">
            {draft.clarifications.map((question) => (
              <li key={question} className="flex gap-2 text-xs text-foreground/90">
                <span className="text-muted-foreground">•</span>
                <span>{question}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
        <Button
          size="sm"
          mutating
          loading={createPlan.isPending}
          disabled={!hasDocuments || createPlan.isSuccess}
          onClick={propose}
        >
          {createPlan.isSuccess
            ? "Plan proposed"
            : draft.documents.length > 1
              ? "Create policies"
              : "Create policy"}
        </Button>
        {hasDocuments ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copy(allRego, { successTitle: "Rego copied" })}
            >
              Copy Rego
            </Button>
            <Button size="sm" variant="secondary" onClick={exportDraft}>
              Export draft
            </Button>
          </>
        ) : null}
        <Link
          to={appLink("/policies", zoneId ?? undefined)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <LinkGlyph className="h-3.5 w-3.5" />
          Open in Console
        </Link>
      </div>
    </div>
  );
}
