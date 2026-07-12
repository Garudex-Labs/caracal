/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file defines the Settings Notifications page for managing zone webhook sinks.
*/
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ConfirmModal, SettingsGroup } from "@/components/console/SettingsPanels";
import {
  Badge,
  Button,
  Field,
  Modal,
  Skeleton,
  useCopyToClipboard,
  useToast,
} from "@/components/ui";
import { ConsoleApiError } from "@/platform/api/client";
import {
  useActiveZone,
  useCreateNotificationSink,
  useDeleteNotificationSink,
  useNotificationSinks,
  useRotateSinkSecret,
  useSinkDeliveries,
  useUpdateNotificationSink,
} from "@/platform/api/hooks";
import type { NotificationSink, SinkDelivery } from "@/platform/api/types";
import { config } from "@/platform/config";

export const Route = createFileRoute("/$accountId/$orgId/$zoneId/app/settings/notifications")({
  component: NotificationsPage,
});

// The three moments of an approval hold's life that are worth telling an external system
// about. Issuance is the one that pages someone; the other two close the loop.
const EVENT_TYPE_OPTIONS: { id: string; label: string; detail: string }[] = [
  {
    id: "step_up_issued",
    label: "Approval requested",
    detail: "A hold was raised and a Session is parked on it.",
  },
  {
    id: "step_up_decided",
    label: "Approval decided",
    detail: "Someone approved or rejected the hold.",
  },
  {
    id: "step_up_consumed",
    label: "Token released",
    detail: "An approved hold released its one token.",
  },
];

function eventTypeLabel(id: string): string {
  return EVENT_TYPE_OPTIONS.find((option) => option.id === id)?.label ?? id;
}

function writeErrorMessage(err: unknown): string {
  if (err instanceof ConsoleApiError) {
    if (err.code === "invalid_sink_url")
      return "The endpoint must be HTTPS (plain HTTP is allowed only for loopback).";
    if (err.code === "invalid_sink") return "Some fields are invalid. Check the form.";
    if (err.code === "sink_limit_reached") return "This zone already has the maximum of 20 sinks.";
    if (err.code === "sink_not_found") return "That sink no longer exists.";
    if (err.notConfigured) return "Control plane not connected.";
    if (err.unreachable) return "Control plane unreachable.";
    return err.code;
  }
  return "The change could not be saved. Try again.";
}

