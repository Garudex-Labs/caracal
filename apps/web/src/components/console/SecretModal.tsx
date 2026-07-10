/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the credential custody modal shared by the Applications and Launcher pages.
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
  const [visible, setVisible] = useState(false);
  const label = secret?.kind === "workload" ? "Workload secret" : "Client secret";
  const close = () => {
    setVisible(false);
    onClose();
  };

  return (
    <Modal
      open={secret !== null}
      onClose={close}
      title={secret?.rotated ? `New ${label.toLowerCase()} stored` : `${label} stored`}
      description="Sealed in the Secret Store. Reveal it here any time; every reveal is audited."
      footer={<Button onClick={close}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {visible ? secret.value : "\u2022".repeat(24)}
            </code>
            <Button variant="secondary" size="sm" onClick={() => setVisible((v) => !v)}>
              {visible ? "Hide" : "Reveal"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(secret.value, { onSuccess: onCopied })}
            >
              Copy
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {secret.kind === "workload"
              ? "caracal run reads it from CARACAL_WORKLOAD_SECRET or the runtime secret file."
              : "Point the SDK's credential source at it."}
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
