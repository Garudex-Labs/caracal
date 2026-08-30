// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func subjectFor(t *testing.T, name string) Subject {
	t.Helper()
	id := uuid.New()
	ns := "acme"
	slug := "review-bot"
	v := "1.2.0"
	return Subject{Type: "agent", ID: &id, Name: name, Namespace: &ns, Slug: &slug, Version: &v}
}

func TestEveryDeliverableKindIsAKnownKind(t *testing.T) {
	known := map[string]bool{}
	for _, k := range Kinds {
		known[k] = true
	}
	for kind := range kindSpecs {
		if !known[kind] {
			t.Errorf("kind %q has a delivery spec but is not a listed kind", kind)
		}
	}
}

func TestDeliverOneRejectsUnknownKind(t *testing.T) {
	_, err := DeliverOne(context.Background(), nil, "no-such-kind", uuid.New(), Subject{}, nil, nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "no delivery spec") {
		t.Fatalf("err = %v, want unknown-kind error", err)
	}
}

func TestTitlesAndDedupeKeysAreBounded(t *testing.T) {
	long := strings.Repeat("x", 400)
	subject := subjectFor(t, long)
	for kind, spec := range kindSpecs {
		title := truncate(spec.title(subject, map[string]any{"decision": long, "comment_id": long}), 255)
		if len(title) > 255 || title == "" {
			t.Errorf("%s: title length %d", kind, len(title))
		}
		dedupe := truncate(spec.dedupe(subject, map[string]any{"request_id": long, "comment_id": long, "requester_id": long}), 255)
		if len(dedupe) > 255 || dedupe == "" {
			t.Errorf("%s: dedupe length %d", kind, len(dedupe))
		}
	}
}

func TestDedupeKeysSeparateVersionsButNotRedeliveries(t *testing.T) {
	subject := subjectFor(t, "review-bot")
	spec := kindSpecs["review_requested"]
	first := spec.dedupe(subject, nil)
	if again := spec.dedupe(subject, nil); again != first {
		t.Fatalf("same fact must share a dedupe key: %q vs %q", first, again)
	}
	v2 := "2.0.0"
	bumped := subject
	bumped.Version = &v2
	if spec.dedupe(bumped, nil) == first {
		t.Fatal("a newer version is a new item, not a duplicate")
	}
}

func TestRegistryActionsUseCanonicalURLs(t *testing.T) {
	subject := subjectFor(t, "review-bot")
	url := registryURL(subject)
	if url == nil || *url != "/agents/acme/review-bot" {
		t.Fatalf("url = %v, want canonical namespace/slug path", url)
	}
	// Only agents carry a registry URL; other subject types get none.
	if u := registryURL(Subject{Type: "mcp", ID: subject.ID}); u != nil {
		t.Fatalf("non-agent url = %v, want nil", *u)
	}
}

func TestRegistryActionsKeepUUIDFallbackForLegacyNamespaces(t *testing.T) {
	subject := subjectFor(t, "review-bot")
	legacy := "Not A Namespace"
	subject.Namespace = &legacy
	url := registryURL(subject)
	if url == nil || *url != "/agents/"+subject.ID.String() {
		t.Fatalf("url = %v, want UUID fallback", url)
	}
	subject.ID = nil
	if u := registryURL(subject); u != nil {
		t.Fatalf("url = %v, want nil when no safe identity exists", u)
	}
}

func TestReviewLinksOpenTheResourceReviewView(t *testing.T) {
	subject := subjectFor(t, "review-bot")
	if u := reviewURL(subject); u == nil || *u != "/agents/"+subject.ID.String()+"?view=review" {
		t.Fatalf("review url = %v", u)
	}
	if c := reviewShowCommand(subject, nil); c == nil || *c != "caracal admin review show "+subject.ID.String()+" --agent" {
		t.Fatalf("review command = %v", c)
	}
	mcp := subject
	mcp.Type = "mcp"
	if u := reviewURL(mcp); u == nil || *u != "/components/"+mcp.ID.String()+"?type=mcps&view=review" {
		t.Fatalf("component review url = %v", u)
	}
	if u := reviewURL(Subject{Type: "agent"}); u == nil || *u != "/resources" {
		t.Fatalf("review url without id = %v, want /resources fallback", u)
	}
	if c := reviewShowCommand(mcp, nil); c == nil || strings.Contains(*c, "--agent") {
		t.Fatalf("component review command = %v", c)
	}
}

func TestEveryActionURLIsASameOriginPath(t *testing.T) {
	subjects := []Subject{
		subjectFor(t, "review-bot"),
		{Type: "mcp"},
		{Type: "agent"},
	}
	for kind, spec := range kindSpecs {
		if spec.url == nil {
			continue
		}
		for _, subject := range subjects {
			u := spec.url(subject)
			if u == nil {
				continue
			}
			if !strings.HasPrefix(*u, "/") || strings.HasPrefix(*u, "//") || strings.Contains(*u, "://") {
				t.Errorf("%s: action url %q escapes the origin", kind, *u)
			}
		}
	}
}

func TestDeliverSkipsActorAndDuplicateRecipients(t *testing.T) {
	actor := uuid.New()
	subject := subjectFor(t, "review-bot")
	// Every recipient is either the actor or a duplicate of them, so no
	// delivery is attempted and no transaction is needed.
	delivered, err := Deliver(context.Background(), nil, "review_requested",
		[]uuid.UUID{actor, actor}, subject, &actor, nil, nil, true)
	if err != nil || delivered != 0 {
		t.Fatalf("delivered = %d, err = %v; the actor must not be notified of their own action", delivered, err)
	}
}
