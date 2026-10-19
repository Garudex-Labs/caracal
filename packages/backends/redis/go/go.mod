// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the Redis revocation connector.

module github.com/garudex-labs/caracal/packages/backends/redis/go

go 1.26.0

require (
	github.com/garudex-labs/caracal/packages/core/go v1.0.0
	github.com/garudex-labs/caracal/packages/revocation/go v1.0.0
	github.com/redis/go-redis/v9 v9.23.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	go.uber.org/atomic v1.12.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
)
