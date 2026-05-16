module github.com/garudex-labs/caracal/control

go 1.26

require (
	github.com/garudex-labs/caracal/core v0.0.0
	github.com/garudex-labs/caracal/identity v0.0.0
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/redis/go-redis/v9 v9.19.0
	github.com/rs/zerolog v1.35.1
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/davecgh/go-spew v1.1.2-0.20180830191138-d8f796af33cc // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/pmezard/go-difflib v1.0.1-0.20181226105442-5d4384ee4fb2 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/sys v0.44.0 // indirect
)

replace github.com/garudex-labs/caracal/core => ../../packages/core/go

replace github.com/garudex-labs/caracal/identity => ../../packages/identity/go
