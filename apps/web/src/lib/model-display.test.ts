// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { annotateForDisplay, formatModel } from "./model-display.ts";

test("server-computed display passes through untouched", () => {
	const got = formatModel({
		model_id: "claude-sonnet-4-5",
		display: { primary: "Claude Sonnet 4.5", secondary: "Sep 29, 2025", is_rolling: false },
	});
	assert.deepEqual(got, { primary: "Claude Sonnet 4.5", secondary: "Sep 29, 2025", isRolling: false });
});

test("disambiguation fills a missing secondary from rolling status or release date", () => {
	const rolling = formatModel({
		model_id: "gpt-5",
		display: { primary: "GPT-5", secondary: null, is_rolling: true },
		disambiguate: true,
	});
	assert.equal(rolling.secondary, "latest");

	const dated = formatModel({
		model_id: "gpt-5",
		release_date: "2025-08-07",
		display: { primary: "GPT-5", secondary: null, is_rolling: false },
		disambiguate: true,
	});
	assert.equal(dated.secondary, "Aug 7, 2025");

	const badDate = formatModel({
		model_id: "gpt-5",
		release_date: "not-a-date",
		display: { primary: "GPT-5", secondary: null, is_rolling: false },
		disambiguate: true,
	});
	assert.equal(badDate.secondary, null);
});

test("without disambiguation a missing secondary stays null", () => {
	const got = formatModel({
		model_id: "gpt-5",
		release_date: "2025-08-07",
		display: { primary: "GPT-5", secondary: null, is_rolling: false },
	});
	assert.equal(got.secondary, null);
});

test("fallback path derives rolling status from the model id shape", () => {
	const rolling = formatModel({ model_id: "claude-sonnet-4-5" });
	assert.equal(rolling.isRolling, true);
	assert.equal(rolling.primary, "claude-sonnet-4-5");

	assert.equal(formatModel({ model_id: "claude-3-5-sonnet-20241022" }).isRolling, false);
	assert.equal(formatModel({ model_id: "gemini-pro-2025-01-15" }).isRolling, false);
});

test("fallback prefers the display name and trims it", () => {
	const got = formatModel({ model_id: "raw-id", display_name: "  Nice Name  " });
	assert.equal(got.primary, "Nice Name");
});

test("annotateForDisplay maps rows without forcing disambiguation", () => {
	const rows = annotateForDisplay([
		{ model_id: "m1", display: { primary: "M1", secondary: null, is_rolling: true } },
		{ model_id: "m2-20250101" },
	]);
	assert.equal(rows[0].display.primary, "M1");
	assert.equal(rows[0].display.secondary, null);
	assert.equal(rows[1].display.primary, "m2-20250101");
	assert.equal(rows[1].display.isRolling, false);
});
