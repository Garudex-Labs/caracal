// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { resolveCurrentProject } from "./current-project.ts";
import type { Project } from "./types/org.ts";

function project(slug: string): Project {
	return {
		id: `p-${slug}`,
		organization_id: "o1",
		slug,
		name: slug,
		description: null,
		created_at: "2026-01-01T00:00:00Z",
		is_default: false,
	} as Project;
}

const one = [project("platform")];
const many = [project("platform"), project("payments")];

test("a valid URL project is the authoritative current project", () => {
	const r = resolveCurrentProject(many, "payments", undefined, true);
	assert.equal(r.currentProject?.slug, "payments");
	assert.equal(r.urlProjectInvalid, false);
	assert.equal(r.needsSelection, false);
});

test("a URL project outside the org is invalid, never silently swapped", () => {
	const r = resolveCurrentProject(many, "ghost", "platform", true);
	assert.equal(r.currentProject, undefined);
	assert.equal(r.urlProjectInvalid, true);
	// A remembered project must NOT become the current context for a bad URL.
	assert.equal(r.preferredProject?.slug, "platform");
});

test("no URL project resolves a single project as the preferred target", () => {
	const r = resolveCurrentProject(one, null, undefined, true);
	assert.equal(r.currentProject, undefined);
	assert.equal(r.preferredProject?.slug, "platform");
	assert.equal(r.needsSelection, false);
});

test("no URL project with several and no memory requires an explicit pick", () => {
	const r = resolveCurrentProject(many, null, undefined, true);
	assert.equal(r.preferredProject, undefined);
	assert.equal(r.needsSelection, true);
});

test("a remembered project is preferred only while it still exists", () => {
	assert.equal(resolveCurrentProject(many, null, "payments", true).preferredProject?.slug, "payments");
	// Stale memory pointing at a removed project falls through to selection.
	const stale = resolveCurrentProject(many, null, "deleted", true);
	assert.equal(stale.preferredProject, undefined);
	assert.equal(stale.needsSelection, true);
});

test("an org with no projects is a setup state, not a selection", () => {
	const r = resolveCurrentProject([], null, "anything", true);
	assert.equal(r.noProjects, true);
	assert.equal(r.needsSelection, false);
	assert.equal(r.currentProject, undefined);
});

test("nothing resolves until the project list has loaded", () => {
	const r = resolveCurrentProject([], "platform", "platform", false);
	assert.equal(r.currentProject, undefined);
	assert.equal(r.urlProjectInvalid, false);
	assert.equal(r.needsSelection, false);
	assert.equal(r.noProjects, false);
});
