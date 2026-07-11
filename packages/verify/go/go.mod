// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the framework-neutral verification engine.

module github.com/garudex-labs/caracal/packages/verify/go

go 1.26

require (
	github.com/garudex-labs/caracal/packages/identity/go v0.2.0-rc.2
	github.com/garudex-labs/caracal/packages/revocation/go v0.2.0-rc.2
)

require (
	github.com/garudex-labs/caracal/packages/core/go v0.2.0-rc.2 // indirect
	github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
)
