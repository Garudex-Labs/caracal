// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

func TestErrorPayloadDoc(t *testing.T) {
	e := &clierr.Error{
		Category: clierr.Validation, Message: "bad input", Operation: "op",
		Resource: "res", Remediation: "fix it", HTTPStatus: 422,
	}
	doc := errorPayloadDoc(e)
	for _, want := range []string{`"category": "validation"`, `"message": "bad input"`, `"http_status": 422`, `"exit_code":`} {
		if !strings.Contains(doc, want) {
			t.Errorf("doc missing %q:\n%s", want, doc)
		}
	}
	// An error with no resource/remediation/status renders explicit nulls.
	bare := errorPayloadDoc(&clierr.Error{Category: clierr.Unexpected, Message: "boom"})
	if !strings.Contains(bare, `"resource": null`) || !strings.Contains(bare, `"http_status": null`) {
		t.Errorf("bare doc must use nulls:\n%s", bare)
	}
}

func TestReportStatusDoc(t *testing.T) {
	doc := reportStatusDoc(true, true, "true", 3, 1, "null")
	for _, want := range []string{`"requested": true`, `"attempted": true`, `"succeeded": true`, `"created": 3`, `"superseded": 1`, `"error": null`} {
		if !strings.Contains(doc, want) {
			t.Errorf("doc missing %q:\n%s", want, doc)
		}
	}
}

type stubAPIClient struct {
	body   string
	cerr   *clierr.Error
	method string
	path   string
}

func (s *stubAPIClient) Do(method, path string, _ map[string]string, _ any, _, _ string) ([]byte, *clierr.Error) {
	s.method, s.path = method, path
	if s.cerr != nil {
		return nil, s.cerr
	}
	return []byte(s.body), nil
}

func TestReportToInboxSuccess(t *testing.T) {
	client := &stubAPIClient{body: `{"created": 2, "superseded": 1}`}
	items := []outdatedItem{
		{Type: "mcp", ID: "m1", Name: "Weather", CurrentVersion: "1.0.0", LatestVersion: "1.2.0"},
	}
	doc := reportToInbox(client, items)
	if !strings.Contains(doc, `"succeeded": true`) || !strings.Contains(doc, `"created": 2`) {
		t.Errorf("success doc wrong:\n%s", doc)
	}
	if client.path != "/api/v1/inbox/outdated-report" {
		t.Errorf("posted to %s", client.path)
	}
}

func TestReportToInboxServerError(t *testing.T) {
	client := &stubAPIClient{cerr: &clierr.Error{Category: clierr.Unavailable, Message: "down"}}
	doc := reportToInbox(client, []outdatedItem{{Type: "mcp", ID: "m1", Name: "X", CurrentVersion: "1.0.0"}})
	if !strings.Contains(doc, `"succeeded": false`) {
		t.Errorf("error doc must not report success:\n%s", doc)
	}
}

func TestReportToInboxInvalidResponse(t *testing.T) {
	client := &stubAPIClient{body: `not json`}
	doc := reportToInbox(client, []outdatedItem{{Type: "mcp", ID: "m1", Name: "X", CurrentVersion: "1.0.0"}})
	if !strings.Contains(doc, `"succeeded": false`) {
		t.Errorf("invalid response must not report success:\n%s", doc)
	}
}

func TestEmitJSONLine(t *testing.T) {
	out := captureStdout(t, func() {
		emitJSONLine("insights.generated", []byte(`{"b": 2, "a": 1}`))
	})
	out = strings.TrimSpace(out)
	if !strings.HasPrefix(out, `{"event":"insights.generated","report":`) {
		t.Errorf("unexpected line:\n%s", out)
	}
	// A non-JSON report falls back to the trimmed raw bytes.
	out = captureStdout(t, func() {
		emitJSONLine("evt", []byte("  raw text  "))
	})
	if !strings.Contains(out, `"report":raw text`) {
		t.Errorf("fallback line wrong:\n%s", out)
	}
}

func TestTranslateParseErrorUnknownFlag(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()
	os.Args = []string{"caracal"}
	root := newRootCommand()
	cerr, _ := translateParseError(root, errors.New("unknown flag: --nope"))
	if cerr.Category != clierr.Usage {
		t.Errorf("category = %s", cerr.Category)
	}
	if !strings.Contains(cerr.Message, "No such option: --nope") {
		t.Errorf("message = %q", cerr.Message)
	}
}

func TestTranslateParseErrorUnknownSubcommand(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()
	os.Args = []string{"caracal", "registry", "instal"}
	root := newRootCommand()
	cerr, _ := translateParseError(root, errors.New("unknown command \"instal\" for \"caracal registry\""))
	if !strings.Contains(cerr.Message, "No such command 'instal'.") {
		t.Errorf("message = %q", cerr.Message)
	}
}
