// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestPullRejectsUnknownTypeLocally(t *testing.T) {
	_, err := runCLI(t, nil, "pull", "weather", "--type", "bogus")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Validation || !strings.Contains(cerr.Message, "bogus") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "agent") || !strings.Contains(cerr.Remediation, "prompt") {
		t.Errorf("remediation must list pull types: %s", cerr.Remediation)
	}
}

func TestPullUnresolvedReferenceIsNotFound(t *testing.T) {
	// Every registry family answers 404, so detection exhausts all types and
	// reports a single not-found with a discovery remediation.
	srv := fakeAPI(t, map[string]apiResponse{})
	_, err := runCLI(t, srv, "pull", "ghost-component")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.NotFound || !strings.Contains(cerr.Message, "ghost-component") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
	if !strings.Contains(cerr.Remediation, "--type") {
		t.Errorf("remediation must suggest an explicit type: %s", cerr.Remediation)
	}
}

func TestPullResolveErrorOtherThanNotFoundStops(t *testing.T) {
	// A permission failure on the first probe must abort detection immediately
	// rather than silently trying the next family.
	srv := fakeAPI(t, map[string]apiResponse{
		"GET /api/v1/registry/resolve": {status: 403, body: `{"detail": "forbidden"}`},
	})
	_, err := runCLI(t, srv, "pull", "locked-component")
	cerr := asCLIError(t, err)
	if cerr.Category != clierr.Permission || !strings.Contains(cerr.Message, "forbidden") {
		t.Errorf("got %s: %s", cerr.Category, cerr.Message)
	}
}
