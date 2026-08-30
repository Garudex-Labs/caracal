<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Testing Guide

This guide defines the pattern for tests in Caracal. The suite is layered: colocated Go and web unit tests, repo-level contract tests, and stack-backed integration and e2e suites. Do not rewrite old tests only for style. New tests and touched files should move toward this pattern when it keeps the diff focused.

## Goals

Good tests in this repo should be:

- **Hermetic**: unit tests use no real network, Docker, user config, or external services. Only `tests/integration/` and `tests/e2e/` talk to a live stack.
- **Behavioral**: assert user-visible behavior or service contracts, not incidental internals.
- **Small**: one package, command, route group, or behavior area per file.
- **Explicit**: setup is visible in the test or in small local helpers.
- **Fast**: sleeps, external calls, and expensive setup are replaced at the boundary.

## Test taxonomy

| Layer | Location | Covers | Requires |
|---|---|---|---|
| Go unit tests | colocated `*_test.go` under `internal/`, `cmd/`, `tools/` | package behavior; table-driven; run with `-race` | nothing |
| Live DB tests | env-gated `*_live_test.go` (e.g. `internal/inbox/`, `internal/identity/`, `internal/tenancy/`) | DB-backed invariants against a real PostgreSQL schema | `CARACAL_TEST_PG_URL` |
| Contract tests | `tests/` (package `contracts`) | repo-level invariants: release workflow, Helm OCI pipeline, version sync | nothing |
| Integration tests | `tests/integration/` (package `integration`) | full request → DB → response over real HTTP against the compose stack | `make up` (auto-skips otherwise) |
| Web unit tests | colocated `apps/web/src/**/*.test.ts` | pure frontend logic via `node:test` | nothing |
| E2E tests | `tests/e2e/` (Playwright specs) | user flows through the web UI and CLI-driven lifecycles | `make up` |

## Running tests

Make targets for normal workflows:

```bash
make test           # full suite: Go then web
make test SUITE=go  # go test -race ./...  (every Go test, including tests/)
make test SUITE=web # cd apps/web && pnpm test  (node --test "src/**/*.test.ts")
```

Focused runs while iterating:

```bash
go test ./internal/ingest/ -run TestGoldenRowParity          # one package, one test
go test -race ./internal/cli/...                             # a subtree
go test ./tests/...                                          # contract + integration packages only
CARACAL_TEST_PG_URL=postgres://... go test ./internal/inbox/ # live DB tests
go test ./tests/integration/                                 # skips without the stack
cd apps/web && node --test src/lib/registry-name.test.ts          # one web test file
```

E2E requires the running Docker stack:

```bash
make up
pnpm e2e                                    # from the repo root
pnpm e2e --grep kiro                        # filter specs
cd tests/e2e && pnpm exec playwright test   # against the compose lb (http://localhost)
```

## Go unit tests

Use only the standard `testing` package - no assertion frameworks. Prefer table-driven tests for the same behavior across inputs:

```go
func TestBumpVersion(t *testing.T) {
	cases := []struct {
		bump string
		want string
	}{
		{"patch", "1.10.8"},
		{"feature", "1.11.0"},
		{"major", "2.0.0"},
	}
	for _, c := range cases {
		got, err := bumpVersion("1.10.7", c.bump)
		if err != nil {
			t.Fatalf("bumpVersion(1.10.7, %s): %v", c.bump, err)
		}
		if got != c.want {
			t.Errorf("bumpVersion(1.10.7, %s) = %s, want %s", c.bump, got, c.want)
		}
	}
}
```

Conventions:

- **Behavior names**: `TestMissingAuthReturns401`, `TestScanDoesNotModifyIDEFiles` - the name states the condition and the expectation. Avoid `TestCase1` or `TestRouteWorks`.
- **Never touch the real home directory**: build paths from `t.TempDir()` and pass them explicitly.
- **Mark helpers** with `t.Helper()` so failures point at the test.
- **Include the response body in HTTP failures** with `t.Fatalf`, so a red run is diagnosable from the log alone:

```go
if resp.StatusCode != http.StatusOK {
	t.Fatalf("GET %s = %d, body: %s", path, resp.StatusCode, body)
}
```

## Seams and fakes

External commands and services are stubbed through package-level function variables, swapped in the test and restored with `t.Cleanup`. `tools/release` is the reference pattern - `run`, `ghJSON`, and `commitLog` are vars, and the tests stub them:

```go
func stubRun(t *testing.T, fake func(args ...string) (string, error)) {
	t.Helper()
	original := run
	run = fake
	t.Cleanup(func() { run = original })
}
```

For interactive flows, implement the prompter interface with a scripted fake that answers each question and fails the test on an unexpected prompt (see `scriptedPrompter` in `tools/release/release_test.go`).

Mock boundaries, not the behavior under test: HTTP clients, subprocesses, filesystem writes when the write itself is not under test, time. Do not stub small pure functions, the function being tested, or several internal layers at once.

## Golden-file parity

The transcript row builder in `internal/ingest` is pinned by recorded fixtures in `contracts/session-goldens/`: `goldens_test.go` replays every transcript through the builder and requires field-level agreement (`TestGoldenRowParity`). This gate must stay green - anything that ingests transcripts may never disagree on stored rows. When parser behavior changes intentionally, update the goldens in the same PR and explain the diff.

## Fuzz tests

`internal/ingest/fuzz_test.go` (`FuzzBuildRows`) drives arbitrary transcript bytes through every harness's row builder; the builder must never panic. Seed inputs run as ordinary unit tests under `go test`; explore actively with:

