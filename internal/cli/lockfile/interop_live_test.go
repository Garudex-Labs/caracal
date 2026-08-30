// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package lockfile

import (
	"os"
	"testing"
)

// TestLiveInterop exercises the shared on-disk format against the
// incumbent implementation. Gated: set CARACAL_LOCK_HOME.
func TestLiveInterop(t *testing.T) {
	home := os.Getenv("CARACAL_LOCK_HOME")
	if home == "" {
		t.Skip("CARACAL_LOCK_HOME not set")
	}
	t.Setenv("HOME", home)
	if err := UpsertStandalone("kiro", Entry{
		Type: "skill", Name: "Interop Skill", ID: "interop-1", Version: str("1.2.3"),
		Scope: "user", Namespace: "acme", Slug: "interop-skill", LocalName: "interop-skill",
	}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertAgent("kiro", Entry{
		Name: "interop-bot", ID: "interop-agent-1", Version: str("2.0.0"),
		Scope: "project", Directory: "/tmp/proj", Namespace: "acme", Slug: "interop-bot",
	}); err != nil {
		t.Fatal(err)
	}
	t.Log("go wrote entries")
}