function NotificationsPage() {
  const { activeZone } = useActiveZone();
  const zoneId = activeZone?.id ?? null;
  const sinks = useNotificationSinks(zoneId);
  const create = useCreateNotificationSink(zoneId);
  const update = useUpdateNotificationSink(zoneId);
  const rotate = useRotateSinkSecret(zoneId);
  const remove = useDeleteNotificationSink(zoneId);
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [revealed, setRevealed] = useState<{
    name: string;
    secret: string;
    rotated: boolean;
  } | null>(null);
  const [rotating, setRotating] = useState<NotificationSink | null>(null);
  const [deleting, setDeleting] = useState<NotificationSink | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = sinks.data?.rows ?? [];

  async function toggleActive(sink: NotificationSink) {
    try {
      await update.mutateAsync({ id: sink.id, patch: { active: !sink.active } });
      toast({
        tone: "success",
        title: sink.active ? "Sink paused" : "Sink resumed",
        description: sink.active
          ? "Deliveries stop; the sink keeps its place in the event stream."
          : "Deliveries resume from where the sink left off.",
      });
    } catch (err) {
      toast({ tone: "error", title: "Change failed", description: writeErrorMessage(err) });
    }
  }

  return (
    <div>
      <SettingsGroup
        title="Webhook sinks"
        description="Signed, retried webhook deliveries of this zone's approval events. Visibility only, never enforcement."
        action={
          <Button size="sm" mutating disabled={!zoneId} onClick={() => setFormOpen(true)}>
            Add sink
          </Button>
        }
      >
        {!zoneId ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Select a zone to manage its notification sinks.
          </p>
        ) : sinks.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No sinks yet.
          </p>
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {rows.map((sink) => (
              <SinkRow
                key={sink.id}
                sink={sink}
                zoneId={zoneId}
                expanded={expanded === sink.id}
                busy={update.isPending}
                onToggleDeliveries={() => setExpanded(expanded === sink.id ? null : sink.id)}
                onToggleActive={() => void toggleActive(sink)}
                onRotate={() => setRotating(sink)}
                onDelete={() => setDeleting(sink)}
              />
            ))}
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Delivery contract"
        description="Verify each delivery before acting on it."
      >
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Signed JSON POSTs. Verify the{" "}
          <code className="font-mono text-xs">X-Caracal-Signature</code> HMAC, reject stale
          timestamps, and dedupe on <code className="font-mono text-xs">X-Caracal-Delivery</code>.{" "}
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={`${config.docsUrl}/guides/approval-notifications/`}
            target="_blank"
            rel="noreferrer"
          >
            Full contract
          </a>
        </p>
      </SettingsGroup>

      <SinkFormModal
        open={formOpen}
        pending={create.isPending}
        onClose={() => setFormOpen(false)}
        onSubmit={async (input) => {
          try {
            const created = await create.mutateAsync(input);
            setFormOpen(false);
            setRevealed({ name: created.name, secret: created.secret, rotated: false });
          } catch (err) {
            toast({ tone: "error", title: "Create failed", description: writeErrorMessage(err) });
          }
        }}
      />

      <SecretRevealModal revealed={revealed} onClose={() => setRevealed(null)} />

      <ConfirmModal
        open={rotating !== null}
        title="Rotate signing secret"
        description="The current secret stops verifying immediately. Update the receiving endpoint with the new secret, which is shown once after rotation."
        confirmLabel="Rotate secret"
        onClose={() => setRotating(null)}
        onConfirm={async () => {
          if (!rotating) return;
          try {
            const rotated = await rotate.mutateAsync(rotating.id);
            setRevealed({ name: rotated.name, secret: rotated.secret, rotated: true });
          } catch (err) {
            toast({ tone: "error", title: "Rotate failed", description: writeErrorMessage(err) });
          }
        }}
      />

      <ConfirmModal
        open={deleting !== null}
        danger
        title="Delete sink"
        description={`Deliveries to ${deleting?.name ?? "this sink"} stop immediately and its delivery history is removed. The zone audit stream is unaffected.`}
        confirmLabel="Delete sink"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await remove.mutateAsync(deleting.id);
            toast({ tone: "success", title: "Sink deleted" });
          } catch (err) {
            toast({ tone: "error", title: "Delete failed", description: writeErrorMessage(err) });
          }
        }}
      />
    </div>
  );
}

function SinkRow({
  sink,
  zoneId,
  expanded,
  busy,
  onToggleDeliveries,
  onToggleActive,
  onRotate,
  onDelete,
}: {
  sink: NotificationSink;
  zoneId: string;
  expanded: boolean;
  busy: boolean;
  onToggleDeliveries: () => void;
  onToggleActive: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const failing = sink.consecutive_failures > 0;
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{sink.name}</span>
            {!sink.active ? <Badge tone="muted">Paused</Badge> : null}
            {failing ? <Badge tone="warning">{sink.consecutive_failures} failing</Badge> : null}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {sink.url}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {sink.event_types.map((type) => (
              <Badge key={type} tone="neutral">
                {eventTypeLabel(type)}
              </Badge>
            ))}
          </div>
          {failing && sink.last_error ? (
            <p className="mt-1.5 max-w-xl truncate text-[11px] text-amber-700 dark:text-amber-400">
              Last error: {sink.last_error}
            </p>
          ) : sink.last_success_at ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Last delivered {new Date(sink.last_success_at).toLocaleString()}
            </p>
          ) : null}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onToggleDeliveries}>
            {expanded ? "Hide deliveries" : "Deliveries"}
          </Button>
          <Button variant="ghost" size="sm" mutating loading={busy} onClick={onToggleActive}>
            {sink.active ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" size="sm" mutating onClick={onRotate}>
            Rotate secret
          </Button>
          <Button variant="ghost" size="sm" mutating onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      {expanded ? <DeliveryList zoneId={zoneId} sinkId={sink.id} /> : null}
    </div>
  );
}

