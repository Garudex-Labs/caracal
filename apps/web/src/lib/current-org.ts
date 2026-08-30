// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { Organization } from "./types/org.ts";

export type OrgResolution = {
	currentOrg: Organization | undefined;
	selectionInvalid: boolean;
	shouldRemember: boolean;
};

export function resolveCurrentOrg(
	orgs: Organization[],
	storedSlug: string,
	hostOrg?: string | null,
): OrgResolution {
	const requestedSlug = hostOrg ?? storedSlug;
	if (requestedSlug) {
		const requested = orgs.find((org) => org.slug === requestedSlug);
		if (requested) {
			return { currentOrg: requested, selectionInvalid: false, shouldRemember: !!hostOrg && storedSlug !== requested.slug };
		}
		if (!hostOrg && orgs.length === 1) {
			return { currentOrg: orgs[0], selectionInvalid: false, shouldRemember: storedSlug !== orgs[0].slug };
		}
		return { currentOrg: undefined, selectionInvalid: true, shouldRemember: false };
	}
	if (orgs.length === 1) {
		return { currentOrg: orgs[0], selectionInvalid: false, shouldRemember: storedSlug !== orgs[0].slug };
	}
	return { currentOrg: undefined, selectionInvalid: false, shouldRemember: false };
}
