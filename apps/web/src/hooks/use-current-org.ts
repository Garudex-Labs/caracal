// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Shared "current organization" context - the tenant boundary the app
// operates in. A stored or host selection only counts while it matches a
// real membership. A single server-validated org resolves naturally; several
// orgs still require an explicit pick so the app never enters an arbitrary
// tenant.
//
// The value is a per-browser UI default and is never trusted for access:
// every org API call is path-scoped and membership is validated per request.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useOrgs } from "@/hooks/use-orgs-api";
import { resolveCurrentOrg } from "@/lib/current-org";
import { getTenant, orgOrigin, supportsOrgSubdomains } from "@/lib/tenant-host";
import type { Organization } from "@/lib/types";

const STORAGE_KEY = "caracal_current_org";
const CHANGE_EVENT = "caracal:org-changed";

function subscribe(cb: () => void) {
	// `storage` covers other tabs; the custom event covers this tab.
	window.addEventListener("storage", cb);
	window.addEventListener(CHANGE_EVENT, cb);
	return () => {
		window.removeEventListener("storage", cb);
		window.removeEventListener(CHANGE_EVENT, cb);
	};
}

const getSnapshot = () => localStorage.getItem(STORAGE_KEY) ?? "";
const getServerSnapshot = () => "";

export function setCurrentOrgSlug(slug: string) {
	localStorage.setItem(STORAGE_KEY, slug);
	window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** The remembered org slug - a UI preference, never proof of membership. */
export function getRememberedOrgSlug(): string | null {
	return localStorage.getItem(STORAGE_KEY);
}

export interface CurrentOrgState {
	/** Organizations the user belongs to (server-validated memberships). */
	orgs: Organization[];
	isLoading: boolean;
	/** The explicitly selected org, only while it matches a membership. */
	currentOrg: Organization | undefined;
	/** True when a selection exists but no longer matches any membership. */
	selectionInvalid: boolean;
	setCurrentOrg: (slug: string) => void;
}

export function useCurrentOrg(): CurrentOrgState {
	const orgsQuery = useOrgs();
	const storedSlug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	// The host is the tenant boundary: an org subdomain always outranks the
	// stored preference (the server independently rejects host/path mismatches).
	const hostOrg = getTenant().hostOrg;
	const orgs = orgsQuery.data ?? [];
	const { currentOrg, selectionInvalid, shouldRemember } = resolveCurrentOrg(orgs, storedSlug, hostOrg);

	// Keep the per-org project memory and onboarding preselection keyed
	// correctly when the org arrived via the host rather than an in-app selection.
	useEffect(() => {
		if (currentOrg && shouldRemember && localStorage.getItem(STORAGE_KEY) !== currentOrg.slug) {
			setCurrentOrgSlug(currentOrg.slug);
		}
	}, [currentOrg, shouldRemember]);

	const setCurrentOrg = useCallback((slug: string) => {
		setCurrentOrgSlug(slug);
		if (slug === getTenant().hostOrg) return; // already on this org's host
		// Switching organization must never keep the previous org's project in
		// the URL. Both modes navigate to a project-free entry so the project
		// gate resolves a project belonging to the NEWLY selected org.
		if (supportsOrgSubdomains(window.location.hostname)) {
			// The org lives in the host: land on its subdomain root.
			window.location.assign(`${orgOrigin(slug)}/`);
		} else {
			// Single-host deployment: drop the now-foreign project prefix.
			window.location.assign("/");
		}
	}, []);
	return {
		orgs,
		isLoading: orgsQuery.isLoading,
		currentOrg,
		selectionInvalid: !orgsQuery.isLoading && selectionInvalid,
		setCurrentOrg,
	};
}
