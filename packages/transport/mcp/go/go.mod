// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the transport-mcp framework-neutral auth core.

module github.com/garudex-labs/caracal/transport-mcp

go 1.26

require (
	github.com/garudex-labs/caracal/identity v0.0.0-00010101000000-000000000000
	github.com/garudex-labs/caracal/revocation v0.0.0-00010101000000-000000000000
)

require (
	github.com/garudex-labs/caracal/core v0.0.0-00010101000000-000000000000 // indirect
	github.com/golang-jwt/jwt/v5 v5.2.2 // indirect
)

replace (
	github.com/garudex-labs/caracal/core => ../../../core/go
	github.com/garudex-labs/caracal/identity => ../../../identity/go
	github.com/garudex-labs/caracal/revocation => ../../../revocation/go
)
