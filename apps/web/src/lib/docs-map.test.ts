// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PAGE_DOCS, SECTION_DOCS, SETTING_DOCS, type DocRef } from "./docs-map.ts";

const allRefs: Array<[string, DocRef]> = [
	...Object.entries(SETTING_DOCS),
	...Object.entries(SECTION_DOCS),
	...Object.entries(PAGE_DOCS),
];

test("every doc reference carries a label and a docs-relative markdown path", () => {
	assert.ok(allRefs.length > 0);
	for (const [key, ref] of allRefs) {
		assert.ok(ref.label.trim().length > 0, `${key} needs a label`);
		assert.ok(ref.file.endsWith(".md"), `${key} must point at a markdown file: ${ref.file}`);
		assert.ok(!ref.file.startsWith("/"), `${key} must stay relative to docs/: ${ref.file}`);
		assert.ok(!ref.file.split("/").includes(".."), `${key} must not escape docs/: ${ref.file}`);
		assert.ok(!ref.file.includes("#"), `${key} must keep the anchor out of the path: ${ref.file}`);
	}
});

test("anchors are bare lowercase kebab fragments", () => {
	for (const [key, ref] of allRefs) {
		if (ref.anchor === undefined) continue;
		assert.match(ref.anchor, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${key} anchor: ${ref.anchor}`);
	}
});

test("setting keys are section-qualified dotted keys", () => {
	for (const key of Object.keys(SETTING_DOCS)) {
		assert.match(key, /^[a-z_]+\.[a-z_]+$/, `setting key: ${key}`);
	}
});

test("referenced doc files resolve under the repo docs directory", () => {
	// traces.detail points at self-hosting/telemetry.md, which does not exist yet.
	const knownDangling = new Set(["self-hosting/telemetry.md"]);
	const docsRoot = fileURLToPath(new URL("../../../../docs/", import.meta.url));
	const missing = [...new Set(allRefs.map(([, ref]) => ref.file))].filter(
		(file) => !knownDangling.has(file) && !existsSync(docsRoot + file),
	);
	assert.deepEqual(missing, []);
});
