#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Cuts a stable Caracal release: applies pending changesets, computes the next CalVer tag (vYYYY.MM.DD with .N suffix on same-day re-cuts), tags HEAD, and pushes branch + tag.

set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck source=lib/style.sh
. "scripts/lib/style.sh"

mode="release"
for arg in "$@"; do
    case "$arg" in
        --dry-run) mode="dryrun" ;;
        -h|--help)
            cat <<EOF
Usage: scripts/release.sh [--dry-run]

  --dry-run   Print the planned tag, run \`changeset version\`, run \`changeset publish --dry-run\`, then revert local changes.

Tag format: vYYYY.MM.DD (with .N suffix on additional cuts the same day).
Per-package versions follow semver and are bumped by Changesets.
Use scripts/rc.sh for rc.
EOF
            exit 0
            ;;
        *) say_error "release: unknown arg: $arg"; exit 2 ;;
    esac
done

if [[ -n "$(git status --porcelain)" ]]; then
    say_error "release: working tree is dirty; commit or stash before releasing"
    exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" && "$mode" != "dryrun" ]]; then
    say_error "release: must run from main (current: ${branch})"
    exit 1
fi

git fetch --tags --quiet origin
if [[ "$mode" == "release" ]]; then
    git pull --ff-only origin main
fi

today="$(date -u +%Y.%m.%d)"
prefix="v${today}"
max_suffix=-1
while IFS= read -r existing; do
    suffix="${existing#${prefix}}"
    if [[ -z "$suffix" ]]; then
        (( max_suffix < 0 )) && max_suffix=0
    elif [[ "$suffix" =~ ^\.([0-9]+)$ && "${BASH_REMATCH[1]}" -gt "$max_suffix" ]]; then
        max_suffix="${BASH_REMATCH[1]}"
    fi
done < <(git tag --list "${prefix}*")
if (( max_suffix < 0 )); then
    tag="$prefix"
else
    tag="${prefix}.$((max_suffix + 1))"
fi
version="${tag#v}"

pending="$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l | tr -d ' ')"

say_header "release: ${tag}"
say_info "${pending} pending changeset(s)"

writeManifest() {
    local dir="releases/$tag"
    if [[ -e "$dir/manifest.json" ]]; then
        say_error "release: manifest already exists: $dir/manifest.json"
        exit 1
    fi

    mkdir -p "$dir"
    RELEASE="$tag" VERSION="$version" PUBLISHED_AT="$today" node <<'NODE'
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");

const release = process.env.RELEASE;
const version = process.env.VERSION;
const publishedAt = process.env.PUBLISHED_AT;

const npmPaths = [
  "packages/core/ts/package.json",
  "packages/oauth/ts/package.json",
  "packages/admin/ts/package.json",
  "packages/identity/ts/package.json",
  "packages/revocation/ts/package.json",
  "packages/sdk/ts/package.json",
  "packages/transport/mcp/ts/package.json",
  "packages/transport/a2a/ts/package.json",
  "packages/connectors/express/ts/package.json",
  "packages/connectors/fastmcp/ts/package.json",
  "packages/connectors/postgres/ts/package.json",
  "packages/connectors/redis/ts/package.json",
];
const pyPaths = [
  "packages/core/python/pyproject.toml",
  "packages/identity/python/pyproject.toml",
  "packages/revocation/python/pyproject.toml",
  "packages/sdk/python/pyproject.toml",
  "packages/transport/mcp/python/pyproject.toml",
  "packages/connectors/fastmcp/python/pyproject.toml",
  "packages/connectors/redis/python/pyproject.toml",
];
const containers = ["api", "coordinator", "audit", "gateway", "sts", "postgres", "redis"];

const npm = Object.fromEntries(
  npmPaths.map((path) => {
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    return [pkg.name, pkg.version];
  }),
);
const pypi = Object.fromEntries(
  pyPaths.map((path) => {
    const text = readFileSync(path, "utf8");
    const name = text.match(/^name = "([^"]+)"/m)?.[1];
    const pkgVersion = text.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !pkgVersion) throw new Error(`missing name or version in ${path}`);
    return [name, pkgVersion];
  }),
);
const manifest = {
  release,
  mode: "stable",
  publishedAt,
  binaries: { shell: version, terminal: version },
  containers: Object.fromEntries(containers.map((name) => [name, version])),
  pypi,
  npm,
};
const out = `releases/${release}/manifest.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

if [[ "$mode" == "dryrun" ]]; then
    if [[ "$pending" != "0" ]]; then
        pnpm changeset status
        pnpm changeset version
    else
        say_info "initial release; no changesets to apply"
    fi
    writeManifest
    say_step "dry-run release diff"
    git --no-pager diff -- '**/package.json' '**/pyproject.toml' "releases/$tag/manifest.json"
    git restore --worktree --staged .
    git clean -fd -- .changeset packages apps releases
    if [[ -n "$(git status --porcelain)" ]]; then
        say_error "dry-run: revert failed; working tree is not clean"
        exit 1
    fi
    say_success "dry-run complete; no commits made"
    exit 0
fi

if [[ "$pending" != "0" ]]; then
    pnpm changeset version
fi
writeManifest

git add -A
if ! git diff --cached --quiet; then
    git commit -m "release: ${tag}"
fi
git tag -a "${tag}" -m "${tag}"
git push origin main
git push origin "${tag}"

say_success "pushed ${tag}"
say_info "GitHub Actions will publish GHCR images, release archives, and the GitHub Release"
say_info "Publish npm and PyPI packages with scripts/publishNpm.sh and .github/workflows/publishPypi.yml"
say_label "monitor at https://github.com/Garudex-Labs/caracal/actions"
