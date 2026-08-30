// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PERMISSIONS,
	canManageOrganization,
	hasAnyPermission,
	hasPermission,
} from "./permissions.ts";

test("hasPermission reads the server-supplied permission set", () => {
	const org = { permissions: [PERMISSIONS.orgView, PERMISSIONS.orgAuditRead] };
	assert.equal(hasPermission(org, PERMISSIONS.orgAuditRead), true);
	assert.equal(hasPermission(org, PERMISSIONS.orgMembersManage), false);
});

test("hasPermission fails closed for missing or absent permissions", () => {
	assert.equal(hasPermission(undefined, PERMISSIONS.orgView), false);
	assert.equal(hasPermission(null, PERMISSIONS.orgView), false);
	assert.equal(hasPermission({}, PERMISSIONS.orgView), false);
	assert.equal(hasPermission({ permissions: [] }, PERMISSIONS.orgView), false);
});

test("hasPermission keeps legacy owner/admin org management working when permissions are absent", () => {
	assert.equal(hasPermission({ role: "owner" }, PERMISSIONS.orgMembersManage), true);
	assert.equal(hasPermission({ role: "owner" }, PERMISSIONS.orgOwnershipTransfer), true);
	assert.equal(hasPermission({ role: "admin" }, PERMISSIONS.orgProjectsManage), true);
	assert.equal(hasPermission({ role: "admin" }, PERMISSIONS.orgOwnershipTransfer), false);
	assert.equal(hasPermission({ role: "member" }, PERMISSIONS.orgMembersManage), false);
	assert.equal(hasPermission({ role: "operator" }, PERMISSIONS.orgMembersManage), false);
});

test("server-supplied empty permissions override legacy role fallback", () => {
	assert.equal(hasPermission({ role: "owner", permissions: [] }, PERMISSIONS.orgMembersManage), false);
});

test("hasAnyPermission matches when at least one is present", () => {
	const org = { permissions: [PERMISSIONS.orgProjectsManage] };
	assert.equal(
		hasAnyPermission(org, [PERMISSIONS.orgMembersManage, PERMISSIONS.orgProjectsManage]),
		true,
	);
	assert.equal(hasAnyPermission(org, [PERMISSIONS.orgDelete]), false);
});

test("canManageOrganization requires an administrative capability, not a role", () => {
	assert.equal(canManageOrganization({ permissions: [PERMISSIONS.orgView] }), false);
	assert.equal(canManageOrganization({ permissions: [PERMISSIONS.orgMembersManage] }), true);
	assert.equal(canManageOrganization({ permissions: [PERMISSIONS.orgProjectsManage] }), true);
	assert.equal(canManageOrganization({ permissions: [PERMISSIONS.orgUpdate] }), true);
});
