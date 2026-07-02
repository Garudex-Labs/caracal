// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Detects credential-shaped values in a draft message so the composer can warn before sending.

export interface SecretFinding {
  label: string;
  masked: string;
}

// Keeps a short prefix and suffix so the operator can recognize which value tripped the guard
// without the finding itself restating the secret.
function mask(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= 12) return `${flat.slice(0, 2)}${"*".repeat(Math.max(flat.length - 2, 4))}`;
  return `${flat.slice(0, 4)}${"*".repeat(6)}${flat.slice(-4)}`;
}

interface SecretPattern {
  label: string;
  pattern: RegExp;
  // Which capture group holds the secret value; the whole match when absent.
  group?: number;
}

// Ordered from most to least specific so a value is reported under its most precise label. Every
// pattern targets a credential shape, not a word: prose about "the API key" never matches, only a
// value that looks like one.
const PATTERNS: SecretPattern[] = [
  {
    label: "Private key (PEM)",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { label: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    label: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g },
  { label: "Secret key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { label: "Bearer token", pattern: /\bBearer\s+([A-Za-z0-9._+/=-]{16,})/gi, group: 1 },
  {
    label: "Assigned credential",
    pattern:
      /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|secret|token|password|passwd|pwd)\b["']?\s*[:=]\s*["']?([^\s"',;]{8,})/gi,
    group: 1,
  },
  { label: "Hex secret", pattern: /\b[0-9a-fA-F]{32,}\b/g },
  { label: "Encoded secret", pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g },
];

// Scans a draft message for credential-shaped values. Purely lexical and local: nothing leaves
// the browser, and a match is a caution for the operator to review, never a hard block.
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const { label, pattern, group } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = group !== undefined ? match[group] : match[0];
      if (!value || seen.has(value)) continue;
      // A fragment of an already-reported value (a JWT segment, the tail of an assignment) is the
      // same secret, not a second one.
      if ([...seen].some((prior) => prior.includes(value))) continue;
      seen.add(value);
      findings.push({ label, masked: mask(value) });
      if (findings.length >= 8) return findings;
    }
  }
  return findings;
}
