// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Host/path tenancy resolution: {org}.{host}/{project}/... is the canonical
// URL shape. The org lives in the host (dev equivalent: {org}.localhost, which
// browsers resolve natively), and the project is the first path segment,
// implemented as the router basepath so every existing route and link works
// unchanged under the prefix. The server independently validates the host org
// against the path org on scoped API calls (409 on mismatch) and membership
// on every request - the URL is presentation, never authorization.

// Subdomain labels that are infrastructure, never an organization.
const GENERIC_SUBDOMAINS = new Set(["www", "api", "app", "sso", "auth", "cdn", "static"]);

export interface TenantLocation {
	/** Org slug carried by the host, or null on an apex/plain host. */
	hostOrg: string | null;
	/** Project slug carried by the first non-route path segment, in every mode. */
	urlProject: string | null;
}

let tenant: TenantLocation = { hostOrg: null, urlProject: null };

// Whether the deployment addresses organizations as subdomains. Set from the
// server's public config; until it loads, and for single-host deployments, org
// context stays on the current origin so a session is never crossed away to a
// subdomain that cannot carry it (e.g. host-only cookies on *.localhost).
let orgSubdomainsEnabled = false;

/** Record whether this deployment addresses organizations as subdomains. */
export function configureOrgSubdomains(enabled: boolean): void {
	orgSubdomainsEnabled = enabled;
}

/** Org slug from the hostname: {slug}.localhost in dev, {slug}.{base} in prod. */
export function orgSlugFromHost(hostname: string): string | null {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host === "127.0.0.1") return null;
	if (host.endsWith(".localhost")) {
		const label = host.slice(0, -".localhost".length);
		return label && !label.includes(".") && !GENERIC_SUBDOMAINS.has(label) ? label : null;
	}
	const parts = host.split(".");
	if (parts.length >= 3 && !GENERIC_SUBDOMAINS.has(parts[0])) return parts[0];
	return null;
}

/** Whether this host family can address organizations as subdomains. */
export function supportsOrgSubdomains(hostname: string): boolean {
	// Single-host deployments (no configured base domain) never use subdomains,
	// so org context stays on the current origin and the session is preserved.
	if (!orgSubdomainsEnabled) return false;
	const host = hostname.toLowerCase();
	return host === "localhost" || host.endsWith(".localhost") || orgSlugFromHost(host) !== null;
}

/** Origin for an organization's subdomain, preserving protocol and port. */
export function orgOrigin(slug: string, loc: Pick<Location, "hostname" | "port" | "protocol"> = window.location): string {
	const host = loc.hostname.toLowerCase();
	let base: string;
	if (host === "localhost" || host.endsWith(".localhost")) {
		base = "localhost";
	} else {
		const parts = host.split(".");
		base = (orgSlugFromHost(host) ? parts.slice(1) : parts).join(".");
	}
	const port = loc.port ? `:${loc.port}` : "";
	return `${loc.protocol}//${slug}.${base}${port}`;
}

/**
 * The canonical, org-free origin that always hosts the auth surface. Auth
 * pages must never render on an org subdomain, so any org label is stripped to
 * the base host (dev: localhost; prod: the configured base domain). The
 * decision is host-based (the same synchronous host->org signal that sets
 * hostOrg), so it holds even before the async deployment config loads.
 */
export function canonicalAuthOrigin(
	loc: Pick<Location, "hostname" | "port" | "protocol"> = window.location,
): string {
	const host = loc.hostname.toLowerCase();
	const port = loc.port ? `:${loc.port}` : "";
	if (!orgSlugFromHost(host)) return `${loc.protocol}//${host}${port}`;
	const base = host.endsWith(".localhost") ? "localhost" : host.split(".").slice(1).join(".");
	return `${loc.protocol}//${base}${port}`;
}

/**
 * The canonical auth origin as an absolute prefix, or "" when the current
 * origin already is canonical - so login links stay relative except when they
 * must escape an org subdomain.
 */
export function canonicalAuthOriginPrefix(
	loc: Pick<Location, "hostname" | "port" | "protocol" | "host"> | undefined =
		typeof window !== "undefined" ? window.location : undefined,
): string {
	if (!loc || !loc.hostname) return "";
	const canonical = canonicalAuthOrigin(loc);
	return canonical === `${loc.protocol}//${loc.host}` ? "" : canonical;
}

/**
 * First URL segments owned by application routes, derived from the router's
 * resolved full paths (layout segments already stripped there), so a route
 * rename can never be shadowed by a project slug prefix.
 */
export function firstSegmentsFromPaths(fullPaths: Iterable<string>): Set<string> {
	const reserved = new Set<string>();
	for (const fullPath of fullPaths) {
		const segment = fullPath.split("/").find(Boolean);
		if (segment && !segment.startsWith("$")) reserved.add(segment.toLowerCase());
	}
	return reserved;
}

