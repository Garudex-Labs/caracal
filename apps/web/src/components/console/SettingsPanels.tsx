/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file provides the shared layout primitives the Settings pages compose their content from.
*/
import { useState, type ReactNode } from "react";

import { Button, Modal } from "@/components/ui";

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
        "mt-8 border-t pt-8 first:mt-0 first:border-t-0 first:pt-0",
        danger ? "border-destructive/30" : "border-border",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            className={[
              "text-sm font-semibold tracking-tight",
              danger ? "text-destructive" : "text-foreground",
            ].join(" ")}
          >
            {title}
          </h3>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className="mt-5 min-w-0">{children}</div>
    </section>
  );
}

export function InfoGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-4 rounded-lg border border-border bg-muted/30 p-4 md:grid-cols-3">
      {children}
    </dl>
  );
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
