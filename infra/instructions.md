# infra

## Scope
- Covers only infrastructure configuration under this directory.

## Required
- Must name every subdirectory by a single infrastructure concern.
- Permitted subdirectories: `docker`, `postgres`, `redis`, `healthcheck`,
  `secrets`, `scripts`.
- Must keep concern-specific assets in their own subdirectory.

## Forbidden
- Must not contain service source code (Go or TypeScript).
- Must not contain shared library code.
- Must not duplicate environment configuration already in service directories.
- Must not check in generated secrets, TLS material, or backups; each producing
  directory must gitignore its output.
