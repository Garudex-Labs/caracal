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

  --dry-run   Print the planned tag, apply pending changesets, write a manifest, show the diff, then revert local changes.

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
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
        say_error "release: local main does not match origin/main after pull"
        exit 1
    fi
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
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
    say_error "release: remote tag already exists: ${tag}"
    exit 1
fi

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
  "packages/oauth/python/pyproject.toml",
  "packages/identity/python/pyproject.toml",
  "packages/revocation/python/pyproject.toml",
  "packages/sdk/python/pyproject.toml",
  "packages/transport/mcp/python/pyproject.toml",
  "packages/connectors/fastmcp/python/pyproject.toml",
  "packages/connectors/redis/python/pyproject.toml",
];
const containers = ["api", "coordinator", "control", "audit", "gateway", "sts", "postgres", "redis"];

function helmChartVersion(value) {
  const [core, pre] = value.split("-", 2);
  const parts = core.split(".");
  const recut = parts[3];
  const base = `${Number(parts[0])}.${Number(parts[1])}.${Number(parts[2])}`;
  return `${base}${pre ? `-${pre}` : ""}${recut ? `+${recut}` : ""}`;
}

function replaceRequired(path, text, pattern, replacement) {
  if (!pattern.test(text)) throw new Error(`missing expected release field in ${path}`);
  return text.replace(pattern, replacement);
}

function assertNoDevVersions(group, values) {
  for (const [name, value] of Object.entries(values)) {
    if (/dev\.sha|dev\./.test(value)) throw new Error(`${group} ${name} has dev version ${value}`);
  }
}

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
assertNoDevVersions("npm", npm);
assertNoDevVersions("pypi", pypi);
const chartVersion = helmChartVersion(version);
const chartPath = "infra/helm/caracal/Chart.yaml";
const valuesPath = "infra/helm/caracal/values.yaml";
const chart = replaceRequired(
  chartPath,
  replaceRequired(chartPath, readFileSync(chartPath, "utf8"), /^version: .*/m, `version: ${chartVersion}`),
  /^appVersion: .*/m,
  `appVersion: "${version}"`,
);
const values = replaceRequired(valuesPath, readFileSync(valuesPath, "utf8"), /^  tag: .*/m, `  tag: "${version}"`);
writeFileSync(chartPath, chart);
writeFileSync(valuesPath, values);
const manifest = {
  release,
  mode: "stable",
  publishedAt,
  binaries: { shell: version, console: version },
  runtimeImage: version,
  containers: Object.fromEntries(containers.map((name) => [name, version])),
  helm: { chartVersion, appVersion: version, imageTag: version },
  pypi,
  npm,
};
const out = `releases/${release}/manifest.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
}

assertReleaseCommit() {
    local files
    test -f "releases/$tag/manifest.json" || { say_error "release: manifest missing for ${tag}"; exit 1; }
    node scripts/validateReleaseManifest.mjs "releases/$tag/manifest.json"
    files="$(git diff-tree --no-commit-id --name-only -r HEAD)"
    grep -Fx "releases/$tag/manifest.json" <<<"$files" >/dev/null || {
        say_error "release: release commit must include releases/$tag/manifest.json"
        exit 1
    }
    grep -Fx "infra/helm/caracal/Chart.yaml" <<<"$files" >/dev/null || {
        say_error "release: release commit must include stamped Helm Chart.yaml"
        exit 1
    }
    grep -Fx "infra/helm/caracal/values.yaml" <<<"$files" >/dev/null || {
        say_error "release: release commit must include stamped Helm values.yaml"
        exit 1
    }
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
    git --no-pager diff -- '**/package.json' '**/pyproject.toml' 'infra/helm/caracal/Chart.yaml' 'infra/helm/caracal/values.yaml' "releases/$tag/manifest.json"
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
assertReleaseCommit
git tag -a "${tag}" -m "${tag}"
if ! git push --atomic origin main "refs/tags/${tag}"; then
    say_error "release: atomic push failed; main and ${tag} were not both accepted"
    say_info "Check branch protection, tag protection, and whether ${tag} appeared remotely before retrying."
    exit 1
fi

say_success "pushed ${tag}"
say_info "GitHub Actions will publish GHCR images, release archives, and the GitHub Release"
say_info "Publish npm and PyPI packages with protected publishNpm.yml and publishPypi.yml workflows"
say_label "monitor at https://github.com/Garudex-Labs/caracal/actions"
