// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the net/http MCP middleware adaptor.

module github.com/garudex-labs/caracal/mcp-nethttp

go 1.26

require (
	github.com/garudex-labs/caracal/identity v0.0.0-00010101000000-000000000000
	github.com/garudex-labs/caracal/transport-mcp v0.0.0-00010101000000-000000000000
	github.com/golang-jwt/jwt/v5 v5.2.2
)

replace (
	github.com/garudex-labs/caracal/core => ../../../core/go
	github.com/garudex-labs/caracal/identity => ../../../identity/go
	github.com/garudex-labs/caracal/revocation => ../../../revocation/go
	github.com/garudex-labs/caracal/transport-mcp => ../../../transport-mcp/go
)
