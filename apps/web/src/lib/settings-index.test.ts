// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("security settings expose sessions, not API keys", () => {
	const source = readFileSync(new URL("./settings-index.ts", import.meta.url), "utf8");
	assert.match(source, /hash: "sessions"/);
	assert.doesNotMatch(source, /api-keys/);
	assert.doesNotMatch(source, /API keys/);
});
