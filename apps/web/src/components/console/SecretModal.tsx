/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the one-time secret reveal modal shared by the Applications and Launcher pages.
*/
import { useState } from "react";

import { Button, Modal, useCopyToClipboard } from "@/components/ui";

export interface RevealedSecret {
  kind: "application" | "workload";
  name: string;
  id: string;
  value: string;
  rotated: boolean;
}

export function SecretModal({
  secret,
  onClose,
  onCopied,
}: {
  secret: RevealedSecret | null;
  onClose: () => void;
  onCopied: () => void;
}) {
  const copy = useCopyToClipboard();
  const [copyClicked, setCopyClicked] = useState(false);
  const label = secret?.kind === "workload" ? "workload secret" : "client secret";
  const close = () => {
    setCopyClicked(false);
    onClose();
  };

  return (
    <Modal
      open={secret !== null}
      onClose={close}
      dismissible={false}
      title={secret?.rotated ? `Store the new ${label} now` : `Store the ${label} now`}
      description="This secret is shown once and cannot be retrieved later. Copy it to unlock Done."
      footer={
        <Button onClick={close} disabled={!copyClicked}>
          Done
        </Button>
      }
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secret.value}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setCopyClicked(true);
                void copy(secret.value, { onSuccess: onCopied });
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
