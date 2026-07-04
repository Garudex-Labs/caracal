/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file renders the one-time secret reveal modal shared by the Applications and Launcher pages.
*/
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
  const label = secret?.kind === "workload" ? "workload secret" : "client secret";

  return (
    <Modal
      open={secret !== null}
      onClose={onClose}
      title={secret?.rotated ? `Store the new ${label} now` : `Store the ${label} now`}
      description="This secret is shown once and cannot be retrieved later. Copy it before closing."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {secret ? (
        <div className="flex flex-col gap-3">
          <div className="text-sm text-muted-foreground">{secret.name}</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
              {secret.value}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(secret.value, { onSuccess: onCopied })}
            >
              Copy
            </Button>
          </div>
          {secret.kind === "workload" ? (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Set it as the <code className="font-mono">CARACAL_WORKLOAD_SECRET</code> environment
              variable or store it owner-only (chmod 600) at{" "}
              <code className="break-all font-mono">
                {`<Caracal config dir>/runtime/${secret.id}/secret`}
              </code>
              , where <code className="font-mono">caracal run</code> finds it automatically. For
              cloud or custom deployments, keep it in your secret store and point{" "}
              <code className="font-mono">CARACAL_WORKLOAD_SECRET_FILE</code> at the mounted file.
            </p>
          ) : (
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              Provide it to your service as{" "}
              <code className="font-mono">CARACAL_APP_CLIENT_SECRET</code> alongside{" "}
              <code className="font-mono">CARACAL_APPLICATION_ID</code> so the Caracal SDK can
              authenticate as this application. Keep it in your secret store; only a hash is
              retained server-side.
            </p>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
