// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Package sdk is the Caracal Go SDK.
//
// The drop-in API is the Caracal type. Construct it with FromEnv (or by
// populating the struct directly) and use Spawn, Delegate, Transport,
// Middleware, Headers, Current, and BindFromRequest. The advanced surface —
// envelope codec, raw coordinator client, ambient context primitives, and
// transport injection — is exposed in the same package because Go convention
// keeps a single package surface.
package sdk
