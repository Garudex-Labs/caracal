// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package resretention centralizes recoverable-resource retention policy.
package resretention

import (
	"fmt"
	"time"
)

const (
	PrivateMinDays = 0
	PrivateMaxDays = 90
	ProjectMinDays = 7
	ProjectMaxDays = 180

	DefaultPrivateDays = 30
	DefaultProjectDays = 30
)

type ResourceClass string

const (
	ClassPrivate ResourceClass = "private"
	ClassProject ResourceClass = "project"
)

type Policy struct {
	PrivateRetentionDays int
	ProjectRetentionDays int
}

func DefaultPolicy() Policy {
	return Policy{PrivateRetentionDays: DefaultPrivateDays, ProjectRetentionDays: DefaultProjectDays}
}

func ValidatePolicy(privateDays, projectDays int) error {
	if privateDays < PrivateMinDays || privateDays > PrivateMaxDays {
		return fmt.Errorf("private_retention_days must be between %d and %d", PrivateMinDays, PrivateMaxDays)
	}
	if projectDays < ProjectMinDays || projectDays > ProjectMaxDays {
		return fmt.Errorf("project_retention_days must be between %d and %d", ProjectMinDays, ProjectMaxDays)
	}
	return nil
}

func ClassForAgent(ownershipScope string, isPrivate bool) ResourceClass {
	if ownershipScope == "private" {
		return ClassPrivate
	}
	if isPrivate {
		return ClassProject
	}
	return ClassProject
}

func DaysForClass(policy Policy, class ResourceClass) int {
	if class == ClassPrivate {
		return policy.PrivateRetentionDays
	}
	return policy.ProjectRetentionDays
}

func ScheduledPurgeAt(deletedAt time.Time, class ResourceClass, policy Policy) time.Time {
	return deletedAt.UTC().AddDate(0, 0, DaysForClass(policy, class))
}
