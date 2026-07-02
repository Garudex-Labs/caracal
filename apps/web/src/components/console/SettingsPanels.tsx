/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared layout primitives the Settings pages compose their content from.
*/
import { useState, type ReactNode } from "react";

import { Button, Modal, Tooltip } from "@/components/ui";

export function SettingsGroup({
  title,
  description,
  action,
  children,
  danger = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section
      className={[
        "grid gap-5 border-t py-8 first:border-t-0 first:pt-8 last:pb-8 2xl:grid-cols-[minmax(220px,300px)_minmax(0,1fr)]",
        danger ? "border-destructive/30" : "border-border",
      ].join(" ")}
    >
      <div>
        <div className="flex items-center gap-2">
          <h3
            className={[
              "text-sm font-semibold",
              danger ? "text-destructive" : "text-foreground",
            ].join(" ")}
          >
            {title}
          </h3>
          {description ? <HelpTip label={description} /> : null}
        </div>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function HelpTip({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <span
        tabIndex={0}
        aria-label="More information"
        className="inline-grid h-5 w-5 place-items-center rounded-full border border-border text-[11px] font-semibold text-muted-foreground outline-none transition-colors hover:border-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        ?
      </span>
    </Tooltip>
  );
}

export function InfoGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-3 border border-border bg-card p-4 md:grid-cols-3">{children}</dl>;
}

export function InfoItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={["mt-1 truncate text-sm text-foreground", mono ? "font-mono text-xs" : ""].join(
          " ",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
  danger = false,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
