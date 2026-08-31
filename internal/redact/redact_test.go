// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package redact

import (
	"strings"
	"testing"
)

func TestSecretsRedacted(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			"openai key",
			"key is sk-proj-abc123def456ghi789jkl012mno345 ok",
			"key is **REDACTED** ok",
		},
		{
			"github token",
			"push with ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
			"push with **REDACTED**",
		},
		{
			"jwt",
			"t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
			"t=**REDACTED**",
		},
		{
			"pem block",
			"-----BEGIN PRIVATE KEY-----\nMIIEvQ\n-----END PRIVATE KEY-----",
			"**REDACTED**",
		},
		{
			"kv assignment keeps key name",
			"API_KEY=abcdef1234567890",
			"API_KEY=**REDACTED**",
		},
		{
			"plain token assignment",
			"client token=abcdefghijklmnopqrstuvwxyz123456",
			"client token=**REDACTED**",
		},
		{
			"json password value",
			`{"password": "s3cretvalue!"}`,
			`{"password": "**REDACTED**"}`,
		},
		{
			"connection string keeps user and host",
			"postgresql://svc:hunter22@db/caracal",
			"postgresql://svc:**REDACTED**@db/caracal",
		},
		{
			"authorization header keeps scheme",
			"Authorization: Bearer abcdefghij0123456789",
			"Authorization: Bearer **REDACTED**",
		},
		{
			"aws pair",
			`AKIAIOSFODNN7EXAMPLE secret="wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12"`,
			`**REDACTED** secret="**REDACTED**"`,
		},
		{
			"adjacent aws secrets both caught",
			`a="wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY12" "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY13"`,
			`a="**REDACTED**" "**REDACTED**"`,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Secrets(tc.in)
			if got != tc.want {
				t.Errorf("Secrets(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
			if again := Secrets(got); again != got {
				t.Errorf("not idempotent: %q -> %q", got, again)
			}
		})
	}
}

func TestSecretsKept(t *testing.T) {
	kept := []string{
		"$OPENAI_KEY",
		"${API_KEY} expansion",
		`os.environ["OPENAI_KEY"]`,
		`load_dotenv(".env")`,
		"redis://password:host confusion is a username, not an assignment",
		"API_KEY=short",         // value below 8 chars
		"the word secret alone", // no assignment
		"short",                 // below the scan threshold
		Redacted,                // already redacted
	}
	for _, in := range kept {
		if got := Secrets(in); got != in {
			t.Errorf("Secrets(%q) = %q, want unchanged", in, got)
		}
	}
}

func TestSecretsMixedContentPreservesSurroundings(t *testing.T) {
	in := "before sk-proj-abc123def456ghi789jkl012mno345 middle API_KEY=abcdef1234567890 after"
	got := Secrets(in)
	for _, part := range []string{"before ", " middle ", " after", "API_KEY="} {
		if !strings.Contains(got, part) {
			t.Errorf("output lost %q: %q", part, got)
		}
	}
	if strings.Contains(got, "sk-proj") || strings.Contains(got, "abcdef1234567890") {
		t.Errorf("secret survived: %q", got)
	}
}
