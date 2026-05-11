// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the identity package.

module github.com/garudex-labs/caracal/identity

go 1.26

require (
	github.com/garudex-labs/caracal/core v0.0.0-00010101000000-000000000000
	github.com/golang-jwt/jwt/v5 v5.2.2
)

replace github.com/garudex-labs/caracal/core => ../../core/go
