#!/usr/bin/env bash
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Cuts a Caracal release: applies pending changesets, computes the next CalVer tag (vYYYY.MM.DD with .N suffix on same-day re-cuts), tags HEAD, and pushes branch + tag.

set -euo pipefail

cd "$(dirname "$0")/.."

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
EOF
            exit 0
            ;;
        *) echo "release: unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [[ -n "$(git status --porcelain)" ]]; then
    echo "release: working tree is dirty; commit or stash before releasing" >&2
    exit 1
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$branch" != "main" && "$mode" != "dryrun" ]]; then
    echo "release: must run from main (current: ${branch})" >&2
    exit 1
fi

git fetch --tags --quiet origin || true
if [[ "$mode" == "release" ]]; then
    git pull --ff-only origin main
fi

today="$(date -u +%Y.%m.%d)"
prefix="v${today}"
suffix=""
n=1
while git rev-parse --quiet --verify "refs/tags/${prefix}${suffix}" >/dev/null; do
    n=$((n+1))
    suffix=".${n}"
done
tag="${prefix}${suffix}"

pending="$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name 'instructions.md' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$pending" == "0" ]]; then
    echo "release: no pending changesets in .changeset/" >&2
    echo "release: run \`pnpm changeset\` on each PR that touches a published package" >&2
    exit 1
fi

echo "release: planned tag = ${tag}"
echo "release: ${pending} pending changeset(s)"

if [[ "$mode" == "dryrun" ]]; then
    pnpm changeset status
    pnpm changeset version
    echo "release: --- dry-run package version preview ---"
    git --no-pager diff -- '**/package.json'
    git checkout -- .
    git clean -fd .changeset/ packages/ apps/
    echo "release: dry-run complete; no commits made"
    exit 0
fi

pnpm changeset version

git add -A
git commit -m "release: ${tag}"
git tag -a "${tag}" -m "${tag}"
git push origin main
git push origin "${tag}"

echo "release: pushed ${tag}; GitHub Actions will publish npm, PyPI, GHCR images, and the GitHub Release."
echo "release: monitor at https://github.com/Garudex-Labs/caracal/actions"
