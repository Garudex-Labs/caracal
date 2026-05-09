// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// net/http middleware that delegates Caracal MCP auth to transport-mcp.

package mcp

import (
"encoding/json"
"log"
"net/http"

transportmcp "github.com/garudex-labs/caracal/transport-mcp"
)

// Options configures the auth middleware.
type Options = transportmcp.Options

type errBody struct {
Error            string `json:"error"`
ErrorDescription string `json:"error_description"`
}

// Middleware returns a net/http middleware that validates Caracal JWTs.
func Middleware(opts Options) func(http.Handler) http.Handler {
return func(next http.Handler) http.Handler {
return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
token, _ := transportmcp.ExtractBearer(r.Header.Get("Authorization"))
_, authErr := transportmcp.Authenticate(token, opts)
if authErr != nil {
status, code := mapError(authErr.Code)
writeErr(w, status, code, authErr.Description)
return
}
next.ServeHTTP(w, r)
})
}
}

func mapError(code transportmcp.ErrorCode) (int, string) {
if code == transportmcp.ErrInsufficientScope {
return http.StatusForbidden, "insufficient_scope"
}
return http.StatusUnauthorized, "invalid_token"
}

func writeErr(w http.ResponseWriter, status int, code, desc string) {
w.Header().Set("Content-Type", "application/json")
w.WriteHeader(status)
if err := json.NewEncoder(w).Encode(errBody{Error: code, ErrorDescription: desc}); err != nil {
log.Printf("caracalai-mcp: failed to encode error response: %v", err)
}
}
