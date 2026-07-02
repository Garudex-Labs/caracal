// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for centralized Caracal tests.

module github.com/garudex-labs/caracal/tests

go 1.26

require (
	github.com/garudex-labs/caracal/packages/connectors/nethttp/go v0.1.6-rc.2
	github.com/garudex-labs/caracal/packages/core/go v0.1.6-rc.2
	github.com/garudex-labs/caracal/packages/identity/go v0.1.6-rc.2
	github.com/garudex-labs/caracal/packages/revocation/go v0.1.6-rc.2
	github.com/garudex-labs/caracal/packages/transport/mcp/go v0.1.6-rc.2
	github.com/golang-jwt/jwt/v5 v5.3.1
)

require (
	golang.org/x/crypto v0.53.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
)

replace (
	github.com/garudex-labs/caracal/packages/connectors/nethttp/go => ../../packages/connectors/nethttp/go
	github.com/garudex-labs/caracal/packages/core/go => ../../packages/core/go
	github.com/garudex-labs/caracal/packages/identity/go => ../../packages/identity/go
	github.com/garudex-labs/caracal/packages/revocation/go => ../../packages/revocation/go
	github.com/garudex-labs/caracal/packages/transport/mcp/go => ../../packages/transport/mcp/go
)
