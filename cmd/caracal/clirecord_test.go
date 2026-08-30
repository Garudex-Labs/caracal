// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// recordedRequest captures one request the recording server observed.
type recordedRequest struct {
	Method string
	Path   string
	Query  string
	Body   string
}

// recordingAPI is a fakeAPI variant that also records every request so
// tests can assert on paths, query strings, and JSON bodies.
type recordingAPI struct {
	srv      *httptest.Server
	mu       sync.Mutex
	requests []recordedRequest
}

func newRecordingAPI(t *testing.T, routes map[string]apiResponse) *recordingAPI {
	t.Helper()
	rec := &recordingAPI{}
	rec.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rec.mu.Lock()
		rec.requests = append(rec.requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Body: string(body),
		})
		rec.mu.Unlock()
		route, ok := routes[r.Method+" "+r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"detail": "no such route"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		for k, v := range route.header {
			w.Header().Set(k, v)
		}
		if route.status != 0 {
			w.WriteHeader(route.status)
		}
		_, _ = w.Write([]byte(route.body))
	}))
	t.Cleanup(rec.srv.Close)
	return rec
}

// find returns the first recorded request matching method and path.
func (rec *recordingAPI) find(method, path string) (recordedRequest, bool) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	for _, r := range rec.requests {
		if r.Method == method && r.Path == path {
			return r, true
		}
	}
	return recordedRequest{}, false
}

// lines lists the recorded requests as "METHOD /path" in arrival order.
func (rec *recordingAPI) lines() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	out := make([]string, len(rec.requests))
	for i, r := range rec.requests {
		out[i] = r.Method + " " + r.Path
	}
	return out
}

// recEnv points the CLI at the recording server with an isolated HOME.
func recEnv(t *testing.T, rec *recordingAPI) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CARACAL_SERVER_URL", rec.srv.URL)
	t.Setenv("CARACAL_ACCESS_TOKEN", "test-token")
	return home
}
