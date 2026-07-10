// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// STS audit buffer readiness tests for replay storage.

package internal

import (
	"path/filepath"
	"testing"
)

func TestAuditBufferReadyRequiresReplayDirectory(t *testing.T) {
	dir := t.TempDir()
	buffer := &AuditBuffer{replayDir: dir}

	if err := buffer.Ready(); err != nil {
		t.Fatalf("expected replay directory to be ready, got %v", err)
	}

	buffer.replayDir = filepath.Join(dir, "missing")
	if err := buffer.Ready(); err == nil {
		t.Fatal("expected missing replay directory to fail readiness")
	}
}
