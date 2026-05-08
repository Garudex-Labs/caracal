module github.com/garudex-labs/caracal/gateway

go 1.26

require (
	github.com/garudex-labs/caracal/shared v0.0.0
	github.com/rs/zerolog v1.33.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.19 // indirect
	github.com/redis/go-redis/v9 v9.19.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
)

replace github.com/garudex-labs/caracal/shared => ../../packages/shared
