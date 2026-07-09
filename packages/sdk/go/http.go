// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Context net/http middleware that binds CaracalContext after a verifier boundary.

package sdk

import (
	"log/slog"
	"net/http"
	"os"
)

// ContextMiddleware returns an http.Handler middleware that binds a CaracalContext
// from inbound envelope headers after token verification.
func (c *Caracal) ContextMiddleware(next http.Handler, opts ...CallOptions) http.Handler {
	if (len(opts) == 0 || opts[0].Verify == nil) && os.Getenv("CARACAL_ENV") == "production" {
		slog.Warn("caracal: inbound context is being bound without a verify hook in production; the envelope is propagation-only - set CallOptions.Verify or keep this boundary behind a verifier such as the Gateway")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, err := c.BindFromRequest(r.Context(), r, opts...)
		if err != nil {
			http.Error(w, "invalid or missing authorization", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
