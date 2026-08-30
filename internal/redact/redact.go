// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package redact strips API keys, tokens, passwords, and other secrets from
// transcript text before storage.
//
// Redaction is part of the stored-row contract pinned by the golden fixtures
// in contracts/session-goldens: every service that ingests transcripts must
// scrub identically. The rules avoid over-stripping:
//
//	REDACTED:  OPENAI_KEY=sk-proj-abc123...   ->  OPENAI_KEY=**REDACTED**
//	KEPT:      $OPENAI_KEY                    ->  $OPENAI_KEY  (reference)
//	KEPT:      os.environ["OPENAI_KEY"]       ->  unchanged   (code pattern)
package redact

import (
	"regexp"
	"strings"
)

// Redacted replaces every matched secret.
const Redacted = "**REDACTED**"

// Known API key value shapes - near-zero false-positive rate. The whole
// match is the secret.
var reKnownKeys = regexp.MustCompile(strings.Join([]string{
	`sk-(?:proj-)?[a-zA-Z0-9\-_]{20,}`,             // OpenAI
	`sk-ant-[a-zA-Z0-9\-_]{20,}`,                   // Anthropic
	`[prs]k_(?:live|test)_[a-zA-Z0-9]{20,}`,        // Stripe
	`gh[pousr]_[a-zA-Z0-9]{36,}`,                   // GitHub
	`glpat-[a-zA-Z0-9\-_]{20,}`,                    // GitLab PAT
	`xox[bpsa]-[a-zA-Z0-9\-]{10,}`,                 // Slack
	`AKIA[A-Z0-9]{16}`,                             // AWS access key id
	`npm_[a-zA-Z0-9]{36,}`,                         // npm
	`pypi-[a-zA-Z0-9]{50,}`,                        // PyPI
	`SG\.[a-zA-Z0-9\-_]{22,}\.[a-zA-Z0-9\-_]{22,}`, // SendGrid
	`SK[a-f0-9]{32}`,                               // Twilio
	`key-[a-zA-Z0-9]{32}`,                          // Mailgun
	`hf_[a-zA-Z0-9]{34,}`,                          // HuggingFace
	`vercel_[a-zA-Z0-9\-_]{24,}`,                   // Vercel
	`sbp_[a-zA-Z0-9]{40,}`,                         // Supabase
	`AGE-SECRET-KEY-[A-Z0-9]{59}`,                  // age
	`AIza[a-zA-Z0-9\-_]{35}`,                       // Google AI / Gemini
}, "|"))

// AWS secret keys are bare 40-char base64-ish values; require assignment-like
// delimiters on both sides to stay narrow. The delimiters are captured (not
// asserted) so replacement preserves them; the scan loops to a fixed point so
// a consumed trailing delimiter cannot hide an adjacent match.
var reAWSSecret = regexp.MustCompile(`([=:\s"'])([a-zA-Z0-9/+]{40})(["';\s,}]|$)`)

// JWTs: three base64url segments separated by dots.
var reJWT = regexp.MustCompile(`eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}`)

// PEM private key blocks.
var rePrivateKey = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]+-----END [A-Z ]*PRIVATE KEY-----`)

// Key/value assignments where the key name signals a secret. The value (and
// only the value) is replaced. Guards that a preceding "$", "${", or "//"
// suppresses the match are enforced in code, since they concern text before
// the match start.
const secretKeyNames = `(?:api[_\-]?key|api[_\-]?secret|secret[_\-]?key|auth[_\-]?token|` +
	`access[_\-]?token|private[_\-]?key|(?:db[_\-]?)?password|passwd|` +
	`(?:auth|api|access|refresh|bearer|session|jwt)[_\-]?token|` +
	`client[_\-]?secret|signing[_\-]?key|encryption[_\-]?key|` +
	`db[_\-]?password|redis[_\-]?password|database[_\-]?password|` +
	`webhook[_\-]?secret|secret|credentials?)`

var reKeyValue = regexp.MustCompile(`(?i)["']?` + secretKeyNames + `["']?\s*[=:]\s*` +
	`(?:"([^"\n]{8,})"|'([^'\n]{8,})'|([^\s"'\n,;}{]{8,}))`)

