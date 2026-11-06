module github.com/garudex-labs/caracal/infra/postgres/gosu

go 1.26.0

// Upstream release tag 1.19, resolved to its immutable commit.
tool github.com/tianon/gosu

require (
	github.com/tianon/gosu v0.0.0-20250923190938-6456aaa0f3c8 // indirect
	golang.org/x/sys v0.49.0 // indirect
)

require github.com/moby/sys/user v0.5.0 // indirect
