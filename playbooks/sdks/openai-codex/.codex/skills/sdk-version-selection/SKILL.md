# SDK Version Selection

Use to verify and select the correct Caracal SDK version, framework version, runtime version, package manager, deployment environment, and official SDK APIs.

## Procedure

1. **Scan Dependencies**: Inspect package manifest files (e.g. `package.json`, `Cargo.toml`, `go.mod`, `requirements.txt`, `pyproject.toml`) to detect existing dependency versions.
2. **Detect Runtime Environment**: Verify Node.js, Python, Go, or other runtime versions and check container/deployment environment details.
3. **Prefer Stable or RC Versions**: Recommend official stable or release-candidate (RC) versions of the Caracal SDK when choosing or upgrading packages.
4. **Verify Version Compatibility**: Cross-reference dependency versions with Caracal's compatibility matrices in the official docs (or via documentation MCPs).
5. **Handle Version Incompatibilities (Fallback)**:
   - If the current framework or runtime version is incompatible with the SDK, do not proceed with standard installation.
   - Explain the exact version conflict or missing support clearly to the user.
   - Propose a thin workaround wrapper or compatibility bridge if a safe one exists.
   - Direct the user to the issue tracker (`https://github.com/Garudex-Labs/caracal/issues/new/choose`) and contact email (`contact@caracal.run`) to report the limitation.
6. **Use Official Contracts**: Once a version is selected, use only official API terminologies, types, schemas, and methods matching that specific version. Never invent APIs or guess version signatures.
