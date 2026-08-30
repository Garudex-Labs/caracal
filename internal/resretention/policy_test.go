// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package resretention

import (
	"testing"
	"time"
)

func TestValidatePolicy(t *testing.T) {
	for _, tc := range []struct {
		name        string
		privateDays int
		projectDays int
		wantErr     bool
	}{
		{name: "defaults", privateDays: 30, projectDays: 30},
		{name: "private zero", privateDays: 0, projectDays: 7},
		{name: "maxima", privateDays: 90, projectDays: 180},
		{name: "private below", privateDays: -1, projectDays: 30, wantErr: true},
		{name: "private above", privateDays: 91, projectDays: 30, wantErr: true},
		{name: "project below", privateDays: 30, projectDays: 6, wantErr: true},
		{name: "project above", privateDays: 30, projectDays: 181, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePolicy(tc.privateDays, tc.projectDays)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidatePolicy() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func TestScheduledPurgeAt(t *testing.T) {
	deleted := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	policy := Policy{PrivateRetentionDays: 0, ProjectRetentionDays: 7}
	if got := ScheduledPurgeAt(deleted, ClassPrivate, policy); !got.Equal(deleted) {
		t.Fatalf("private scheduled purge = %s, want %s", got, deleted)
	}
	wantProject := deleted.AddDate(0, 0, 7)
	if got := ScheduledPurgeAt(deleted, ClassProject, policy); !got.Equal(wantProject) {
		t.Fatalf("project scheduled purge = %s, want %s", got, wantProject)
	}
}

func TestClassForAgent(t *testing.T) {
	if got := ClassForAgent("private", true); got != ClassPrivate {
		t.Fatalf("private class = %s", got)
	}
	if got := ClassForAgent("project", true); got != ClassProject {
		t.Fatalf("project class = %s", got)
	}
	if got := ClassForAgent("team", false); got != ClassProject {
		t.Fatalf("legacy team/public class = %s", got)
	}
}