function deliveryStatus(d: SinkDelivery): {
  label: string;
  tone: "success" | "warning" | "danger";
} {
  if (d.delivered_at)
    return { label: d.response_status ? `${d.response_status}` : "delivered", tone: "success" };
  if (d.abandoned_at) return { label: "abandoned", tone: "danger" };
  return { label: `retrying · attempt ${d.attempts}`, tone: "warning" };
}

function DeliveryList({ zoneId, sinkId }: { zoneId: string; sinkId: string }) {
  const deliveries = useSinkDeliveries(zoneId, sinkId);
  const rows = deliveries.data?.rows ?? [];
  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30">
      {deliveries.isLoading ? (
        <Skeleton className="m-3 h-12" />
      ) : rows.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          No deliveries yet. Events enqueue here the moment matching approval activity occurs.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((d) => {
            const status = deliveryStatus(d);
            return (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2">
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                  {eventTypeLabel(d.event_type)}
                </span>
                {d.last_error && !d.delivered_at ? (
                  <span className="max-w-[240px] truncate text-[11px] text-muted-foreground">
                    {d.last_error}
                  </span>
                ) : null}
                <time
                  dateTime={d.created_at}
                  className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground"
                >
                  {new Date(d.created_at).toLocaleString()}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SinkFormModal({
  open,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; url: string; event_types: string[] }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [types, setTypes] = useState<Set<string>>(
    new Set(EVENT_TYPE_OPTIONS.map((option) => option.id)),
  );

  function toggle(id: string) {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const valid = name.trim().length > 0 && url.trim().length > 0 && types.size > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add webhook sink"
      description="Caracal signs and POSTs matching approval events to this endpoint."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            mutating
            loading={pending}
            disabled={!valid}
            onClick={() =>
              void onSubmit({ name: name.trim(), url: url.trim(), event_types: [...types] })
            }
          >
            Create sink
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="Name"
          placeholder="Pied Piper on-call relay"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Endpoint URL"
          placeholder="https://hooks.hooli.example/caracal-approvals"
          hint="HTTPS required; plain HTTP is allowed only for loopback endpoints during local development."
          value={url}
          maxLength={2048}
          onChange={(e) => setUrl(e.target.value)}
        />
        <div>
          <div className="mb-1.5 text-xs font-medium text-foreground">Events</div>
          <div className="flex flex-col gap-1.5">
            {EVENT_TYPE_OPTIONS.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-2 text-xs text-foreground"
              >
                <input
                  type="checkbox"
                  checked={types.has(option.id)}
                  onChange={() => toggle(option.id)}
                  className="mt-0.5 h-3.5 w-3.5 accent-foreground"
                />
                <span>
                  {option.label}
                  <span className="block text-[11px] text-muted-foreground">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SecretRevealModal({
  revealed,
  onClose,
}: {
  revealed: { name: string; secret: string; rotated: boolean } | null;
  onClose: () => void;
}) {
  const copy = useCopyToClipboard();
  const toast = useToast();
  const [copyClicked, setCopyClicked] = useState(false);
  const close = () => {
    setCopyClicked(false);
    onClose();
  };
  return (
    <Modal
      open={revealed !== null}
      onClose={close}
      dismissible={false}
      title={
        revealed?.rotated ? "Store the new signing secret now" : "Store the signing secret now"
      }
      description="This secret is shown once and cannot be retrieved later. The receiving endpoint uses it to verify the X-Caracal-Signature header. Copy it to unlock Done."
      footer={
        <Button onClick={close} disabled={!copyClicked}>
          Done
        </Button>
      }
    >
      {revealed ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{revealed.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {revealed.secret}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCopyClicked(true);
                void copy(revealed.secret, {
                  onSuccess: () => toast({ tone: "success", title: "Secret copied" }),
                });
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
