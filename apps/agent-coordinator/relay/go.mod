module github.com/garudex-labs/caracal/agent-coordinator-relay

go 1.26

require (
	github.com/garudex-labs/caracal/shared v0.0.0
	github.com/redis/go-redis/v9 v9.7.3
	github.com/rs/zerolog v1.33.0
)

require (
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.19 // indirect
	golang.org/x/sys v0.38.0 // indirect
)

replace github.com/garudex-labs/caracal/shared => ../../../packages/shared
