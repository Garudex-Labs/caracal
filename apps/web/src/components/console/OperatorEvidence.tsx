/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

The live-state evidence artifact: renders the real objects an Operator answer was grounded in as purpose-built per-domain views instead of prose.
*/
import type { ReactNode } from "react";

import { Badge, SegmentedTabs, type Segment } from "@/components/ui";
import { formatRelative } from "@/platform/operator/view";
import type { BadgeTone } from "@/platform/operator/view";
import type { EvidenceRowView, EvidenceView } from "@/platform/operator/timeline";

// The section label each domain renders under, in the console's own vocabulary.
const DOMAIN_LABELS: Record<string, string> = {
  zone: "Zones",
  application: "Applications",
  provider: "Providers",
  resource: "Resources",
  policy: "Policies",
  grant: "Grants",
  session: "Authority records",
  agent: "Sessions",
  delegation: "Delegations",
  audit: "Audit",
};

function text(row: EvidenceRowView, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function list(row: EvidenceRowView, key: string): string[] {
  const value = row[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value.length > 0 ? [value] : [];
}

function when(row: EvidenceRowView, key: string): string {
  const value = text(row, key);
  return value ? formatRelative(value) : "";
}

// A short mono identifier, truncated from the middle so both the prefix and the distinguishing
// tail stay visible in a narrow cell.
function Mono({ value }: { value: string }) {
  if (!value) return null;
  const shown = value.length > 26 ? `${value.slice(0, 12)}…${value.slice(-8)}` : value;
  return (
    <code title={value} className="font-mono text-[11px] text-muted-foreground">
      {shown}
    </code>
  );
}

function ScopeChips({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <code
          key={scope}
          className="rounded bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground"
        >
          {scope}
        </code>
      ))}
    </span>
  );
}

const STATUS_TONES: Record<string, BadgeTone> = {
  active: "success",
  running: "success",
  completed: "neutral",
  suspended: "warning",
  expired: "muted",
  revoked: "danger",
  terminated: "danger",
};

function StatusBadge({ value }: { value: string }) {
  if (!value) return null;
  return <Badge tone={STATUS_TONES[value] ?? "neutral"}>{value}</Badge>;
}

// The uniform two-column row every domain view is built from: what the object is on the left,
// its qualifiers on the right, so mixed domains in one answer still read as one system.
function Row({ lead, trail }: { lead: ReactNode; trail?: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">{lead}</span>
      {trail ? (
        <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {trail}
        </span>
      ) : null}
    </li>
  );
}

function Name({ value }: { value: string }) {
  return <span className="text-xs font-medium text-foreground">{value}</span>;
}

function ApplicationRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Name value={text(row, "name") || text(row, "id")} />
          {text(row, "registration_method") ? (
            <Badge tone="muted">{text(row, "registration_method")}</Badge>
          ) : null}
        </>
      }
      trail={when(row, "created_at")}
    />
  );
}

function ProviderRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Name value={text(row, "name") || text(row, "id")} />
          {text(row, "kind") ? <Badge tone="muted">{text(row, "kind")}</Badge> : null}
          <Mono value={text(row, "identifier")} />
        </>
      }
      trail={when(row, "created_at")}
    />
  );
}

function ResourceRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Name value={text(row, "name") || text(row, "id")} />
          <Mono value={text(row, "identifier")} />
          <ScopeChips scopes={list(row, "scopes")} />
        </>
      }
      trail={<Mono value={text(row, "upstream_url")} />}
    />
  );
}

function PolicyRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Name value={text(row, "name") || text(row, "id")} />
          {text(row, "description") ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {text(row, "description")}
            </span>
          ) : null}
        </>
      }
      trail={when(row, "created_at")}
    />
  );
}

function GrantRow({ row }: { row: EvidenceRowView }) {
  const app = text(row, "application_name") || text(row, "application_id");
  const resource = text(row, "resource_name") || text(row, "resource_id");
  return (
    <Row
      lead={
        <>
          <Name value={app} />
          <span className="text-[11px] text-muted-foreground">→</span>
          <Name value={resource} />
          <ScopeChips scopes={list(row, "scopes")} />
        </>
      }
      trail={
        <>
          <Mono value={text(row, "user_id")} />
          <StatusBadge value={text(row, "status")} />
        </>
      }
    />
  );
}

function AuthorityRecordRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Mono value={text(row, "subject_id") || text(row, "id")} />
          {text(row, "session_type") ? (
            <Badge tone="muted">{text(row, "session_type")}</Badge>
          ) : null}
          <StatusBadge value={text(row, "status")} />
        </>
      }
      trail={
        text(row, "expires_at")
          ? `expires ${when(row, "expires_at")}`
          : when(row, "authenticated_at")
      }
    />
  );
}

function SessionRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Mono value={text(row, "id")} />
          {text(row, "lifecycle") ? <Badge tone="muted">{text(row, "lifecycle")}</Badge> : null}
          <StatusBadge value={text(row, "status")} />
          <ScopeChips scopes={list(row, "labels")} />
        </>
      }
      trail={
        <>
          {text(row, "depth") ? <span>depth {text(row, "depth")}</span> : null}
          <span>{when(row, "started_at")}</span>
        </>
      }
    />
  );
}

function DelegationRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          <Mono value={text(row, "issuer_application_id")} />
          <span className="text-[11px] text-muted-foreground">→</span>
          <Mono value={text(row, "receiver_application_id")} />
          <ScopeChips scopes={list(row, "scopes")} />
        </>
      }
      trail={
        <>
          <StatusBadge value={text(row, "status")} />
          {text(row, "expires_at") ? <span>expires {when(row, "expires_at")}</span> : null}
        </>
      }
    />
  );
}

const DECISION_TONES: Record<string, BadgeTone> = {
  allow: "success",
  deny: "danger",
};

function AuditRow({ row }: { row: EvidenceRowView }) {
  const decision = text(row, "decision");
  return (
    <Row
      lead={
        <>
          {decision ? <Badge tone={DECISION_TONES[decision] ?? "neutral"}>{decision}</Badge> : null}
          <span className="text-xs font-medium text-foreground">{text(row, "event_type")}</span>
          <Mono value={text(row, "request_id")} />
        </>
      }
      trail={when(row, "occurred_at")}
    />
  );
}

// The generic view for a domain without a dedicated row: every field the server allowlisted,
// rendered as label/value pairs so a future domain still shows real state before it earns a
// purpose-built row.
function GenericRow({ row }: { row: EvidenceRowView }) {
  return (
    <Row
      lead={
        <>
          {Object.entries(row).map(([key, value]) => (
            <span key={key} className="text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground/70">{key.replace(/_/g, " ")}</span>{" "}
              {Array.isArray(value) ? value.join(", ") : value}
            </span>
          ))}
        </>
      }
    />
  );
}

const DOMAIN_ROWS: Record<string, (props: { row: EvidenceRowView }) => ReactNode> = {
  application: ApplicationRow,
  provider: ProviderRow,
  resource: ResourceRow,
  policy: PolicyRow,
  grant: GrantRow,
  session: AuthorityRecordRow,
  agent: SessionRow,
  delegation: DelegationRow,
  audit: AuditRow,
};

function DomainPanel({ entry }: { entry: EvidenceView }) {
  const label = DOMAIN_LABELS[entry.domain] ?? entry.domain;
  if (entry.count === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No {label.toLowerCase()} in this zone.
      </p>
    );
  }
  const DomainRow = DOMAIN_ROWS[entry.domain] ?? GenericRow;
  return (
    <div className="flex flex-col">
      <ul className="divide-y divide-border">
        {entry.rows.map((row, index) => (
          <DomainRow key={index} row={row} />
        ))}
      </ul>
      {entry.count > entry.rows.length ? (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing {entry.rows.length} of {entry.count}.
        </p>
      ) : null}
    </div>
  );
}

// Renders the live state an answer was grounded in as a compact artifact: one panel per domain the
// turn read, switched with the standard segmented control when several domains contributed. Each
// panel is a purpose-built view of its domain - applications with their registration, providers with
// their kind, grants as who-can-reach-what, audit as decisions - so an answer about the deployment
// shows the deployment itself, not a paraphrase of it.
export function OperatorEvidence({ entries }: { entries: EvidenceView[] }) {
  if (entries.length === 0) return null;
  const segments: Segment[] = entries.map((entry) => ({
    key: `${entry.capability}:${entry.domain}`,
    label: DOMAIN_LABELS[entry.domain] ?? entry.domain,
    count: entry.count,
    panel: (
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <DomainPanel entry={entry} />
      </div>
    ),
  }));
  if (segments.length === 1) {
    const single = entries[0];
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
            {DOMAIN_LABELS[single.domain] ?? single.domain}
          </span>
          <span className="text-[11px] text-muted-foreground">{single.count}</span>
        </div>
        <DomainPanel entry={single} />
      </div>
    );
  }
  return <SegmentedTabs segments={segments} />;
}