// Connection strings: redact only the password segment.
var reConnString = regexp.MustCompile(
	`((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqps?|mssql)://[^:]+:)([^@\s]{4,})(@)`)

// Authorization-style headers: redact only the token.
var reAuthHeader = regexp.MustCompile(
	`(?i)((?:Authorization|X-API-Key|X-Auth-Token)\s*:\s*(?:Bearer\s+)?)([a-zA-Z0-9+/=\-_.]{16,})`)

// quickPrefixes short-circuits the known-key scan: if none occur in the text,
// no known API key can match.
var quickPrefixes = []string{
	"sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghs_", "ghu_", "glpat-",
	"xox", "AKIA", "npm_", "pypi-", "SG.", "hf_", "vercel_", "sbp_",
	"AGE-SECRET", "AIza", "key-",
}

// Secrets redacts secret material from text while preserving surrounding
// content. Safe on arbitrary strings and idempotent.
func Secrets(text string) string {
	if len(text) < 8 || text == Redacted {
		return text
	}

	// 1. PEM private keys (replace the entire block).
	text = rePrivateKey.ReplaceAllString(text, Redacted)

	// 2. Known API key values.
	if containsAny(text, quickPrefixes) {
		text = reKnownKeys.ReplaceAllString(text, Redacted)
	}
	text = replaceToFixedPoint(text, func(s string) string {
		return reAWSSecret.ReplaceAllString(s, "${1}"+Redacted+"${3}")
	})

	// 3. JWTs.
	text = reJWT.ReplaceAllString(text, Redacted)

	// 4. Secret-named assignments: replace the value, keep the key. Loops to
	// a fixed point because one assignment can be the value of another.
	text = replaceToFixedPoint(text, redactKeyValues)

	// 5. Connection-string passwords.
	text = reConnString.ReplaceAllString(text, "${1}"+Redacted+"${3}")

	// 6. Authorization-header tokens.
	text = reAuthHeader.ReplaceAllString(text, "${1}"+Redacted)

	return text
}

func containsAny(text string, needles []string) bool {
	for _, n := range needles {
		if strings.Contains(text, n) {
			return true
		}
	}
	return false
}

func replaceToFixedPoint(text string, replace func(string) string) string {
	for {
		next := replace(text)
		if next == text {
			return next
		}
		text = next
	}
}

// redactKeyValues applies reKeyValue with the env-var and URL-username
// suppression guards: matches directly preceded by "$", "${", or "//" are
// variable references or connection-string user names, not assignments.
func redactKeyValues(text string) string {
	matches := reKeyValue.FindAllStringSubmatchIndex(text, -1)
	if matches == nil {
		return text
	}
	var out strings.Builder
	out.Grow(len(text))
	last := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if suppressedAt(text, start) {
			continue
		}
		val := firstGroup(text, m)
		if val == "" || val == Redacted {
			continue
		}
		out.WriteString(text[last:start])
		out.WriteString(strings.ReplaceAll(text[start:end], val, Redacted))
		last = end
	}
	out.WriteString(text[last:])
	return out.String()
}

func suppressedAt(text string, start int) bool {
	if start >= 1 && text[start-1] == '$' {
		return true
	}
	if start >= 2 {
		prev2 := text[start-2 : start]
		if prev2 == "${" || prev2 == "//" {
			return true
		}
	}
	return false
}

// firstGroup returns the first non-empty capture (double-quoted,
// single-quoted, or unquoted value).
func firstGroup(text string, m []int) string {
	for g := 1; g <= 3; g++ {
		if m[2*g] >= 0 {
			return text[m[2*g]:m[2*g+1]]
		}
	}
	return ""
}
