// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generic net/http middleware: extracts the wire envelope and binds CaracalContext per request.

package sdk

import "net/http"

// Middleware returns an http.Handler middleware that binds a CaracalContext
// for each inbound request from envelope headers. Falls back to the
// configured subject token when the request does not carry one.
func (c *Caracal) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := c.BindFromRequest(r.Context(), r)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
