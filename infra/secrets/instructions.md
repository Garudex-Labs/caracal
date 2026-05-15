# caracal/secrets

## Scope
- Covers only the secret-file layout consumed by the Caracal compose stack and
  Kubernetes manifests under `caracal/infra/`.

## Required
- Must generate dev secrets via `pnpm secrets:init`; output lands in `files/`.
- Must keep the `files/` directory gitignored at all times.
- Must use cryptographically random hex strings for every key/password (Node's `crypto.randomBytes`).
- Must use 0444 permissions on every generated secret file (Compose v2 ignores `mode:` for file-based secrets — the file is bind-mounted with its host permissions; the parent `files/` directory is 0700, so reads stay scoped to the host owner). Production deployments must source secrets from an external manager instead.

## Forbidden
- Must not commit the contents of `files/` to git.
- Must not bake secrets into images.
- Must not log or echo secret material from any script in this directory.
