// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Go module definition for the Redis revocation connector.

module github.com/garudex-labs/caracal/packages/backends/redis/go

go 1.26

require (
	github.com/garudex-labs/caracal/packages/core/go v0.2.0-rc.6
	github.com/garudex-labs/caracal/packages/revocation/go v0.2.0-rc.6
	github.com/redis/go-redis/v9 v9.21.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	go.uber.org/atomic v1.11.0 // indirect
)
