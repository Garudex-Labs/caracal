module github.com/garudex-labs/caracal/gateway

go 1.26

require (
	github.com/garudex-labs/caracal/core v0.0.0
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.9.2
	github.com/redis/go-redis/v9 v9.19.0
	github.com/rs/zerolog v1.33.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/mattn/go-colorable v0.1.13 // indirect
	github.com/mattn/go-isatty v0.0.19 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/sync v0.18.0 // indirect
	golang.org/x/sys v0.42.0 // indirect
	golang.org/x/text v0.31.0 // indirect
)

replace github.com/garudex-labs/caracal/core => ../../packages/core/go
