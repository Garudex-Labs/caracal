// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Aggregates JSONL findings and the release manifest into a markdown post-release validation report.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Finding = {
  area: string;
  artifact: string;
  platform: string;
  pm: string;
  runtime: string;
  severity: "blocker" | "major" | "minor" | "info";
  status: "pass" | "warn" | "fail";
  evidence: string;
  repro: string;
};

type Manifest = {
  release: string;
  publishedAt: string;
  registry?: string;
  imagePrefix?: string;
  binaries: Record<string, string>;
  containers: Record<string, string>;
  pypi: Record<string, string>;
  npm: Record<string, string>;
};

const findingsDir = process.env.FINDINGS_DIR;
const outPath = process.env.REPORT_OUT;
const release = process.env.CARACAL_RELEASE;
const manifestPath = process.env.MANIFEST;
if (!findingsDir || !outPath || !release || !manifestPath) {
  console.error("FINDINGS_DIR, REPORT_OUT, CARACAL_RELEASE, MANIFEST required");
  process.exit(2);
}

const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.release !== release) {
  console.error(`manifest release ${manifest.release} does not match ${release}`);
  process.exit(2);
}
const registry = manifest.registry ?? "ghcr.io/garudex-labs";
const imagePrefix = manifest.imagePrefix ?? "caracal-";

const AREAS = [
  ["registryMetadata", "Registry Metadata"],
  ["pypiInstall", "PyPI Install Matrix"],
  ["npmInstall", "npm Install Matrix"],
  ["shellBinaries", "Shell Binaries"],
  ["cliBinaries", "CLI Binaries"],
  ["tuiBinaries", "TUI Binaries"],
  ["installers", "Installers"],
  ["containers", "Container Stack"],
  ["provenance", "Provenance & Signing"],
  ["examples", "Docs & Examples"],
] as const;

const collectFindingFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return collectFindingFiles(path);
    return entry.endsWith(".jsonl") ? [path] : [];
  });

const findings: Finding[] = [];
for (const f of collectFindingFiles(findingsDir)) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (!line.trim()) continue;
    findings.push(JSON.parse(line));
  }
}

const tally = (area: string) => {
  const rows = findings.filter((r) => r.area === area);
  return {
    pass: rows.filter((r) => r.status === "pass").length,
    warn: rows.filter((r) => r.status === "warn").length,
    fail: rows.filter((r) => r.status === "fail").length,
    blockers: rows.filter((r) => r.severity === "blocker" && r.status === "fail").length,
  };
};

let totalPass = 0, totalFail = 0, totalWarn = 0, totalBlockers = 0;
const tableRows = AREAS.map(([id, label]) => {
  const t = tally(id);
  totalPass += t.pass; totalFail += t.fail; totalWarn += t.warn; totalBlockers += t.blockers;
  return `| ${label} | ${t.pass} | ${t.warn} | ${t.fail} | ${t.blockers} |`;
}).join("\n");

const totalChecks = totalPass + totalFail + totalWarn;
const score = totalChecks === 0 ? 0 : Math.round((totalPass / totalChecks) * 100);

const compat = (() => {
  const row = (name: string, ver: string) => `| \`${name}\` | ${ver} |`;
  const sec = (title: string, entries: Record<string, string>) =>
    `### ${title}\n\n| Artifact | Version |\n| --- | --- |\n${Object.entries(entries).map(([k, v]) => row(k, v)).join("\n")}\n`;
  const containerView: Record<string, string> = {};
  for (const [svc, ver] of Object.entries(manifest.containers)) {
    containerView[`${registry}/${imagePrefix}${svc}`] = `v${ver}`;
  }
  return [
    sec("CLI / TUI binaries", manifest.binaries),
    sec(`Container images (${registry})`, containerView),
    sec("PyPI packages", manifest.pypi),
    sec("npm packages", manifest.npm),
  ].join("\n");
})();

const sections = AREAS.map(([id, label]) => {
  const rows = findings.filter((r) => r.area === id);
  if (rows.length === 0) return `### ${label}\n\n_No findings recorded._\n`;
  const lines = rows.map(
    (r) => `- **[${r.severity}]** ${r.status.toUpperCase()} — \`${r.artifact}\` (${r.platform}/${r.pm}/${r.runtime}): ${r.evidence}\n  - Repro: \`${r.repro}\``,
  );
  return `### ${label}\n\n${lines.join("\n")}\n`;
}).join("\n");

const failed = findings.filter((r) => r.status === "fail");
const topFixes = failed
  .sort((a, b) => {
    const order = { blocker: 0, major: 1, minor: 2, info: 3 };
    return order[a.severity] - order[b.severity];
  })
  .slice(0, 10)
  .map((r, i) => `${i + 1}. **[${r.severity}]** \`${r.artifact}\` — ${r.evidence}`)
  .join("\n");

const md = `---
title: ${release} Release Validation Report
---

# Caracal ${release} Release Validation

**Published:** ${manifest.publishedAt}
**Ecosystem quality score:** ${score}% (pass / total checks)
**Total blockers:** ${totalBlockers}

## Compatibility matrix

${compat}

## Summary

| Area | Pass | Warn | Fail | Blockers |
| --- | --- | --- | --- | --- |
${tableRows}

## Severity rubric

- **blocker** — artifact is unusable for consumers (download fails, install errors, signature invalid)
- **major** — published but a contract is broken (wrong version, missing export, broken healthcheck)
- **minor** — cosmetic or documentation issue
- **info** — informational only

## Findings

${sections}

## Highest priority fixes

${topFixes || "_No failing findings._"}

## Sign-off

- [ ] Compatibility matrix matches GitHub Release assets
- [ ] Registry metadata reviewed
- [ ] PyPI install matrix green
- [ ] npm install matrix green
- [ ] CLI / TUI binaries verified on all platforms
- [ ] Installers verified
- [ ] Containers boot cleanly
- [ ] Provenance verified
- [ ] Examples run against released packages
`;

const releaseDir = dirname(outPath);
mkdirSync(releaseDir, { recursive: true });
writeFileSync(outPath, md);

const persistedFindingsDir = join(releaseDir, "findings");
rmSync(persistedFindingsDir, { recursive: true, force: true });
mkdirSync(persistedFindingsDir, { recursive: true });
for (const [area] of AREAS) {
  const rows = findings.filter((r) => r.area === area);
  if (rows.length === 0) continue;
  writeFileSync(
    join(persistedFindingsDir, `${area}.jsonl`),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );
}

console.log(`wrote ${outPath} (${findings.length} findings, score ${score}%)`);
process.exit(totalBlockers > 0 ? 1 : 0);