/** The project slug prefix in a pathname, if the first segment is not a route. */
export function projectSlugFromPath(pathname: string, reserved: Set<string>): string | null {
	const segment = pathname.split("/").filter(Boolean)[0] ?? "";
	if (!segment || reserved.has(segment)) return null;
	return segment.toLowerCase();
}

/** The in-app path with the current project prefix removed. */
export function pathWithoutProjectPrefix(pathname: string, urlProject: string | null): string {
	const prefix = urlProject ? `/${urlProject.toLowerCase()}` : "";
	const path = pathname.toLowerCase();
	if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) {
		const rest = pathname.slice(prefix.length);
		return rest.startsWith("/") ? rest : `/${rest || ""}` || "/";
	}
	return pathname || "/";
}

// Surfaces scoped to the organization or the account, not to a project.
// They live UNPREFIXED on an org host: {org}.{host}/organization, never
// {org}.{host}/{project}/organization.
const PROJECT_FREE_PREFIXES = ["/organization", "/settings", "/onboarding", "/operator"];

const PROJECT_ROUTE_PREFIXES = new Set(["resources", "agents", "components", "traces", "intelligence", "inbox"]);

export function isProjectFreePath(pathname: string): boolean {
	const path = pathname.toLowerCase();
	return PROJECT_FREE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** The unprefixed destination when a project-free route carries a project prefix. */
export function canonicalProjectFreePath(pathname: string, urlProject: string | null): string | null {
	if (!urlProject) return null;
	const unprefixed = pathWithoutProjectPrefix(pathname, urlProject);
	return isProjectFreePath(unprefixed) ? unprefixed : null;
}

// Auth surfaces are canonical: base host, bare route, never a project prefix,
// so an unauthenticated request can never expose an org-specific auth URL.
const AUTH_PREFIXES = ["/login", "/register", "/device", "/operator-login"];

export function isAuthPath(pathname: string): boolean {
	const path = pathname.toLowerCase();
	return AUTH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * When the current URL is an auth route reached on an org host or under a
 * project prefix, the canonical org-free URL to replace it with, else null.
 * The query (carrying a sanitized `next`) is preserved unchanged.
 */
export function canonicalAuthUrl(
	loc: Pick<Location, "hostname" | "port" | "protocol" | "pathname" | "search" | "hash" | "host"> = window.location,
	urlProject: string | null = tenant.urlProject,
): string | null {
	const inApp = pathWithoutProjectPrefix(loc.pathname, urlProject);
	if (!isAuthPath(inApp)) return null;
	const canonicalOrigin = canonicalAuthOrigin(loc);
	if (canonicalOrigin === `${loc.protocol}//${loc.host}` && inApp === loc.pathname) return null;
	return `${canonicalOrigin}${inApp}${loc.search}${loc.hash}`;
}

/** Build an absolute project-facing URL path from a validated project slug. */
export function projectRoutePath(projectSlug: string, routePath: string): string {
	const path = routePath.startsWith("/") ? routePath : `/${routePath}`;
	return `/${projectSlug}${path === "/" ? "/" : path}`;
}

/**
 * Rebuild an auth/onboarding return path under the newly authorized project.
 * A stale leading project is replaced when the following segment is a known
 * project route; project-free organization/account routes remain unprefixed.
 */
export function projectEntryPath(projectSlug: string, candidate: string): string {
	if (isProjectFreePath(candidate)) return candidate;
	const [path, suffix = ""] = candidate.split(/(?=[?#])/u, 2);
	const segments = path.split("/").filter(Boolean);
	if (segments[0] === projectSlug) return candidate;
	if (segments.length === 0) return projectRoutePath(projectSlug, "/") + suffix;
	if (PROJECT_ROUTE_PREFIXES.has(segments[0])) return projectRoutePath(projectSlug, path) + suffix;
	if (segments.length === 1 || PROJECT_ROUTE_PREFIXES.has(segments[1])) {
		const withoutStaleProject = `/${segments.slice(1).join("/")}`;
		return projectRoutePath(projectSlug, withoutStaleProject) + suffix;
	}
	return projectRoutePath(projectSlug, path) + suffix;
}

/** Resolve and freeze the tenant carried by the current URL. Call once at boot. */
export function initTenant(
	reservedSegments: Set<string>,
	loc: Pick<Location, "hostname" | "pathname"> = window.location,
): TenantLocation {
	const hostOrg = orgSlugFromHost(loc.hostname);
	// The project is the first non-route path segment in every mode. It is the
	// router basepath, so project-facing routes only ever render under a
	// `/{project}/…` prefix; the org is authoritative from the host (subdomain
	// deployments) or the authenticated session (single-host deployments), and
	// the server validates that the project belongs to that org on every call.
	const urlProject = projectSlugFromPath(loc.pathname, reservedSegments);
	tenant = { hostOrg, urlProject };
	return tenant;
}

export function getTenant(): TenantLocation {
	return tenant;
}
