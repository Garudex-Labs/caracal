<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Adding a CLI Command

Read this guide before adding a command, subcommand, or directly executable command group under `caracal`.
A CLI command is an agent-facing API. Its help, output, errors, exit status, side effects, documentation, and bundled-skill instructions are one contract and must change together.

## Required contract

Every new command must provide all of the following:

1. An accurate `Use` line and a one-sentence `Short` description.
2. Human-friendly table output by default when the command returns structured data.
3. JSON output for agents and scripts when the command returns structured data.
4. Categorized failures through the shared error contract in `internal/cli/clierr`.
5. Complete non-interactive inputs for agent and CI use.
6. Tests for the behavior it adds.
7. Updated CLI documentation and bundled skills.

Do not add a new output mode, a command-specific error renderer, or a second HTTP client.

## 1. Register the command in the existing hierarchy

Commands are factory functions in `cmd/caracal/*.go` that return a `*cobra.Command`:

```go
func widgetListCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "list", Short: "List widgets visible to the current user", Args: cobra.NoArgs}
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, _ []string) error {
		// fetch, then render per the output contract
		_ = mode
		return nil
	}
	return cmd
}
```

Attach leaf commands to the existing group for the relevant domain with `AddCommand`. Register new top-level groups in the `root.AddCommand(...)` list in `cmd/caracal/main.go` only when no existing group fits.

Canonical paths matter. Verify the final path with the CLI help tree before documenting it. For example, use `caracal agent pull` and `caracal doctor support`, not top-level aliases.

## 2. Use the table and JSON output contract

Register the shared format flag with `outputFlag(cmd)` (defined in `cmd/caracal/main.go`); it adds `--output`/`-o` with exactly two modes:

- `table`: default human output.
- `json`: machine-readable output.

Rules:

- Print JSON through the shared helpers in `cmd/caracal/main.go`: `outputJSONRaw` for server documents (it preserves the server's field order) and `outputJSON` for locally constructed values. Do not marshal ad hoc.
- Every dedicated list command returns `{ "items": [...], "total": N, "page": N, "page_size": N }`. The shared helpers append missing `total`, `page`, and `page_size` fields to item-bearing documents.
- Unpaginated lists use `page: 1` and `page_size: len(items)`, including `page_size: 0` when empty.
- The `caracal api` escape hatch preserves raw endpoint JSON and is the only top-level-array exception.
- Empty JSON results are still valid JSON. Do not return early with a human-only empty message before the JSON branch.
- JSON mode must not emit prompts, spinners, banners, or tables.
- Streams use JSON Lines, one object per line.
- Formatting must not change prompting, confirmation, dry-run behavior, file writes, or side effects.
- Do not overload the format option as a file destination. File paths need a separately named destination option.
- Use external `jq` for querying JSON. Do not embed another query language.

Keep table rendering after the JSON branch:

```go
if *mode == "json" {
	outputJSONRaw(raw)
	return nil
}
// human table rendering follows
```

## 3. Use the shared error contract

HTTP commands must use the shared client in `internal/cli/api`. `api.New(cliVersion)` builds an authenticated client from the effective configuration, and `client.Do(method, path, params, body, operation, resource)` maps HTTP status, connection, timeout, and invalid-response failures into the CLI contract while preserving server request IDs. Pass a human `operation` label and a `resource` label with each call.

Read and write CLI configuration only through `internal/cli/config`.

For local validation or filesystem failures, return a `*clierr.Error` rather than printing an error and exiting:

```go
return &clierr.Error{
	Category:    clierr.Validation,
	Message:     "Widget name is required.",
	Operation:   "Create widget",
	Resource:    "widget payload",
	Remediation: "Provide --name and retry.",
}
```

Every new error needs:

- A safe, precise message.
- A human operation label.
- A resource label when one exists.
- A concrete remediation.
- Internal detail only in the `Detail` field, which is rendered only when `CARACAL_DEBUG` is set.

Never include tokens, passwords, API keys, authorization headers, secret payload fields, or credentials in messages, resources, remediation, details, or logs.

### Exit codes

| Code | Category |
| ---: | --- |
| 0 | Success |
| 1 | Unexpected or uncategorized failure |
| 2 | Usage error |
| 3 | Authentication failure |
| 4 | Permission denied |
| 5 | Resource not found |
| 6 | State conflict |
| 7 | Validation failure |
| 8 | Rate limit reached |
| 9 | Network, service, or dependency unavailable |
| 10 | CLI and server version mismatch |

Exit codes come from the error category (`clierr.Error.ExitCode`). When JSON formatting is selected, `clierr.Emit` writes the failure to stderr as one JSON error document and stdout stays clean; otherwise it writes a human-readable error block. The JSON error document form activates only for commands that register the shared `--output` flag.

## 4. Preserve non-interactive and side-effect safety

Agents must be able to run the command without hidden prompts.

- Expose every required input as an argument or option.
- A JSON invocation must never prompt.
- Destructive commands need an explicit confirmation bypass consistent with neighboring commands.
- Add dry-run support when the operation writes files or makes a multi-resource mutation and preview is meaningful.
- Repeating the command must be safe or return a clear conflict.
- Validate all input before the first mutation whenever possible.
- Never report success before all required side effects complete.

## 5. Update documentation and bundled skills

When a command, path, argument, option, or behavior changes:

1. Update the matching page under `docs/cli/`.
2. Update every applicable bundled skill under `cmd/caracal/assets/skills/`. The skills are embedded into the `caracal` binary (`cmd/caracal/skillsync.go`) and installed into harnesses on login and doctor runs, so stale skill text ships with every release.

Bundled skills should use JSON explicitly for machine-readable workflows and must describe all inputs needed to avoid prompts.

## 6. Add the smallest complete tests

CLI behavior is covered by `go test ./...`. Put testable logic in packages under `internal/cli/` with colocated `*_test.go` files. At minimum, cover:

- Default table output and the JSON output shape.
- Empty JSON output remains valid and correctly shaped.
- Failures produce the expected category, exit code, operation, resource, remediation, and request ID.
- Debug-only detail is absent by default.
- Confirmation, dry-run, idempotence, file writes, and secret handling when applicable.

Mock external services and subprocesses. Do not require Docker for CLI unit tests.

## Done checklist

Before declaring the command complete:

- [ ] Canonical path is registered in the correct group.
- [ ] `Use` and `Short` strings are accurate.
- [ ] Structured output supports the shared `table` and `json` modes.
- [ ] JSON output and JSON errors contain no human-formatting noise.
- [ ] Paginated JSON has `items`, `total`, `page`, and `page_size`.
- [ ] Errors use shared categories, context, remediation, and request IDs.
- [ ] Non-interactive execution has no hidden prompts.
- [ ] Side effects are confirmation-safe and dry-run-safe where applicable.
- [ ] CLI docs and bundled skills in `cmd/caracal/assets/skills/` are updated.
- [ ] `gofmt`, `go vet ./...`, and `go test ./...` pass.
