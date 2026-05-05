module github.com/garudex-labs/caracal/agent-coordinator-relay

go 1.26

require (
	github.com/garudex-labs/caracal/shared v0.0.0
	github.com/redis/go-redis/v9 v9.7.3
	github.com/rs/zerolog v1.33.0
)

replace github.com/garudex-labs/caracal/shared => ../../../packages/shared
