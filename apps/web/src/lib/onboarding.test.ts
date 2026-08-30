// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { accessibleProjectCount, onboardingStagePath, resolveEntry } from "./onboarding.ts";
import type { OnboardingSnapshot } from "./types/org.ts";

function snap(orgs: OnboardingSnapshot["organizations"]): OnboardingSnapshot {
	return {
		profile: { completed: true, name: "A", username: "a", email: "a@x.dev" },
		organizations: orgs,
		invitations: [],
		next_step: "done",
	};
}

const project = (slug: string, isDefault = false) => ({ slug, name: slug, is_default: isDefault, role: null });

test("onboardingStagePath maps every step", () => {
	assert.equal(onboardingStagePath("profile"), "/onboarding/profile");
	assert.equal(onboardingStagePath("organization"), "/onboarding/organization");
	assert.equal(onboardingStagePath("project"), "/onboarding/project");
	assert.equal(onboardingStagePath("done"), "/onboarding");
});

test("resolveEntry: no accessible projects means no entry", () => {
	assert.equal(resolveEntry(snap([]), null, {}), null);
	assert.equal(resolveEntry(snap([{ slug: "acme", name: "Acme", role: "member", projects: [] }]), "acme", {}), null);
});

test("resolveEntry: single org and project enters directly", () => {
	const s = snap([{ slug: "acme", name: "Acme", role: "owner", projects: [project("acme", true)] }]);
	assert.deepEqual(resolveEntry(s, null, {}), { orgSlug: "acme", projectSlug: "acme" });
});

test("resolveEntry: remembered context wins while still valid", () => {
	const s = snap([
		{ slug: "acme", name: "Acme", role: "owner", projects: [project("acme", true), project("lab")] },
		{ slug: "beta", name: "Beta", role: "member", projects: [project("app")] },
	]);
	assert.deepEqual(resolveEntry(s, "beta", { beta: "app" }), { orgSlug: "beta", projectSlug: "app" });
	assert.deepEqual(resolveEntry(s, "acme", { acme: "lab" }), { orgSlug: "acme", projectSlug: "lab" });
});

test("resolveEntry: stale remembered project never re-enters", () => {
	const s = snap([{ slug: "acme", name: "Acme", role: "member", projects: [project("kept")] }]);
	// The remembered project was revoked; the single live one is used instead.
	assert.deepEqual(resolveEntry(s, "acme", { acme: "revoked" }), { orgSlug: "acme", projectSlug: "kept" });
});

test("resolveEntry: ambiguity yields null (explicit selection)", () => {
	const multiOrg = snap([
		{ slug: "acme", name: "Acme", role: "owner", projects: [project("a")] },
		{ slug: "beta", name: "Beta", role: "member", projects: [project("b")] },
	]);
	assert.equal(resolveEntry(multiOrg, null, {}), null);
	const multiProject = snap([
		{ slug: "acme", name: "Acme", role: "owner", projects: [project("a"), project("b")] },
	]);
	assert.equal(resolveEntry(multiProject, "acme", {}), null);
});

test("resolveEntry: an org with no projects never counts as a candidate", () => {
	const s = snap([
		{ slug: "empty", name: "Empty", role: "member", projects: [] },
		{ slug: "acme", name: "Acme", role: "member", projects: [project("a")] },
	]);
	// The remembered org has no access: fall through to the only real candidate.
	assert.deepEqual(resolveEntry(s, "empty", {}), { orgSlug: "acme", projectSlug: "a" });
});

test("accessibleProjectCount totals across organizations", () => {
	const s = snap([
		{ slug: "acme", name: "Acme", role: "owner", projects: [project("a"), project("b")] },
		{ slug: "beta", name: "Beta", role: "member", projects: [] },
	]);
	assert.equal(accessibleProjectCount(s), 2);
});
