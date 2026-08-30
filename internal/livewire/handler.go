// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package livewire

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

// RedisSubscriber bridges Redis pub/sub channels to subscription streams.
type RedisSubscriber struct {
	Client redis.UniversalClient
}

// Subscribe follows the channel until the stop function is called.
func (s *RedisSubscriber) Subscribe(ctx context.Context, channel string) (<-chan []byte, func()) {
	subCtx, cancel := context.WithCancel(ctx)
	pubsub := s.Client.Subscribe(subCtx, channel)
	out := make(chan []byte, 16)
	go func() {
		defer close(out)
		defer func() { _ = pubsub.Close() }()
		ch := pubsub.Channel()
		for {
			select {
			case <-subCtx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				select {
				case out <- []byte(msg.Payload):
				case <-subCtx.Done():
					return
				}
			}
		}
	}()
	return out, cancel
}

// Handler serves /api/v1/graphql: WebSocket subscriptions and HTTP queries.
type Handler struct {
	Events        Subscriber
	Authenticator interface {
		Authenticate(context.Context, string) (auth.Claims, error)
	}
	Directory httpapi.UserGate
	Projects  interface {
		ResolveProjectID(context.Context, *http.Request, uuid.UUID) (string, error)
	}
}

// Routes returns the endpoint handler; the path carries both the upgrade
// handshake and plain POST queries, matching the previous behavior.
func (h *Handler) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/graphql", h.serve)
	mux.HandleFunc("/api/v1/graphql/", h.serve)
	return mux
}

func (h *Handler) serve(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		h.serveWS(w, r)
		return
	}
	h.serveHTTP(w, r)
}

// serveHTTP answers the health query; subscriptions require the socket.
func (h *Handler) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}
	var p subscribePayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeGraphQL(w, map[string]any{"data": nil, "errors": []map[string]string{{"message": "invalid request body"}}})
		return
	}
	op, ok := parseOperation(p)
	if !ok || op.Field != "health" {
		writeGraphQL(w, map[string]any{"data": nil, "errors": []map[string]string{{"message": "operation not supported over HTTP"}}})
		return
	}
	writeGraphQL(w, map[string]any{"data": map[string]string{"health": "ok"}})
}

func writeGraphQL(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}

const (
	connectionInitTimeout = 10 * time.Second
	writeTimeout          = 10 * time.Second
)

// serveWS runs one graphql-transport-ws connection.
func (h *Handler) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols: []string{"graphql-transport-ws"},
		// The LB terminates the public origin; same-origin policy is
		// enforced there and tokens ride in connectionParams.
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	var writeMu sync.Mutex
	send := func(m wsMessage) error {
		data, err := json.Marshal(m)
		if err != nil {
			return err
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, writeTimeout)
		defer wcancel()
		return conn.Write(wctx, websocket.MessageText, data)
	}

	// The protocol requires connection_init before anything else.
	initCtx, initCancel := context.WithTimeout(ctx, connectionInitTimeout)
	_, first, err := conn.Read(initCtx)
	initCancel()
	if err != nil {
		return
	}
	var init wsMessage
	if json.Unmarshal(first, &init) != nil || init.Type != "connection_init" {
		_ = conn.Close(4400, "connection initialisation required")
		return
	}
	var params struct {
		Authorization string `json:"authorization"`
		Organization  string `json:"organization"`
		Project       string `json:"project"`
	}
	if json.Unmarshal(init.Payload, &params) != nil || h.Authenticator == nil || h.Directory == nil || h.Projects == nil {
		_ = conn.Close(4401, "not authenticated")
		return
	}
	token, ok := auth.BearerToken(params.Authorization)
	if !ok {
		_ = conn.Close(4401, "not authenticated")
		return
	}
	claims, err := h.Authenticator.Authenticate(ctx, token)
	if err != nil || claims.AuthContext != auth.AuthContextTenant {
		_ = conn.Close(4401, "not authenticated")
		return
	}
	localID, err := h.Directory.ResolveActive(ctx, claims)
	if err != nil {
		_ = conn.Close(4401, "not authenticated")
		return
	}
	claims.UserID = localID
	scopeRequest := r.Clone(ctx)
	scopeRequest.Header = r.Header.Clone()
	scopeRequest.Header.Set("X-Caracal-Org", params.Organization)
	scopeRequest.Header.Set("X-Caracal-Project", params.Project)
	projectID, err := h.Projects.ResolveProjectID(ctx, scopeRequest, claims.UserID)
	if err != nil {
		_ = conn.Close(4403, "project scope denied")
		return
	}
	if send(wsMessage{Type: "connection_ack"}) != nil {
		return
	}

	stops := map[string]func(){}
	var stopsMu sync.Mutex
	defer func() {
		stopsMu.Lock()
		for _, stop := range stops {
			stop()
		}
		stopsMu.Unlock()
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg wsMessage
		if json.Unmarshal(data, &msg) != nil {
			_ = conn.Close(4400, "invalid message")
			return
		}
		switch msg.Type {
		case "ping":
			_ = send(wsMessage{Type: "pong"})
		case "pong":
		case "complete":
			stopsMu.Lock()
			if stop, ok := stops[msg.ID]; ok {
				stop()
				delete(stops, msg.ID)
			}
			stopsMu.Unlock()
		case "subscribe":
			var p subscribePayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				_ = conn.Close(4400, "invalid subscribe payload")
				return
			}
			op, ok := parseOperation(p)
			if !ok {
				errPayload, _ := json.Marshal([]map[string]string{{"message": "unknown operation"}})
				_ = send(wsMessage{ID: msg.ID, Type: "error", Payload: errPayload})
				continue
			}
			op.ProjectID = projectID
			if op.Field == "health" {
				payload, _ := json.Marshal(map[string]any{"data": map[string]string{"health": "ok"}})
				_ = send(wsMessage{ID: msg.ID, Type: "next", Payload: payload})
				_ = send(wsMessage{ID: msg.ID, Type: "complete"})
				continue
			}
			stopsMu.Lock()
			if _, exists := stops[msg.ID]; exists {
				stopsMu.Unlock()
				_ = conn.Close(4409, "subscriber already exists: "+msg.ID)
				return
			}
			events, stop := h.Events.Subscribe(ctx, channelFor(op))
			stops[msg.ID] = stop
			stopsMu.Unlock()
			go func(id string) {
				for raw := range events {
					payload := nextPayload(op, raw)
					if payload == nil {
						continue
					}
					if send(wsMessage{ID: id, Type: "next", Payload: payload}) != nil {
						return
					}
				}
			}(msg.ID)
		default:
			slog.Debug("graphql ws message ignored", "type", msg.Type)
		}
	}
}
