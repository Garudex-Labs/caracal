// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package livewire

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/garudex-labs/caracal/internal/auth"
)

func TestParseOperation(t *testing.T) {
	cases := []struct {
		query   string
		vars    map[string]any
		field   string
		session string
		listing string
		ok      bool
	}{
		{`subscription SessionUpdated($sessionId: String) { sessionUpdated(sessionId: $sessionId) { sessionId eventName } }`,
			map[string]any{"sessionId": "abc"}, "sessionUpdated", "abc", "", true},
		{`subscription { sessionUpdated { sessionId eventName } }`, nil, "sessionUpdated", "", "", true},
		{`subscription { sessionUpdated(sessionId: "inline-1") { sessionId } }`, nil, "sessionUpdated", "inline-1", "", true},
		{`subscription ReviewUpdated($listingId: String) { reviewUpdated(listingId: $listingId) { listingId action } }`,
			map[string]any{"listingId": "l1"}, "reviewUpdated", "", "l1", true},
		{`query { health }`, nil, "health", "", "", true},
		{`query { nope }`, nil, "", "", "", false},
	}
	for _, tc := range cases {
		op, ok := parseOperation(subscribePayload{Query: tc.query, Variables: tc.vars})
		if ok != tc.ok || op.Field != tc.field || op.SessionID != tc.session || op.ListingID != tc.listing {
			t.Errorf("parseOperation(%q) = %+v ok=%v", tc.query, op, ok)
		}
	}
}

func TestChannelAndPayload(t *testing.T) {
	op, _ := parseOperation(subscribePayload{Query: "sessionUpdated", Variables: map[string]any{"sessionId": "s1"}})
	op.ProjectID = "project-1"
	if channelFor(op) != "sessions:project-1:s1:updated" {
		t.Fatalf("channel = %s", channelFor(op))
	}
	if got := nextPayload(op, []byte(`{"session_id":"s1","event_name":"tool_use"}`)); got == nil ||
		string(got) != `{"data":{"sessionUpdated":{"eventName":"tool_use","sessionId":"s1"}}}` {
		t.Fatalf("payload = %s", got)
	}
	if nextPayload(op, []byte(`{"session_id":"other","event_name":"x"}`)) != nil {
		t.Fatal("filter leak")
	}
	rop, _ := parseOperation(subscribePayload{Query: "reviewUpdated"})
	rop.ProjectID = "project-1"
	if channelFor(rop) != "reviews:project-1:updated" {
		t.Fatalf("review channel = %s", channelFor(rop))
	}
	if got := nextPayload(rop, []byte(`{"listing_id":"l1","action":"approved"}`)); got == nil ||
		!strings.Contains(string(got), `"listingId":"l1"`) {
		t.Fatalf("review payload = %s", got)
	}
}

type fakeAuthenticator struct{ err error }

func (f fakeAuthenticator) Authenticate(context.Context, string) (auth.Claims, error) {
	return auth.Claims{UserID: uuid.New(), Role: "user", AuthContext: auth.AuthContextTenant}, f.err
}

type fakeProjectResolver struct{}

func (fakeProjectResolver) ResolveProjectID(_ context.Context, r *http.Request, _ uuid.UUID) (string, error) {
	if r.Header.Get("X-Caracal-Org") != "acme" || r.Header.Get("X-Caracal-Project") != "platform" {
		return "", errors.New("scope missing")
	}
	return "project-1", nil
}

type fakeUserGate struct{}

func (fakeUserGate) ResolveActive(_ context.Context, claims auth.Claims) (uuid.UUID, error) {
	return claims.UserID, nil
}

// fakeSubscriber replays queued events for any channel.
type fakeSubscriber struct {
	mu       sync.Mutex
	channels map[string]chan []byte
}

func (f *fakeSubscriber) Subscribe(ctx context.Context, channel string) (<-chan []byte, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.channels == nil {
		f.channels = map[string]chan []byte{}
	}
	ch := make(chan []byte, 8)
	f.channels[channel] = ch
	return ch, func() {}
}

func (f *fakeSubscriber) publish(channel string, payload string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ch, ok := f.channels[channel]; ok {
		ch <- []byte(payload)
	}
}

func TestWebSocketSubscriptionFlow(t *testing.T) {
	fake := &fakeSubscriber{}
	srv := httptest.NewServer((&Handler{
		Events: fake, Authenticator: fakeAuthenticator{}, Directory: fakeUserGate{}, Projects: fakeProjectResolver{},
	}).Routes())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/v1/graphql",
		&websocket.DialOptions{Subprotocols: []string{"graphql-transport-ws"}})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	write := func(m string) {
		if err := conn.Write(ctx, websocket.MessageText, []byte(m)); err != nil {
			t.Fatal(err)
		}
	}
	read := func() wsMessage {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m wsMessage
		_ = json.Unmarshal(data, &m)
		return m
	}

	write(`{"type":"connection_init","payload":{"authorization":"Bearer x","organization":"acme","project":"platform"}}`)
	if m := read(); m.Type != "connection_ack" {
		t.Fatalf("expected ack, got %+v", m)
	}
	write(`{"id":"1","type":"subscribe","payload":{"query":"subscription SessionUpdated($sessionId: String) { sessionUpdated(sessionId: $sessionId) { sessionId eventName } }","variables":{}}}`)
	// Give the subscription goroutine a beat to register.
	deadline := time.Now().Add(2 * time.Second)
	for {
		fake.mu.Lock()
		_, ready := fake.channels["sessions:project-1:updated"]
		fake.mu.Unlock()
		if ready || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	fake.publish("sessions:project-1:updated", `{"session_id":"s9","event_name":"turn_end"}`)
	m := read()
	if m.Type != "next" || m.ID != "1" || !strings.Contains(string(m.Payload), `"sessionId":"s9"`) {
		t.Fatalf("next = %+v payload=%s", m, m.Payload)
	}
	write(`{"id":"1","type":"complete"}`)
	write(`{"type":"ping"}`)
	if m := read(); m.Type != "pong" {
		t.Fatalf("expected pong, got %+v", m)
	}
}

func TestHTTPHealthQuery(t *testing.T) {
	srv := httptest.NewServer((&Handler{Events: &fakeSubscriber{}}).Routes())
	defer srv.Close()
	res, err := srv.Client().Post(srv.URL+"/api/v1/graphql", "application/json",
		strings.NewReader(`{"query":"query { health }"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	if data, _ := body["data"].(map[string]any); data["health"] != "ok" {
		t.Fatalf("body = %v", body)
	}
}
