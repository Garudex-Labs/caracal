/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the one-time client secret reveal modal shared by the Applications and Run pages.
*/
import { Button, Modal, useCopyToClipboard } from "@/components/ui";

export interface RevealedSecret {
  name: string;
  appId: string;
  clientSecret: string;
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

  return (
    <Modal
      open={secret !== null}
      onClose={onClose}
      title={secret?.rotated ? "Store the new client secret now" : "Store the client secret now"}
      description="This secret is shown once and cannot be retrieved later. Copy it before closing."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secret.clientSecret}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(secret.clientSecret, { onSuccess: onCopied })}
            >
              Copy
            </Button>
          </div>
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            For <code className="font-mono">caracal run</code> workloads, set it as the{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET</code> environment variable or
            store it owner-only (chmod 600) at{" "}
            <code className="break-all font-mono">
              {`<Caracal config dir>/runtime/${secret.appId}/client-secret`}
            </code>
            , where <code className="font-mono">caracal run</code> finds it automatically. For cloud
            or custom deployments, keep it in your secret store and point{" "}
            <code className="font-mono">CARACAL_APP_CLIENT_SECRET_FILE</code> at the mounted file.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
