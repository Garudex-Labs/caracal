// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Generic net/http middleware: extracts the wire envelope and binds CaracalContext per request.

package sdk

import "net/http"

// Middleware returns an http.Handler middleware that binds a CaracalContext
// for each inbound request from envelope headers.
func (c *Caracal) Middleware(next http.Handler, opts ...RootOptions) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, err := c.BindFromRequest(r.Context(), r, opts...)
		if err != nil {
			http.Error(w, "invalid or missing authorization", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
