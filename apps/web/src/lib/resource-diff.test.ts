// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCleanYaml,
	buildComponentYaml,
	formatBlockYaml,
	simpleUnifiedDiff,
	stripMeta,
	toReviewYaml,
} from "./resource-diff.ts";

test("stripMeta drops metadata and empty values but keeps falsy data", () => {
	const got = stripMeta({
		id: "x",
		listing_id: "y",
		created_at: "now",
		status: "approved",
		name: "tool",
		count: 0,
		enabled: false,
		empty: "",
		missing: null,
	});
	assert.deepEqual(got, { name: "tool", count: 0, enabled: false });
});

test("formatBlockYaml renders scalars on their own indented line", () => {
	assert.equal(formatBlockYaml({ version: "1.0.0" }), "version:\n  1.0.0");
});

test("formatBlockYaml renders multi-line strings as literal blocks", () => {
	assert.equal(
		formatBlockYaml({ prompt: "line one\nline two" }),
		"prompt: |\n  line one\n  line two",
	);
});

test("formatBlockYaml renders arrays and nested objects", () => {
	const got = formatBlockYaml({
		harnesses: ["kiro", "cursor"],
		components: [{ type: "mcp", name: "github" }],
		limits: { cpu: 2 },
		skipped: [],
		blank: "",
	});
	assert.equal(
		got,
		[
			"harnesses:",
			"  - kiro",
			"  - cursor",
			"components:",
			"  - type: mcp",
			"    name: github",
			"limits:",
			"  cpu: 2",
		].join("\n"),
	);
});

test("toReviewYaml composes stripMeta with the YAML projection", () => {
	assert.equal(toReviewYaml({ id: "meta", version: "2.0.0" }), "version:\n  2.0.0");
});

test("buildComponentYaml keeps content fields and drops empty containers", () => {
	const got = buildComponentYaml({
		id: "meta",
		status: "pending",
		name: "hook",
		event: "Stop",
		handler_config: {},
		tags: [],
	});
	assert.equal(got, "name:\n  hook\nevent:\n  Stop");
});

test("buildCleanYaml merges cached component data under the link's overrides", () => {
	const cache = new Map<string, Record<string, unknown>>([
		["c1", { description: "cached desc", version: "0.9.0", template: "T" }],
	]);
	const got = buildCleanYaml(
		{
			version: "1.0.0",
			components: [
				{ component_id: "c1", component_type: "prompt", name: "greeting", version: "1.1.0" },
				{ component_id: "c2", component_type: "mcp" },
			],
		},
		cache,
	);
	const lines = got.split("\n");
	assert.equal(lines[0], "version:");
	assert.ok(got.includes("- type: prompt"), got);
	assert.ok(got.includes("name: greeting"), got);
	assert.ok(got.includes("description: cached desc"), got);
	// The link's own version wins over the cached listing version.
	assert.ok(got.includes("version: 1.1.0"), got);
	assert.ok(got.includes("template: T"), got);
	// A component with no resolvable name renders the placeholder.
	assert.ok(got.includes("name: (pending)"), got);
});

test("simpleUnifiedDiff is empty for identical inputs", () => {
	assert.equal(simpleUnifiedDiff("same", "same", "a", "b"), "");
});

test("simpleUnifiedDiff marks changed lines with a positional hunk", () => {
	const got = simpleUnifiedDiff("a\nb\nc", "a\nx\nc", "v1", "v2");
	assert.equal(got, ["--- v1", "+++ v2", "@@ -2 +2 @@", "-b", "+x", " c"].join("\n"));
});

test("simpleUnifiedDiff handles appended lines", () => {
	const got = simpleUnifiedDiff("a", "a\nb", "v1", "v2");
	assert.equal(got, ["--- v1", "+++ v2", "@@ -2 +2 @@", "+b"].join("\n"));
});