```bash
go test ./internal/ingest/ -fuzz FuzzBuildRows -fuzztime 30s
```

Reach for a fuzz target when a boundary takes untrusted bytes and the interesting failures are crashes rather than wrong answers.

## Live DB tests

DB-backed invariants live in `*_live_test.go` files that skip unless `CARACAL_TEST_PG_URL` points at a real PostgreSQL schema:

```go
dsn := os.Getenv("CARACAL_TEST_PG_URL")
if dsn == "" {
	t.Skip("CARACAL_TEST_PG_URL not set")
}
```

Keep them self-cleaning: run inside a transaction that always rolls back, or delete every row the test created (see `internal/inbox/deliver_live_test.go` and `internal/identity/live_test.go`).

## Contract tests

`tests/` (package `contracts`) pins repository-level release and packaging invariants: version sync across `apps/web/package.json` and `packages/pi-extension/package.json`, the Helm OCI publishing pipeline, and the signed-tag release workflow. Tests read repo files relative to the package directory and fail with the exact expectation through small helpers (`mustContain`, `mustNotContain`). Add a contract test whenever two files must stay in lockstep and nothing else enforces it.

## Integration tests

`tests/integration/` exercises the full request → DB → response cycle over real HTTP with no mocking. Every test calls `requireStack(t)`, which probes `<base>/health` once and skips the suite when the stack is down - so `go test ./tests/...` is always safe to run. Configuration comes from the environment; tests that need authentication skip unless admin credentials for a provisioned account are supplied:

| Variable | Default |
|---|---|
| `INTEGRATION_BASE_URL` | `http://localhost` |
| `INTEGRATION_ADMIN_EMAIL` | unset (auth-dependent tests skip) |
| `INTEGRATION_ADMIN_PASSWORD` | unset (auth-dependent tests skip) |

Assert the response status and body first; the shared helpers include the (truncated) response body in failure messages.

## Web unit tests

Web unit tests are colocated `*.test.ts` files run by the Node test runner - no framework:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { slugifyRegistryText } from "./registry-name.ts";

test("replaces spaces with a single hyphen while typing", () => {
	assert.equal(slugifyRegistryText("Cloud  Computing"), "cloud-computing");
});
```

Keep them for pure logic: parsers, formatters, name validation. Component and flow behavior belongs in the Playwright suite.

## E2E tests

`tests/e2e/` holds the Playwright specs (22 today). They need the full Docker stack (`make up`) and cover browser flows plus CLI-driven lifecycles (the `kiro-*` specs). Run `pnpm e2e` from the repo root, or `pnpm exec playwright test` from `tests/e2e/` to target the compose load balancer directly. Screenshots and traces are kept on failure.

## Mock policy

No Docker or network is required for `make test`: unit tests stub externals, live DB tests skip without their env key, and the integration package skips without the stack. Only `tests/integration/` and `tests/e2e/` talk to a live stack.

## CI mapping

CI is path-filtered: jobs only run when their inputs change.

- **go-checks** (gated on `**/*.go`, `go.mod`, `go.sum`, `packages/harness-data/**`, `contracts/**`, `.golangci.yml`): `gofmt`, `go vet`, `golangci-lint`, then `go test -race` with a coverage profile - which includes the contract tests and the auto-skipping integration package.
- **web-lint** (gated on `apps/web/**` and related paths): ESLint, typecheck, and the web unit tests under coverage.

Run `make lint` (gofmt + go vet) before pushing Go changes; use `make check` for the full pre-commit suite.

## Coverage

Codecov is the authoritative report; local collection matches it exactly:

```bash
make coverage           # both suites
make coverage SUITE=go  # go test -race -coverpkg over cmd/, internal/, packages/
make coverage SUITE=web # c8 --all over apps/web/src (config in apps/web/.c8rc.json)
```

Both commands measure **all** production code, not just packages or modules a
test happens to load: Go uses `-coverpkg=./cmd/...,./internal/...,./packages/...`
so untested packages count as zero, and c8 runs with `all: true` so unloaded
web modules count as zero. Do not switch either back to load-only profiles -
that silently inflates the number.

Uploads are flag-scoped (`go`, `web`) with carryforward, so a PR that skips one
language's CI job keeps that language's last report instead of showing a drop.

Excluded from measurement, and why (`.github/codecov.yml`):

- `tests/`, `**/*_test.go` - test code
- `tools/` - repo tooling, never shipped
- `contracts/` - frozen wire fixtures
- `infra/` - deployment assets
- `apps/web/src/routeTree.gen.ts` - generated by TanStack Router
- `apps/web/mock/` - dev-only mock API
- `apps/web/src/components/ui/` - vendored shadcn primitives

Nothing else may be excluded without documenting the reason here. Coverage
targets are informational on PRs (they never block), but new code should land
with tests: prefer raising a package's coverage with behavioral tests over
excluding it.

## Review checklist

Before submitting a test change, check that:

- The test fails without the product fix or covers a meaningful invariant.
- External services are stubbed through function-var seams or local fakes.
- Real user config and real home directories are not touched (`t.TempDir()`).
- The test name states the behavior.
- Helpers are local unless reused across files, and call `t.Helper()`.
- HTTP assertions include the response body in the failure message.
- Live DB tests skip cleanly without `CARACAL_TEST_PG_URL` and clean up after themselves.
- Focused tests pass locally with `-race`.
