// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { decideProjectGate, type ProjectGateInput } from "./project-gate.ts";

function input(overrides: Partial<ProjectGateInput> = {}): ProjectGateInput {
	return {
		isProjectFree: false,
		orgLoading: false,
		hasOrg: true,
		projectsLoading: false,
		currentProject: undefined,
		preferredProject: undefined,
		urlProjectInvalid: false,
		needsSelection: false,
		noProjects: false,
		...overrides,
	};
}

test("project-free routes always render without a project", () => {
	assert.deepEqual(decideProjectGate(input({ isProjectFree: true, hasOrg: false })), { kind: "render" });
});

test("a valid URL project renders the project-facing route", () => {
	assert.deepEqual(decideProjectGate(input({ currentProject: { slug: "platform" } })), { kind: "render" });
});

test("a missing project redirects to the deterministic preferred project", () => {
	assert.deepEqual(decideProjectGate(input({ preferredProject: { slug: "platform" } })), {
		kind: "redirect",
		projectSlug: "platform",
	});
});

test("several projects with no preference require an explicit pick", () => {
	assert.deepEqual(decideProjectGate(input({ needsSelection: true })), { kind: "picker" });
});

test("a URL project outside the org is rejected, not redirected", () => {
	// Even with a valid preferred project available, a bad URL is a hard reject.
	assert.deepEqual(
		decideProjectGate(input({ urlProjectInvalid: true, preferredProject: { slug: "platform" } })),
		{ kind: "notFound" },
	);
});

test("an org without projects is a setup state", () => {
	assert.deepEqual(decideProjectGate(input({ noProjects: true })), { kind: "noProjects" });
});

test("no org context defers to onboarding / org selection", () => {
	assert.deepEqual(decideProjectGate(input({ hasOrg: false })), { kind: "needsOrg" });
});

test("loading states gate rendering until context resolves", () => {
	assert.deepEqual(decideProjectGate(input({ orgLoading: true })), { kind: "loading" });
	assert.deepEqual(decideProjectGate(input({ projectsLoading: true })), { kind: "loading" });
});
