// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Route table for the dev-only mock API. Paths are relative to /api/v1.
// Add a route here when a page you are iterating on hits an unmocked endpoint
// (the plugin logs a 404 with the exact method and path).

import type { HarnessEntry, RegistryType } from "../src/lib/api";
import {
	MOCK_USER,
	MOCK_USERS,
	MOCK_REGISTRY,
	MOCK_OVERVIEW_STATS,
	MOCK_TOP_MCPS,
	MOCK_TOP_AGENTS,
	mockIntelligenceBriefing,
	mockIntelligenceResources,
	mockIntelligenceCompare,
	mockIntelligenceHistory,
	mockIntelligenceResourceVersions,
	MOCK_TOKEN_STATS,
	MOCK_HARNESS_USAGE,
	MOCK_SESSIONS,
	MOCK_TELEMETRY_STATUS,
	MOCK_REVIEW_ITEMS,
	MOCK_INBOX_ITEMS,
	MOCK_INBOX_COUNTS,
	MOCK_ORGS,
	MOCK_ORG_MEMBERS,
	MOCK_ORG_INVITATIONS,
	MOCK_ONBOARDING,
	MOCK_PROJECTS,
	MOCK_PROJECT_MEMBERS,
	MOCK_PROJECT_RESOURCES,
	MOCK_DELETED_AGENTS,
	MOCK_RESOURCE_RETENTION_POLICIES,
	orgPermissions,
	projectPermissions,
	MOCK_RECOMMENDATIONS,
	MOCK_PUBLIC_CONFIG,
	MOCK_VERSION_SUGGESTIONS,
	MOCK_SETTINGS_SCHEMA,
	MOCK_ADMIN_SETTINGS,
	MOCK_ADMIN_STATE,
	MOCK_AUDIT_LOG,
	MOCK_SECURITY_EVENTS,
	MOCK_ORG_AUDIT_LOG,
	MOCK_ORG_SECURITY_EVENTS,
	MOCK_SYSTEM_STATUS,
	MOCK_RETENTION_WARNINGS,
	MOCK_EXEC_ADOPTION,
	MOCK_EXEC_AGENT_COUNTS,
	MOCK_EXEC_USAGE_BY_CATEGORY,
	MOCK_EXEC_PLATFORM_COVERAGE,
	MOCK_EXEC_PLATFORMS,
	MOCK_EXEC_VELOCITY,
	MOCK_EXEC_TOP_AGENTS,
	MOCK_EXEC_DEPARTMENTS,
	MOCK_EXEC_DEPT_TOKENS,
	MOCK_EXEC_COST_SUMMARY,
	MOCK_EXEC_ROI,
	MOCK_EXEC_STRATEGIC,
	MOCK_EXEC_DEVELOPERS,
	MOCK_EXEC_INACTIVITY,
	MOCK_EXEC_TIME_TO_VALUE,
	MOCK_EXEC_AI_INSIGHTS,
	MOCK_EXEC_STATE,
	FALLBACK_HARNESSES,
	GENERIC_MODELS,
	findRegistryItem,
	mockAgentVersions,
	mockAgentVersionDetail,
	mockComponentVersions,
	mockComponentVersionDetail,
	mockSessionData,
	mockTrends,
} from "./data";

export interface MockRequest {
	method: string;
	path: string;
	params: Record<string, string>;
	query: URLSearchParams;
	body: unknown;
}

export interface MockResponse {
	status: number;
	body?: unknown;
}

type HandlerFn = (req: MockRequest) => MockResponse | unknown;

interface Route {
	method: string;
	segments: string[];
	handler: HandlerFn;
}

const REGISTRY_TYPES: RegistryType[] = ["agents", "mcps", "skills", "hooks", "prompts"];

// The caller's one in-flight draft per component type; it resolves by id and
// appears in /resources under include_unpublished so the owner manages it on
// the component's own page.
function myDraft(type: RegistryType) {
	const base = MOCK_REGISTRY[type][0];
	return {
		...base,
		id: `draft-${type}`,
		slug: `${base.slug}-draft`,
		qualified_name: `${base.qualified_name}-draft`,
		name: `${base.name}-draft`,
		status: "draft",
		user_permission: "owner",
	};
}

const SINGULAR: Record<string, RegistryType> = {
	agent: "agents",
	mcp: "mcps",
	skill: "skills",
	hook: "hooks",
	prompt: "prompts",
};

function json(status: number, body: unknown): MockResponse {
	return { status, body };
}

function notFound(detail: string): MockResponse {
	return json(404, { detail });
}

const ACTIVITY_PAGE_SIZES = [20, 50, 100];

interface ActivityRow {
	event_id: string;
	timestamp: string;
}

// paginateOrgList mirrors the server's bounded offset pagination for the org
// roster and project listings: an envelope with the slice plus total/page/
// page_size. Search/filter/sort are applied by the caller before slicing.
function paginateOrgList<T>(rows: T[], req: MockRequest, key: "members" | "projects") {
	const page = Math.max(1, Number(req.query.get("page") ?? "1") || 1);
	const pageSize = Math.min(200, Math.max(1, Number(req.query.get("page_size") ?? "50") || 50));
	const start = (page - 1) * pageSize;
	return { [key]: rows.slice(start, start + pageSize), total: rows.length, page, page_size: pageSize };
}

function projectMemberRole(orgRole: string, assignedRole?: string | null) {
	return orgRole === "owner" || orgRole === "admin" ? "lead" : (assignedRole ?? "user");
}

function projectAccessRows(orgSlug: string, projectSlug: string) {
	const orgMembers = MOCK_ORG_MEMBERS[orgSlug] ?? [];
	const projectMembers = MOCK_PROJECT_MEMBERS[projectSlug] ?? [];
	return orgMembers
		.map((member) => {
			const assigned = projectMembers.find((candidate) => candidate.id === member.id)?.role ?? null;
			const inherited = member.role === "owner" || member.role === "admin";
			if (!inherited && !assigned) return null;
			const role = projectMemberRole(member.role, assigned);
			return {
				id: member.id,
				email: member.email,
				username: member.username,
				name: member.name,
				role,
				org_role: member.role,
				assigned_role: assigned,
				access_source: inherited ? "organization" : "project",
				permissions: projectPermissions(member.role, role),
				created_at: member.created_at ?? new Date().toISOString(),
			};
		})
		.filter((row): row is NonNullable<typeof row> => row !== null);
}

function syncProjectMemberCounts(orgSlug: string) {
	for (const project of MOCK_PROJECTS[orgSlug] ?? []) {
		project.member_count = projectAccessRows(orgSlug, project.slug).length;
	}
}

// paginateActivity mirrors the server's cursor pagination: equality filtering
// at the "data layer", a stable (timestamp, event_id) total order, and an
// opaque forward-only cursor. filterKeys map a query key to its column
// (actor -> actor_email).
function paginateActivity<T extends ActivityRow>(rows: T[], req: MockRequest, filterKeys: string[]) {
	const sort = req.query.get("sort");
	const asc = sort === "oldest" || (!sort && req.query.get("dir") === "asc");
	const requestedPageSize = Number(req.query.get("page_size") ?? "20") || 20;
	const pageSize = ACTIVITY_PAGE_SIZES.includes(requestedPageSize) ? requestedPageSize : 20;
	let filtered = rows.filter((row) =>
		filterKeys.every((key) => {
			const wanted = req.query.get(key);
			if (!wanted) return true;
			const column = key === "actor" ? "actor_email" : key;
			return String((row as Record<string, unknown>)[column] ?? "") === wanted;
		}),
	);
	const category = req.query.get("category");
	if (category) {
		filtered = filtered.filter((row) => securityEventCategory(String((row as Record<string, unknown>).event_type ?? "")) === category);
	}
	const target = (req.query.get("target") ?? "").trim().toLowerCase();
	if (target) {
		filtered = filtered.filter((row) =>
			["target_type", "target_id", "detail"].some((key) =>
				String((row as Record<string, unknown>)[key] ?? "").toLowerCase().includes(target),
			),
		);
	}
	const resource = (req.query.get("resource") ?? "").trim().toLowerCase();
	if (resource) {
		filtered = filtered.filter((row) =>
			["resource_type", "resource_id", "resource_name", "http_path"].some((key) =>
				String((row as Record<string, unknown>)[key] ?? "").toLowerCase().includes(resource),
			),
		);
	}
	const project = (req.query.get("project") ?? "").trim();
	if (project) {
		filtered = filtered.filter((row) => String((row as Record<string, unknown>).http_path ?? "").includes(`/projects/${project}`));
	}
	const start = req.query.get("start_date");
	const end = req.query.get("end_date");
	if (start) filtered = filtered.filter((row) => row.timestamp >= mockActivityBound(start, false));
	if (end) filtered = filtered.filter((row) => row.timestamp <= mockActivityBound(end, true));
	const query = (req.query.get("q") ?? "").trim().toLowerCase();
	if (query) {
		filtered = filtered.filter((row) =>
			Object.values(row).some((value) => String(value ?? "").toLowerCase().includes(query)),
		);
	}
	filtered = [...filtered].sort((a, b) => {
		if (sort === "event_type" || sort === "outcome") {
			const aValue = String((a as Record<string, unknown>)[sort] ?? "");
			const bValue = String((b as Record<string, unknown>)[sort] ?? "");
			if (aValue !== bValue) return aValue < bValue ? -1 : 1;
		}
		if (sort === "slowest") {
			const byDuration = Number((a as Record<string, unknown>).duration_ms ?? 0) - Number((b as Record<string, unknown>).duration_ms ?? 0);
			if (byDuration !== 0) return -byDuration;
		}
		if (sort === "status_desc") {
			const byStatus = Number((a as Record<string, unknown>).status_code ?? 0) - Number((b as Record<string, unknown>).status_code ?? 0);
			if (byStatus !== 0) return -byStatus;
		}
		const byTime = a.timestamp === b.timestamp ? 0 : a.timestamp < b.timestamp ? -1 : 1;
		const cmp = byTime !== 0 ? byTime : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
		return asc ? cmp : -cmp;
	});
	const cursor = req.query.get("cursor");
	if (cursor) {
		let curTs = "";
		let curId = "";
		let curSort = "";
		try {
			[curTs, curId, curSort] = atob(cursor).split("|");
		} catch {
			// A malformed cursor falls back to the first page here.
		}
		filtered = filtered.filter((row) => {
			if (sort === "event_type" || sort === "outcome") {
				const value = String((row as Record<string, unknown>)[sort] ?? "");
				if (curSort && value !== curSort) return value > curSort;
			}
			if (sort === "slowest" || sort === "status_desc") {
				const key = sort === "slowest" ? "duration_ms" : "status_code";
				const value = Number((row as Record<string, unknown>)[key] ?? 0);
				const cursorValue = Number(curSort);
				if (Number.isFinite(cursorValue) && value !== cursorValue) return value < cursorValue;
			}
			const cmp =
				row.timestamp === curTs
					? row.event_id < curId
						? -1
						: row.event_id > curId
							? 1
							: 0
					: row.timestamp < curTs
						? -1
						: 1;
			return asc ? cmp > 0 : cmp < 0;
		});
	}
	const hasMore = filtered.length > pageSize;
	const events = filtered.slice(0, pageSize);
	const last = events[events.length - 1];
	const sortCursor = last && (sort === "slowest" || sort === "status_desc" || sort === "event_type" || sort === "outcome")
		? `|${String((last as Record<string, unknown>)[sort === "slowest" ? "duration_ms" : sort === "status_desc" ? "status_code" : sort] ?? "")}`
		: "";
	return {
		events,
		next_cursor: hasMore && last ? btoa(`${last.timestamp}|${last.event_id}${sortCursor}`) : null,
		has_more: hasMore,
		page_size: pageSize,
	};
}

function mockActivityBound(raw: string, endOfDay: boolean) {
	if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} ${endOfDay ? "23:59:59" : "00:00:00"}`;
	return raw.replace("T", " ").replace(/Z$/, "");
}

function securityEventCategory(type: string) {
	if (type.startsWith("auth.") || type.startsWith("login_") || type.startsWith("token_")) return "auth";
	if (["org.created", "org.renamed", "org.deleted", "org.ownership.transferred"].includes(type)) return "organization";
	if (["org.membership.changed", "org.project.membership.changed"].includes(type)) return "membership";
	if (["org.project.created", "org.project.deleted", "org.project.membership.changed", "org.project.retention.changed"].includes(type)) return "project";
	if (["org.invitation.created", "org.invitation.revoked", "org.invitation.accepted"].includes(type)) return "invitation";
	if (type.startsWith("admin.setting.")) return "settings";
	return "organization";
}

export interface MockOptions {
	/** Parsed packages/harness-data/registry.json, or null when unreadable. */
	harnessRegistry: {
		harnesses: Record<
			string,
			{ display_name: string; capabilities: string[]; skill_support?: string; skill_mechanism?: string; hook_support?: string; hook_mechanism?: string }
		>;
	} | null;
	/** web/package.json version, echoed as the server version to keep the banner quiet. */
	appVersion: string;
}

export function createRoutes(opts: MockOptions): Route[] {
	const routes: Route[] = [];

	const on = (method: string, pattern: string, handler: HandlerFn) => {
		routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
	};

	const harnesses: HarnessEntry[] = opts.harnessRegistry
		? Object.entries(opts.harnessRegistry.harnesses).map(([name, entry]) => ({
			name,
			display_name: entry.display_name,
			capabilities: entry.capabilities,
			supported_models: GENERIC_MODELS,
			skill_support: entry.skill_support,
			skill_mechanism: entry.skill_mechanism,
			hook_support: entry.hook_support,
			hook_mechanism: entry.hook_mechanism,
		}))
		: FALLBACK_HARNESSES;

	// ── Auth (profile endpoints; credential flows live on /api/auth) ───
	on("GET", "/auth/whoami", () => MOCK_USER);
	on("PUT", "/auth/profile/username", () => ({ username: MOCK_USER.username }));
	on("PUT", "/auth/profile/avatar", (req) => ({
		avatar_url: (req.body as { avatar_url?: string } | undefined)?.avatar_url ?? null,
	}));
	on("DELETE", "/auth/profile/avatar", () => ({ avatar_url: null }));

	// ── Config ────────────────────────────────────────────────────────
	on("GET", "/config/public", () => MOCK_PUBLIC_CONFIG);
	on("GET", "/config/version", () => ({
		server_version: opts.appVersion,
		max_cli_version: null,
		api_version: "v1",
		frontend_version: opts.appVersion,
		recommended_cli_version: opts.appVersion,
	}));
	on("GET", "/config/harnesses", () => ({ harnesses, default_harness: "claude-code" }));

	// ── Unified project resources ──────────────────────────────────────
	on("GET", "/resources", (req) => {
		const wanted = req.query.get("type");
		const search = (req.query.get("search") ?? "").toLowerCase();
		const scope = req.query.get("scope");
		const status = req.query.get("status");		const includeUnpublished = req.query.get("include_unpublished") === "true";		const owner = req.query.get("owner")?.trim().toLowerCase();
		const updatedAfter = req.query.get("updated_after");
		const createdAfter = req.query.get("created_after");
		const sort = req.query.get("sort") ?? "updated";
		const page = Math.max(1, Number(req.query.get("page") ?? "1") || 1);
		const pageSize = Math.min(50, Math.max(1, Number(req.query.get("page_size") ?? "10") || 10));

		const matches = (Object.keys(MOCK_REGISTRY) as (keyof typeof MOCK_REGISTRY)[])
			.flatMap((type) => {
				const rows = [...MOCK_REGISTRY[type]];
				if (includeUnpublished && type !== "agents") rows.push(myDraft(type));
				return rows.map((item) => ({
					id: item.id,
					resource_type: type,
					name: item.name,
					namespace: item.namespace,
					slug: item.slug,
					qualified_name: item.qualified_name ?? `${item.namespace}/${item.slug}`,
					description: item.description ?? null,
					status: item.status ?? "approved",
					version: (item.version as string | undefined) ?? "1.0.0",
					visibility: item.visibility ?? "project",
					ownership_scope: item.visibility === "private" ? "private" : "project",
					owner: (item.owner as string | undefined) ?? item.namespace,
					project_id: null,
					downloads: (item as { download_count?: number }).download_count ?? 0,
					created_at: (item as { created_at?: string }).created_at ?? item.updated_at ?? new Date().toISOString(),
					updated_at: item.updated_at ?? new Date().toISOString(),
				}));
			})
			.filter((item) => (status ? item.status === status : includeUnpublished || item.status === "approved"))
			.filter((item) => {
				if (scope === "project") return item.ownership_scope !== "private";
				if (scope === "private") return item.ownership_scope === "private";
				return true;
			})
			.filter((item) => !owner || (item.owner ?? "").toLowerCase() === owner)
			.filter((item) => !updatedAfter || item.updated_at >= updatedAfter)
			.filter((item) => !createdAfter || item.created_at >= createdAfter)
			.filter(
				(item) =>
					!search ||
					item.name.toLowerCase().includes(search) ||
					item.qualified_name.toLowerCase().includes(search) ||
					(item.owner ?? "").toLowerCase().includes(search),
			);

		// Counts honor every filter except the type facet, mirroring the server.
		const counts: Record<string, number> = {};
		for (const item of matches) counts[item.resource_type] = (counts[item.resource_type] ?? 0) + 1;

		const typed = wanted ? matches.filter((item) => item.resource_type === wanted) : matches;
		const sorted = [...typed].sort((a, b) => {
			if (sort === "name") return a.name.localeCompare(b.name);
			if (sort === "name_desc") return b.name.localeCompare(a.name);
			if (sort === "downloads") return (b.downloads ?? 0) - (a.downloads ?? 0);
			if (sort === "created") return b.created_at.localeCompare(a.created_at);
			return b.updated_at.localeCompare(a.updated_at);
		});
		const total = sorted.length;
		const items = sorted.slice((page - 1) * pageSize, page * pageSize);
		return { items, counts, total, page, page_size: pageSize };
	});
	on("GET", "/config/sso-health", () => ({ oidc: null, saml: null }));

	// ── Registry (shared across the six component types) ──────────────
	for (const type of REGISTRY_TYPES) {
		on("GET", `/${type}`, () => MOCK_REGISTRY[type]);
		// The caller's in-flight draft submission is managed on the component's
		// own detail page (edit / submit for review).
		if (type !== "agents") {
			on("POST", `/${type}/:id/submit`, () => ({ status: "pending" }));
			on("POST", `/${type}/:id/start-edit`, () => ({ status: "editing" }));
			on("POST", `/${type}/:id/cancel-edit`, () => ({ status: "cancelled" }));
			on("PUT", `/${type}/:id/draft`, (req) => ({ id: req.params.id, status: "draft", ...(req.body as Record<string, unknown>) }));
		}
		on("POST", `/${type}`, (req) =>
			json(201, {
				id: `new-${type}-${Date.now()}`,
				status: "pending",
				created_at: new Date().toISOString(),
				...(req.body as Record<string, unknown>),
			}),
		);
		on("POST", `/${type}/submit`, (req) =>
			json(201, {
				id: `new-${type}-${Date.now()}`,
				status: "pending",
				created_at: new Date().toISOString(),
				...(req.body as Record<string, unknown>),
			}),
		);
		if (type === "agents") {
			on("GET", "/agents/deleted", () => MOCK_DELETED_AGENTS);
			on("PATCH", "/agents/:id/restore", (req) => {
				const index = MOCK_DELETED_AGENTS.findIndex((agent) => agent.id === req.params.id);
				if (index < 0) return notFound("Deleted agent not found");
				const [agent] = MOCK_DELETED_AGENTS.splice(index, 1);
				MOCK_REGISTRY.agents.push({ ...agent, status: "approved", deleted_at: null, scheduled_purge_at: null });
				return { id: agent.id, name: agent.name, status: "approved" };
			});
			on("POST", "/agents/:id/purge", (req) => {
				const body = req.body as { confirm?: string };
				if ((body.confirm ?? "").trim().toLowerCase() !== "permanently delete") {
					return json(422, { detail: "Type 'permanently delete' to confirm permanent deletion" });
				}
				const index = MOCK_DELETED_AGENTS.findIndex((agent) => agent.id === req.params.id);
				if (index < 0) return notFound("Deleted agent not found");
				const [agent] = MOCK_DELETED_AGENTS.splice(index, 1);
				return { deleted: agent.id, name: agent.name, permanent: true };
			});
			on("POST", "/agents/validate", () => ({ valid: true, issues: [] }));
			on("GET", "/agents/:id/manifest", (req) => {
				const item = findRegistryItem("agents", req.params.id);
				return item
					? { name: item.name, version: item.version, components: item.components ?? [] }
					: notFound("Agent not found");
			});
			on("GET", "/agents/:id/downloads", () => ({ total: 57, unique_users: 21, recent_7d: 9 }));
			on("GET", "/agents/:id/resolve", (req) => {
				const item = findRegistryItem("agents", req.params.id);
				return item ? { agent: item, components: item.components ?? [] } : notFound("Agent not found");
			});
			on("GET", "/agents/:id/versions", (req) => mockAgentVersions(req.params.id));
			on("GET", "/agents/:id/versions/:version", (req) =>
				mockAgentVersionDetail(req.params.id, req.params.version),
			);
			on("GET", "/agents/:id/insights/reports", () => []);
			on("GET", "/agents/:id/insights/session-count", () => ({ session_count: 42 }));
		} else {
			on("GET", `/${type}/:id/versions`, (req) => mockComponentVersions(req.params.id));
			on("GET", `/${type}/:id/versions/:version`, (req) =>
				mockComponentVersionDetail(req.params.id, req.params.version),
			);
		}
		on("GET", `/${type}/:id/version-suggestions`, () => MOCK_VERSION_SUGGESTIONS);
		on("GET", `/${type}/:id/metrics`, () => ({
			downloads: 57,
			installs_7d: 9,
		}));
		on("POST", `/${type}/:id/install`, () => ({ message: "Install recorded (mock)" }));
		on("GET", `/${type}/:id/co-authors`, () => []);
		on("GET", `/${type}/:id`, (req) =>
			findRegistryItem(type, req.params.id) ??
			(type !== "agents" && req.params.id === `draft-${type}` ? myDraft(type) : notFound(`${type} item not found`)),
		);
		on("PUT", `/${type}/:id`, (req) => {
			const item = findRegistryItem(type, req.params.id);
			return item ? { ...item, ...(req.body as Record<string, unknown>) } : notFound(`${type} item not found`);
		});
		on("DELETE", `/${type}/:id`, () => json(204, undefined));
	}

	on("GET", "/registry/resolve", (req) => {
		const type = SINGULAR[req.query.get("type") ?? ""];
		const identifier = req.query.get("identifier") ?? "";
		let item = type ? findRegistryItem(type, identifier) : undefined;
		if (!item && type && identifier.endsWith("-draft")) {
			const draft = myDraft(type);
			if (identifier === draft.qualified_name || identifier === draft.slug) item = draft;
		}
		if (!item || !type) return notFound("Unknown registry reference");
		return {
			id: item.id,
			type: req.query.get("type"),
			namespace: item.namespace,
			slug: item.slug,
			qualified_name: item.qualified_name,
		};
	});

	// ── Overview / dashboard ──────────────────────────────────────────
	on("GET", "/overview/stats", () => MOCK_OVERVIEW_STATS);
	on("GET", "/overview/trends", () => mockTrends());
	on("GET", "/overview/top-mcps", () => MOCK_TOP_MCPS);
	on("GET", "/overview/top-agents", () => MOCK_TOP_AGENTS);
	on("GET", "/dashboard/tokens", () => MOCK_TOKEN_STATS);
	on("GET", "/dashboard/harness-usage", () => MOCK_HARNESS_USAGE);

	// ── Project Intelligence ──────────────────────────────────────────
	on("GET", "/orgs/:slug/projects/:project/intelligence/briefing", (req) => {
		const data = mockIntelligenceBriefing();
		const range = req.query.get("range") ?? "7d";
		return { ...data, range, comparison: `previous_${range}` };
	});
	on("GET", "/orgs/:slug/projects/:project/intelligence/resources", (req) => {
		const data = mockIntelligenceResources();
		const focus = req.query.get("focus") ?? "all";
		const search = (req.query.get("search") ?? "").trim().toLowerCase();
		const sort = req.query.get("sort") ?? "impact";
		const page = Math.max(1, Number(req.query.get("page") ?? 1));
		const pageSize = Math.max(1, Math.min(100, Number(req.query.get("page_size") ?? 25)));
		let rows = data.rows.filter((row) => {
			if (search && !`${row.name} ${row.qualified_name ?? ""} ${row.owner ?? ""}`.toLowerCase().includes(search)) return false;
			if (focus === "attention") return row.attention_reasons.length > 0;
			if (focus === "growing") return row.change_pct !== null && row.change_pct >= 25;
			if (focus === "declining") return row.change_pct !== null && row.change_pct <= -25;
			if (focus === "underused") return row.attention_reasons.includes("installed but unused");
			return true;
		});
		rows = [...rows].sort((left, right) => {
			if (sort === "name") return left.name.localeCompare(right.name);
			if (sort === "growth") return (right.change_pct ?? -Infinity) - (left.change_pct ?? -Infinity);
			if (sort === "cost") return (right.credits ?? -Infinity) - (left.credits ?? -Infinity);
			if (sort === "attention") return right.attention_reasons.length - left.attention_reasons.length;
			return (right.sessions ?? -1) - (left.sessions ?? -1);
		});
		const start = (page - 1) * pageSize;
		return { ...data, range: req.query.get("range") ?? "7d", rows: rows.slice(start, start + pageSize), total: rows.length, page, page_size: pageSize };
	});
	on("GET", "/orgs/:slug/projects/:project/intelligence/resources/compare", (req) => ({
		...mockIntelligenceCompare(req.query.get("a") ?? "", req.query.get("b") ?? ""),
		range: req.query.get("range") ?? "7d",
	}));
	on("GET", "/orgs/:slug/projects/:project/intelligence/resources/:resource/versions", (req) => ({
		...mockIntelligenceResourceVersions(), range: req.query.get("range") ?? "7d",
	}));
	on("GET", "/orgs/:slug/projects/:project/intelligence/history", (req) => {
		const data = mockIntelligenceHistory();
		const category = req.query.get("category");
		const resource = req.query.get("resource");
		const events = data.events.filter((event) => (!category || event.category === category) && (!resource || event.agent_id === resource));
		return { ...data, range: req.query.get("range") ?? "7d", events, total: events.length };
	});

	// ── Sessions ──────────────────────────────────────────────────────
	on("GET", "/sessions", () => MOCK_SESSIONS);
	// Unified investigation listing: filters, sort, pagination, and the
	// window percentiles, all derived from the same mock rows.
	on("GET", "/sessions/query", (req) => {
		const p = req.query;
		const num = (v: string | null) => (v ? Number(v) || 0 : 0);
		const withDerived = MOCK_SESSIONS.map((s) => ({
			...s,
			duration_s: Math.max(
				0,
				Math.floor((new Date(s.last_event_time).getTime() - new Date(s.first_event_time).getTime()) / 1000),
			),
			total_tokens: (s.total_input_tokens ?? 0) + (s.total_output_tokens ?? 0),
		}));
		let rows = withDerived;
		const q = (p.get("q") ?? "").toLowerCase();
		if (q) rows = rows.filter((s) => s.session_id.toLowerCase().includes(q) || (s.model ?? "").toLowerCase().includes(q));
		const platform = p.get("platform");
		if (platform) rows = rows.filter((s) => s.service_name === platform);
		const model = (p.get("model") ?? "").toLowerCase();
		if (model) rows = rows.filter((s) => (s.model ?? "").toLowerCase().includes(model));
		const agent = p.get("agent");
		if (agent) rows = rows.filter((s) => s.agent_id === agent);
		const status = p.get("status");
		if (status === "active") rows = rows.filter((s) => s.is_active);
		if (status === "completed") rows = rows.filter((s) => !s.is_active);
		const days = num(p.get("days"));
		if (days > 0) {
			const cutoff = Date.now() - days * 86_400_000;
			rows = rows.filter((s) => new Date(s.last_event_time).getTime() > cutoff);
		}
		const minDuration = num(p.get("min_duration"));
		if (minDuration > 0) rows = rows.filter((s) => s.duration_s >= minDuration);
		const minTokens = num(p.get("min_tokens"));
		if (minTokens > 0) rows = rows.filter((s) => s.total_tokens >= minTokens);
		const sort = p.get("sort") ?? "recent";
		const creditsOf = (s: (typeof rows)[number]) => Number(s.total_credits ?? 0) || 0;
		rows = [...rows].sort((a, b) => {
			if (sort === "oldest") return a.first_event_time.localeCompare(b.first_event_time);
			if (sort === "duration") return b.duration_s - a.duration_s;
			if (sort === "tokens") return b.total_tokens - a.total_tokens;
			if (sort === "credits") return creditsOf(b) - creditsOf(a);
			if (sort === "prompts") return (b.prompt_count ?? 0) - (a.prompt_count ?? 0);
			if (sort === "tools") return (b.tool_result_count ?? 0) - (a.tool_result_count ?? 0);
			return b.last_event_time.localeCompare(a.last_event_time);
		});
		const page = Math.max(1, num(p.get("page")) || 1);
		const pageSize = Math.min(100, Math.max(1, num(p.get("page_size")) || 25));
		const p95 = (values: number[]) => {
			if (values.length === 0) return 0;
			const sorted = [...values].sort((a, b) => a - b);
			return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
		};
		return {
			items: rows.slice((page - 1) * pageSize, page * pageSize),
			total: rows.length,
			page,
			page_size: pageSize,
			p95_duration_s: p95(rows.map((s) => s.duration_s)),
			p95_total_tokens: p95(rows.map((s) => s.total_tokens)),
		};
	});
	on("GET", "/sessions/:id", (req) => mockSessionData(req.params.id) ?? notFound("Session not found"));

	// ── Telemetry / insights ──────────────────────────────────────────
	on("GET", "/telemetry/status", () => MOCK_TELEMETRY_STATUS);
	on("GET", "/insights/status", () => ({ available: true, reason: null }));

	// ── Review queue ──────────────────────────────────────────────────
	on("GET", "/review", () => MOCK_REVIEW_ITEMS);
	on("GET", "/review/:id", (req) =>
		MOCK_REVIEW_ITEMS.find((r) => r.id === req.params.id) ?? notFound("Review item not found"),
	);
	on("GET", "/review/:id/related-skills", () => ({ skills: [] }));
	on("POST", "/review/:id/approve", () => ({ message: "Approved (mock)" }));
	on("POST", "/review/:id/reject", () => ({ message: "Rejected (mock)" }));

	// ── Review issues (stateful within one dev-server run) ─────────────
	const mockIssues: Record<string, unknown>[] = [];
	const issueActor = () => ({ id: MOCK_USER.id, username: MOCK_USER.username, name: MOCK_USER.name });
	on("GET", "/review/:id/issues", (req) => {
		const issues = mockIssues.filter((issue) => issue.subject_id === req.params.id);
		return {
			subject_type: "agent",
			subject_id: req.params.id,
			open_count: issues.filter((issue) => issue.status === "open").length,
			issues,
		};
	});
	on("POST", "/review/:id/issues", (req) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const issue = {
			id: `i0000000-0000-4000-8000-${String(mockIssues.length + 1).padStart(12, "0")}`,
			subject_type: "agent",
			subject_id: req.params.id,
			version_id: body.version_id ?? null,
			context: body.context ?? null,
			title: body.title,
			body: body.body ?? null,
			status: "open",
			author: issueActor(),
			resolved_by: null,
			resolved_at: null,
			created_at: new Date().toISOString(),
			comments: [] as Record<string, unknown>[],
		};
		mockIssues.unshift(issue);
		return json(201, issue);
	});
	on("PATCH", "/review/issues/:issueId", (req) => {
		const issue = mockIssues.find((entry) => entry.id === req.params.issueId);
		if (!issue) return notFound("Issue not found");
		const status = (req.body as { status?: string } | undefined)?.status ?? "open";
		issue.status = status;
		issue.resolved_by = status === "resolved" ? issueActor() : null;
		issue.resolved_at = status === "resolved" ? new Date().toISOString() : null;
		return issue;
	});
	on("POST", "/review/issues/:issueId/comments", (req) => {
		const issue = mockIssues.find((entry) => entry.id === req.params.issueId);
		if (!issue) return notFound("Issue not found");
		(issue.comments as Record<string, unknown>[]).push({
			id: `c0000000-0000-4000-8000-${String(Date.now()).slice(-12)}`,
			author: issueActor(),
			body: (req.body as { body?: string } | undefined)?.body ?? "",
			created_at: new Date().toISOString(),
		});
		return json(201, issue);
	});

	// ── Resource lifecycle: derived activity, contributors, restore ────
	const subjectTypeOf = (id: string): keyof typeof MOCK_REGISTRY | null => {
		for (const type of Object.keys(MOCK_REGISTRY) as (keyof typeof MOCK_REGISTRY)[]) {
			if (MOCK_REGISTRY[type].some((item) => item.id === id)) return type;
		}
		return null;
	};
	const lifecycleActor = () => ({ id: MOCK_USER.id, username: MOCK_USER.username, name: MOCK_USER.name });
	on("GET", "/resources/:id/activity", (req) => {
		const id = req.params.id;
		const type = subjectTypeOf(id);
		if (!type) return notFound("Resource not found");
		const versions = type === "agents" ? mockAgentVersions(id).items : mockComponentVersions(id).items;
		const events: Record<string, unknown>[] = [];
		for (const v of versions) {
			events.push({
				type: "change_opened",
				at: v.created_at,
				actor: lifecycleActor(),
				version: v.version,
				version_id: v.id,
				detail: v.description ?? null,
			});
			if (v.status === "approved") {
				events.push({
					type: "version_published",
					at: v.released_at,
					actor: lifecycleActor(),
					version: v.version,
					version_id: v.id,
				});
			}
		}
		for (const issue of mockIssues.filter((i) => i.subject_id === id)) {
			events.push({
				type: "issue_opened",
				at: issue.created_at,
				actor: issue.author,
				issue_id: issue.id,
				detail: issue.title,
			});
			if (issue.status === "resolved") {
				events.push({
					type: "issue_resolved",
					at: issue.resolved_at,
					actor: issue.resolved_by,
					issue_id: issue.id,
					detail: issue.title,
				});
			}
		}
		events.push({
			type: "resource_created",
			at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
			actor: lifecycleActor(),
		});
		events.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
		const limit = Math.min(500, Math.max(1, Number(req.query.get("limit") ?? "100") || 100));
		return {
			subject_type: type === "agents" ? "agent" : type.replace(/s$/, ""),
			subject_id: id,
			total: events.length,
			events: events.slice(0, limit),
		};
	});
	on("GET", "/resources/:id/contributors", (req) => {
		const id = req.params.id;
		const type = subjectTypeOf(id);
		if (!type) return notFound("Resource not found");
		const versions = type === "agents" ? mockAgentVersions(id).items : mockComponentVersions(id).items;
		const approved = versions.filter((v) => v.status === "approved").length;
		const issues = mockIssues.filter((i) => i.subject_id === id);
		return {
			subject_type: type === "agents" ? "agent" : type.replace(/s$/, ""),
			subject_id: id,
			total: 1,
			contributors: [
				{
					user: lifecycleActor(),
					is_creator: true,
					changes_opened: versions.length,
					versions_published: approved,
					reviews: 0,
					issues_opened: issues.length,
					issues_resolved: issues.filter((i) => i.status === "resolved").length,
					comments: issues.reduce((n, i) => n + ((i.comments as unknown[])?.length ?? 0), 0),
					last_activity_at: versions[0]?.released_at ?? new Date().toISOString(),
				},
			],
		};
	});
	on("GET", "/agents/:id/versions/:v1/diff/:v2", (req) => ({
		agent_id: req.params.id,
		version_a: req.params.v1,
		version_b: req.params.v2,
		yaml_diff: [
			`--- v${req.params.v1}`,
			`+++ v${req.params.v2}`,
			"@@ -1 +1 @@",
			"-description:",
			"-  Initial public release.",
			"+description:",
			"+  Adds harness capability gating.",
			" supported_harnesses:",
			" - claude-code",
			"+- copilot",
		].join("\n"),
		component_changes: [],
	}));
	for (const type of REGISTRY_TYPES) {
		on("POST", `/${type}/:id/versions/:version/restore`, (req) => {			const versions =
				type === "agents" ? mockAgentVersions(req.params.id).items : mockComponentVersions(req.params.id).items;
			const source = versions.find((v) => v.version === req.params.version);
			if (!source) return notFound("Version not found");
			if (source.status !== "approved") return json(422, { detail: "Only approved versions can be restored" });
			const [maj, min, patch] = versions[0].version.split(".").map(Number);
			const reason = (req.body as { reason?: string } | undefined)?.reason;
			return json(201, {
				...source,
				id: `${req.params.id}-restore-${Date.now()}`,
				version: `${maj}.${min}.${(patch || 0) + 1}`,
				status: "pending",
				changelog: `Restored from v${source.version}${reason ? `: ${reason}` : ""}`,
				description: `Restored from v${source.version}`,
				released_at: new Date().toISOString(),
				restored_from: source.version,
			});
		});
	}

	// ── Inbox ─────────────────────────────────────────────────────────
	on("GET", "/inbox", () => ({
		items: MOCK_INBOX_ITEMS,
		total: MOCK_INBOX_ITEMS.length,
		page: 1,
		page_size: 20,
	}));
	on("GET", "/inbox/count", () => MOCK_INBOX_COUNTS);
	on("GET", "/inbox/:id", (req) => {
		const item = MOCK_INBOX_ITEMS.find((i) => i.id === req.params.id);
		return item ? { ...item, history: [] } : notFound("Inbox item not found");
	});
	for (const action of ["read", "unread", "done", "dismiss", "reopen"]) {
		on("POST", `/inbox/:id/${action}`, (req) => {
			const item = MOCK_INBOX_ITEMS.find((i) => i.id === req.params.id);
			return item ?? notFound("Inbox item not found");
		});
	}
	on("POST", "/inbox/read-all", () => ({ updated: MOCK_INBOX_ITEMS.length }));

	// ── Organizations & projects ───────────────────────────────
	const orgBySlug = (slug: string) => MOCK_ORGS.find((o) => o.slug === slug);

	// ── Onboarding (derived from the mock membership state) ───────────
	const pendingInvitations = () =>
		Object.values(MOCK_ORG_INVITATIONS)
			.flat()
			.filter((i) => i.state === "pending" && i.email.toLowerCase() === MOCK_USER.email.toLowerCase());
	on("GET", "/onboarding", () => {
		const organizations = MOCK_ORGS.map((o) => ({
			slug: o.slug,
			name: o.name,
			role: o.role ?? "member",
			projects: (MOCK_PROJECTS[o.slug] ?? []).map((p) => ({
				slug: p.slug,
				name: p.name,
				is_default: !!p.is_default,
				role: p.role ?? null,
			})),
		}));
		const next_step = !MOCK_ONBOARDING.profileCompleted
			? "profile"
			: organizations.length === 0
				? "organization"
				: organizations.some((o) => o.projects.length > 0)
					? "done"
					: "project";
		return {
			profile: {
				completed: MOCK_ONBOARDING.profileCompleted,
				name: MOCK_USER.name,
				username: MOCK_USER.username,
				email: MOCK_USER.email,
				avatar_url: MOCK_USER.avatar_url,
			},
			organizations,
			invitations: pendingInvitations().map((i) => ({
				id: i.id,
				org_slug: i.org_slug,
				org_name: i.org_name,
				role: i.role,
				expires_at: i.expires_at,
			})),
			next_step,
		};
	});
	on("POST", "/onboarding/profile/complete", () => {
		MOCK_ONBOARDING.profileCompleted = true;
		return { completed: true };
	});

	// ── Organization invitations ─────────────────────────────────────
	const allInvitations = () => Object.values(MOCK_ORG_INVITATIONS).flat();
	const acceptInvitation = (inv: (typeof MOCK_ORG_INVITATIONS)[string][number]) => {
		if (inv.email.toLowerCase() !== MOCK_USER.email.toLowerCase()) {
			return json(409, { detail: "This invitation was issued to a different email address" });
		}
		if (inv.state === "expired") return json(409, { detail: "This invitation has expired" });
		if (inv.state === "revoked") return json(409, { detail: "This invitation was revoked" });
		inv.state = "accepted";
		let org = orgBySlug(inv.org_slug);
		if (!org) {
			org = {
				id: `o-${Math.random().toString(36).slice(2, 10)}`,
				slug: inv.org_slug,
				name: inv.org_name,
				description: null,
				role: inv.role,
				permissions: orgPermissions(inv.role),
				member_count: 2,
				project_count: 0,
				created_at: new Date().toISOString(),
			};
			MOCK_ORGS.push(org);
			MOCK_ORG_MEMBERS[org.slug] = [{ ...MOCK_ORG_MEMBERS.primary[0], role: inv.role }];
			MOCK_PROJECTS[org.slug] = [];
		}
		return org;
	};
	on("GET", "/invitations", () =>
		pendingInvitations().map((i) => ({ ...i, url: undefined })),
	);
	on("POST", "/invitations/:id/accept", (req) => {
		const inv = allInvitations().find((i) => i.id === req.params.id);
		if (!inv) return notFound("Invitation not found");
		return acceptInvitation(inv);
	});
	on("GET", "/invitations/token/:token", (req) => {
		const inv = allInvitations().find((i) => i.url?.endsWith(req.params.token));
		return inv ? { ...inv, url: undefined } : notFound("Invitation not found");
	});
	on("POST", "/invitations/token/:token/accept", (req) => {
		const inv = allInvitations().find((i) => i.url?.endsWith(req.params.token));
		if (!inv) return notFound("Invitation not found");
		return acceptInvitation(inv);
	});
	on("GET", "/orgs/:slug/invitations", (req) => {
		const invs = MOCK_ORG_INVITATIONS[req.params.slug];
		if (!invs) return notFound("Organization not found");
		const q = (req.query.get("q") ?? "").trim().toLowerCase();
		const role = req.query.get("role");
		const state = req.query.get("state");
		return invs.filter((inv) => {
			if (q && !inv.email.toLowerCase().includes(q)) return false;
			if (role && inv.role !== role) return false;
			if (state && inv.state !== state) return false;
			return true;
		});
	});
	on("POST", "/orgs/:slug/invitations", (req) => {
		const invs = MOCK_ORG_INVITATIONS[req.params.slug];
		const org = orgBySlug(req.params.slug);
		if (!invs || !org) return notFound("Organization not found");
		const body = req.body as { email: string; role: "admin" | "member" };
		const email = body.email.toLowerCase();
		const existing = invs.find((i) => i.email === email && i.state === "pending");
		if (existing) return existing;
		const token = Math.random().toString(36).slice(2, 14);
		const inv = {
			id: `i-${Math.random().toString(36).slice(2, 10)}`,
			org_slug: org.slug,
			org_name: org.name,
			email,
			role: body.role,
			url: `${location.origin}/onboarding/organization?invite=${token}`,
			invited_by: MOCK_USER.username,
			created_at: new Date().toISOString(),
			expires_at: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
			state: "pending" as const,
		};
		invs.push(inv);
		return json(201, inv);
	});
	on("DELETE", "/orgs/:slug/invitations/:id", (req) => {
		const invs = MOCK_ORG_INVITATIONS[req.params.slug];
		if (!invs) return notFound("Organization not found");
		const inv = invs.find((i) => i.id === req.params.id);
		if (!inv) return notFound("Invitation not found");
		if (inv.state === "accepted") return json(409, { detail: "This invitation was already accepted" });
		inv.state = "revoked";
		return json(204, undefined);
	});

	on("GET", "/orgs", () => MOCK_ORGS);
	on("POST", "/orgs", (req) => {
		const body = req.body as { name: string; slug: string; description?: string };
		if (orgBySlug(body.slug)) return json(409, { detail: `Organization id '${body.slug}' is already taken` });
		const org = {
			id: `o-${Math.random().toString(36).slice(2, 10)}`,
			slug: body.slug,
			name: body.name,
			description: body.description ?? null,
			role: "owner" as const,
			permissions: orgPermissions("owner"),
			member_count: 1,
			project_count: 1,
			created_at: new Date().toISOString(),
		};
		// Every organization is created with its protected default project.
		const defaultProject = {
			id: `p-${Math.random().toString(36).slice(2, 10)}`,
			organization_id: org.id,
			slug: org.slug,
			name: org.name,
			description: null,
			is_default: true,
			role: "lead" as const,
			permissions: projectPermissions("owner", "lead"),
			member_count: 1,
			created_at: new Date().toISOString(),
		};
		MOCK_ORGS.push(org);
		MOCK_ORG_MEMBERS[org.slug] = [{ ...MOCK_ORG_MEMBERS.primary[0], role: "owner" }];
		MOCK_PROJECTS[org.slug] = [defaultProject];
		MOCK_PROJECT_MEMBERS[defaultProject.slug] = [{ ...MOCK_ORG_MEMBERS[org.slug][0], role: "lead" }];
		MOCK_ORG_INVITATIONS[org.slug] = [];
		MOCK_PROJECT_RESOURCES[defaultProject.slug] = { total: 0, items: [] };
		return json(201, { ...org, default_project: defaultProject });
	});
	on("GET", "/orgs/:slug", (req) => orgBySlug(req.params.slug) ?? notFound("Organization not found"));
	on("PATCH", "/orgs/:slug", (req) => {
		const org = orgBySlug(req.params.slug);
		if (!org) return notFound("Organization not found");
		Object.assign(org, req.body as Record<string, unknown>);
		return org;
	});
	on("GET", "/orgs/:slug/members", (req) => {
		const org = orgBySlug(req.params.slug);
		if (!org) return notFound("Organization not found");
		if (!(org.permissions ?? []).includes("org.members.manage")) {
			return json(403, { detail: "Insufficient organization permissions" });
		}
		const members = MOCK_ORG_MEMBERS[req.params.slug];
		if (!members) return notFound("Organization not found");
		const q = (req.query.get("q") ?? "").trim().toLowerCase();
		const role = req.query.get("role");
		const project = req.query.get("project");
		const projectRole = req.query.get("project_role");
		const dir = req.query.get("dir") === "desc" ? -1 : 1;
		const sort = req.query.get("sort") ?? "email";
		const projectAccess = (memberId: string, projectSlug?: string | null) =>
			(MOCK_PROJECTS[req.params.slug] ?? [])
				.filter((p) => !projectSlug || p.slug === projectSlug)
				.map((p) => ({ project: p, membership: (MOCK_PROJECT_MEMBERS[p.slug] ?? []).find((m) => m.id === memberId) }));
		const projectCount = (memberId: string) =>
			(MOCK_PROJECTS[req.params.slug] ?? []).filter((p) =>
				(MOCK_PROJECT_MEMBERS[p.slug] ?? []).some((m) => m.id === memberId),
			).length;
		let rows = members.map((m) => ({ ...m, project_count: projectCount(m.id) }));
		if (q) {
			rows = rows.filter((m) =>
				[m.email, m.username ?? "", m.name ?? ""].some((v) => v.toLowerCase().includes(q)),
			);
		}
		if (role) rows = rows.filter((m) => m.role === role);
		if (project || projectRole) {
			rows = rows.filter((m) =>
				projectAccess(m.id, project).some(({ membership }) => {
					if (m.role === "owner" || m.role === "admin") return !projectRole || projectRole === "lead";
					if (!membership) return false;
					return !projectRole || membership.role === projectRole;
				}),
			);
		}
		const keyOf = (m: (typeof rows)[number]) =>
			sort === "joined"
				? (m.created_at ?? "")
				: sort === "role"
					? m.role
					: sort === "name"
						? (m.name ?? m.username ?? m.email)
						: m.email;
		rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -dir : keyOf(a) > keyOf(b) ? dir : 0));
		return paginateOrgList(rows, req, "members");
	});
	on("GET", "/orgs/:slug/members/:userId/projects", (req) => {
		const org = orgBySlug(req.params.slug);
		if (!org) return notFound("Organization not found");
		if (!(org.permissions ?? []).includes("org.members.manage")) {
			return json(403, { detail: "Insufficient organization permissions" });
		}
		const target = (MOCK_ORG_MEMBERS[req.params.slug] ?? []).find((m) => m.id === req.params.userId);
		if (!target) return notFound("Member not found");
		const inherited = target.role === "owner" || target.role === "admin";
		return (MOCK_PROJECTS[req.params.slug] ?? [])
			.map((project) => ({
				project,
				membership: (MOCK_PROJECT_MEMBERS[project.slug] ?? []).find((m) => m.id === target.id),
			}))
			.filter((entry) => inherited || entry.membership)
			.map(({ project, membership }) => ({
				id: project.id,
				slug: project.slug,
				name: project.name,
				is_default: !!project.is_default,
				role: inherited ? "lead" : membership!.role,
				assigned_role: membership?.role ?? null,
				access_source: inherited ? "organization" : "project",
				permissions: projectPermissions(target.role, inherited ? "lead" : membership!.role),
				created_at: project.created_at ?? new Date().toISOString(),
			}));
	});
	on("POST", "/orgs/:slug/members", (req) => {
		const members = MOCK_ORG_MEMBERS[req.params.slug];
		if (!members) return notFound("Organization not found");
		const body = req.body as { email?: string; username?: string; role: "admin" | "member" };
		const existing = members.find((m) => m.email === body.email || (body.username && m.username === body.username));
		if (existing) {
			existing.role = body.role;
			const defaultProject = (MOCK_PROJECTS[req.params.slug] ?? []).find((project) => project.is_default);
			if (defaultProject) {
				const defaultMembers = (MOCK_PROJECT_MEMBERS[defaultProject.slug] ??= []);
				const assigned = defaultMembers.find((member) => member.id === existing.id);
				if (assigned) assigned.role = projectMemberRole(body.role);
				else defaultMembers.push({ ...existing, role: projectMemberRole(body.role) });
				syncProjectMemberCounts(req.params.slug);
			}
			return existing;
		}
		const member = {
			id: `u-${Math.random().toString(36).slice(2, 10)}`,
			email: body.email ?? `${body.username}@example.test`,
			username: body.username ?? body.email?.split("@")[0] ?? "user",
			name: body.username ?? body.email ?? "User",
			role: body.role,
		};
		members.push(member);
		const defaultProject = (MOCK_PROJECTS[req.params.slug] ?? []).find((project) => project.is_default);
		if (defaultProject) {
			(MOCK_PROJECT_MEMBERS[defaultProject.slug] ??= []).push({ ...member, role: projectMemberRole(member.role) });
			syncProjectMemberCounts(req.params.slug);
		}
		return member;
	});
	on("DELETE", "/orgs/:slug/members/:userId", (req) => {
		const members = MOCK_ORG_MEMBERS[req.params.slug];
		if (!members) return notFound("Organization not found");
		const index = members.findIndex((m) => m.id === req.params.userId);
		if (index >= 0) members.splice(index, 1);
		return json(204, undefined);
	});
	on("GET", "/orgs/:slug/projects", (req) => {
		const projects = MOCK_PROJECTS[req.params.slug];
		if (!projects) return notFound("Organization not found");
		syncProjectMemberCounts(req.params.slug);
		const q = (req.query.get("q") ?? "").trim().toLowerCase();
		const dir = req.query.get("dir") === "desc" ? -1 : 1;
		const sort = req.query.get("sort") ?? "name";
		let rows = [...projects];
		if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q));
		const keyOf = (p: (typeof rows)[number]) =>
			sort === "created" ? (p.created_at ?? "") : sort === "members" ? (p.member_count ?? 0) : p.name;
		rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -dir : keyOf(a) > keyOf(b) ? dir : 0));
		return paginateOrgList(rows, req, "projects");
	});
	on("POST", "/orgs/:slug/projects", (req) => {
		const org = orgBySlug(req.params.slug);
		const projects = MOCK_PROJECTS[req.params.slug];
		if (!org || !projects) return notFound("Organization not found");
		const body = req.body as { name: string; slug?: string; description?: string };
		const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		const project = {
			id: `p-${Math.random().toString(36).slice(2, 10)}`,
			organization_id: org.id,
			slug,
			name: body.name,
			description: body.description ?? null,
			role: "lead" as const,
			permissions: projectPermissions(org.role, "lead"),
			member_count: 1,
			created_at: new Date().toISOString(),
		};
		projects.push(project);
		MOCK_PROJECT_MEMBERS[slug] = [{ ...MOCK_ORG_MEMBERS.primary[0], role: "lead" }];
		MOCK_PROJECT_RESOURCES[slug] = { total: 0, items: [] };
		org.project_count = (org.project_count ?? 0) + 1;
		return json(201, project);
	});
	on("GET", "/orgs/:slug/projects/:project", (req) => {
		const project = (MOCK_PROJECTS[req.params.slug] ?? []).find((p) => p.slug === req.params.project);
		return project ?? notFound("Project not found");
	});
	on("GET", "/orgs/:slug/projects/:project/members", (req) => {
		if (!MOCK_PROJECTS[req.params.slug]?.some((project) => project.slug === req.params.project)) {
			return notFound("Project not found");
		}
		const q = (req.query.get("q") ?? "").trim().toLowerCase();
		const role = req.query.get("role");
		const dir = req.query.get("dir") === "desc" ? -1 : 1;
		const sort = req.query.get("sort") ?? "email";
		let rows = projectAccessRows(req.params.slug, req.params.project);
		if (q) rows = rows.filter((member) => [member.email, member.username ?? "", member.name ?? ""].some((value) => value.toLowerCase().includes(q)));
		if (role) rows = rows.filter((member) => member.role === role);
		const keyOf = (member: (typeof rows)[number]) =>
			sort === "joined"
				? (member.created_at ?? "")
				: sort === "role"
					? member.role
					: sort === "org_role"
						? (member.org_role ?? "")
						: sort === "name"
							? (member.name ?? member.username ?? member.email)
							: member.email;
		rows.sort((a, b) => (keyOf(a) < keyOf(b) ? -dir : keyOf(a) > keyOf(b) ? dir : 0));
		return paginateOrgList(rows, req, "members");
	});
	on("POST", "/orgs/:slug/projects/:project/members", (req) => {
		const members = MOCK_PROJECT_MEMBERS[req.params.project];
		if (!members) return notFound("Project not found");
		const body = req.body as { email?: string; username?: string; role: "lead" | "user" };
		const orgMembers = MOCK_ORG_MEMBERS[req.params.slug] ?? [];
		const source = orgMembers.find(
			(m) => m.email === body.email || (body.username && m.username === body.username),
		);
		if (!source) return json(409, { detail: "User must be an organization member first" });
		if ((source.role === "owner" || source.role === "admin") && body.role !== "lead") {
			return json(409, { detail: "Organization owners and admins inherit project lead access" });
		}
		const existing = members.find((m) => m.id === source.id);
		if (existing) {
			existing.role = body.role;
			syncProjectMemberCounts(req.params.slug);
			return existing;
		}
		const member = { id: source.id, email: source.email, username: source.username, name: source.name, role: body.role };
		members.push(member);
		syncProjectMemberCounts(req.params.slug);
		return member;
	});
	on("DELETE", "/orgs/:slug/projects/:project/members/:userId", (req) => {
		const members = MOCK_PROJECT_MEMBERS[req.params.project];
		if (!members) return notFound("Project not found");
		const orgMember = (MOCK_ORG_MEMBERS[req.params.slug] ?? []).find((member) => member.id === req.params.userId);
		if (orgMember?.role === "owner" || orgMember?.role === "admin") {
			return json(409, { detail: "Organization owner/admin project access is inherited and cannot be removed" });
		}
		const index = members.findIndex((m) => m.id === req.params.userId);
		if (index >= 0) members.splice(index, 1);
		syncProjectMemberCounts(req.params.slug);
		return json(204, undefined);
	});
	on("GET", "/orgs/:slug/projects/:project/resources", (req) =>
		MOCK_PROJECT_RESOURCES[req.params.project] ?? { total: 0, items: [] },
	);
	on("GET", "/orgs/:slug/projects/:project/retention-policy", (req) =>
		MOCK_RESOURCE_RETENTION_POLICIES[req.params.project] ?? {
			private_retention_days: 30,
			project_retention_days: 30,
			bounds: { private: { min_days: 0, max_days: 90 }, project: { min_days: 7, max_days: 180 } },
			can_update: true,
		},
	);
	on("PUT", "/orgs/:slug/projects/:project/retention-policy", (req) => {
		const current = MOCK_RESOURCE_RETENTION_POLICIES[req.params.project] ?? {
			private_retention_days: 30,
			project_retention_days: 30,
			bounds: { private: { min_days: 0, max_days: 90 }, project: { min_days: 7, max_days: 180 } },
			can_update: true,
		};
		const body = req.body as { private_retention_days?: number; project_retention_days?: number; confirm?: boolean; confirmed_conflict_ids?: string[] };
		const next = {
			...current,
			private_retention_days: body.private_retention_days ?? current.private_retention_days,
			project_retention_days: body.project_retention_days ?? current.project_retention_days,
		};
		if (next.private_retention_days < 0 || next.private_retention_days > 90 || next.project_retention_days < 7 || next.project_retention_days > 180) {
			return json(422, { detail: "Retention values are outside the allowed range" });
		}
		const dayMs = 24 * 60 * 60 * 1000;
		const conflicts = MOCK_DELETED_AGENTS.filter((agent) => agent.project_id === MOCK_PROJECTS[req.params.slug]?.find((p) => p.slug === req.params.project)?.id)
			.map((agent) => {
				const days = agent.visibility === "private" ? next.private_retention_days : next.project_retention_days;
				const proposed = new Date(new Date(agent.deleted_at ?? Date.now()).getTime() + days * dayMs).toISOString();
				return { ...agent, proposed_scheduled_purge_at: proposed, eligible_at_apply: new Date(proposed).getTime() <= Date.now() };
			})
			.filter((agent) => agent.scheduled_purge_at && new Date(agent.proposed_scheduled_purge_at).getTime() < new Date(agent.scheduled_purge_at).getTime());
		const confirmed = [...(body.confirmed_conflict_ids ?? [])].sort().join(",") === conflicts.map((agent) => agent.id).sort().join(",");
		const response = { ...next, requires_confirmation: conflicts.length > 0, conflicts };
		if (req.query.get("preview") === "true") return response;
		if (conflicts.length > 0 && (!body.confirm || !confirmed)) return json(409, response);
		MOCK_RESOURCE_RETENTION_POLICIES[req.params.project] = { ...next, conflicts: [], applied: true };
		return MOCK_RESOURCE_RETENTION_POLICIES[req.params.project];
	});
	on("GET", "/orgs/:slug/audit-log", (req) => {
		const org = orgBySlug(req.params.slug);
		if (!org) return notFound("Organization not found");
		if (!(org.permissions ?? []).includes("org.audit.read")) {
			return json(403, { detail: "Insufficient organization permissions" });
		}
		return paginateActivity(MOCK_ORG_AUDIT_LOG, req, ["action", "resource_type", "resource_id", "resource_name", "outcome", "sensitivity", "actor", "request_id", "source", "ip_address", "http_method", "status_code"]);
	});
	on("GET", "/orgs/:slug/security-events", (req) => {
		const org = orgBySlug(req.params.slug);
		if (!org) return notFound("Organization not found");
		if (!(org.permissions ?? []).includes("org.security.read")) {
			return json(403, { detail: "Insufficient organization permissions" });
		}
		return paginateActivity(MOCK_ORG_SECURITY_EVENTS, req, ["event_type", "severity", "outcome", "actor", "target_type", "target_id", "source_ip"]);
	});

	// ── Users / recommendations ───────────────────────────────────────
	on("GET", "/users/search", (req) => {
		const q = (req.query.get("q") ?? "").toLowerCase();
		return MOCK_USERS.filter(
			(u) =>
				(u.email ?? "").toLowerCase().includes(q) ||
				(u.username ?? "").toLowerCase().includes(q) ||
				(u.name ?? "").toLowerCase().includes(q),
		).map((u) => ({ id: u.id, email: u.email, username: u.username, name: u.name }));
	});
	on("GET", "/recommendations/me", () => MOCK_RECOMMENDATIONS);
	on("POST", "/recommendations/feedback", () => json(204, undefined));

	// ── Admin (minimal; extend as needed) ─────────────────────────────
	on("GET", "/operator/users", (req) => {
		const q = (req.query.get("q") ?? "").toLowerCase();
		const role = req.query.get("role") ?? "";
		const limit = Number(req.query.get("limit") ?? "50");
		const offset = Number(req.query.get("offset") ?? "0");
		const filtered = MOCK_USERS.filter(
			(u) =>
				(!q ||
					(u.email ?? "").toLowerCase().includes(q) ||
					(u.name ?? "").toLowerCase().includes(q) ||
					(u.username ?? "").toLowerCase().includes(q)) &&
				(!role || u.role === role),
		);
		return {
			items: filtered.slice(offset, offset + limit).map((u) => ({ ...u, org_count: 1 })),
			total: filtered.length,
			limit,
			offset,
		};
	});
	on("GET", "/operator/system-warnings", () => []);
	on("GET", "/operator/settings", () => MOCK_ADMIN_SETTINGS);
	on("GET", "/operator/settings/schema", () => MOCK_SETTINGS_SCHEMA);
	on("PUT", "/operator/settings/:key", (req) => {
		const value = String((req.body as { value?: unknown } | undefined)?.value ?? "");
		const existing = MOCK_ADMIN_SETTINGS.find((s) => s.key === req.params.key);
		if (existing) existing.value = value;
		else MOCK_ADMIN_SETTINGS.push({ key: req.params.key, value });
		return { key: req.params.key, value };
	});
	on("POST", "/operator/settings/:key/revoke", (req) => ({ revoked: req.params.key, message: "revoked" }));
	on("GET", "/operator/restart/status", () => ({ required: false, changed_at: null, keys: [] }));
	on("GET", "/operator/trace-privacy", () => ({ trace_privacy: MOCK_ADMIN_STATE.tracePrivacy }));
	on("PUT", "/operator/trace-privacy", (req) => {
		MOCK_ADMIN_STATE.tracePrivacy = Boolean((req.body as { trace_privacy?: boolean } | undefined)?.trace_privacy);
		return { trace_privacy: MOCK_ADMIN_STATE.tracePrivacy };
	});
	on("GET", "/operator/registered-agents-only", () => ({
		registered_agents_only: MOCK_ADMIN_STATE.registeredAgentsOnly,
	}));
	on("PUT", "/operator/registered-agents-only", (req) => {
		MOCK_ADMIN_STATE.registeredAgentsOnly = Boolean(
			(req.body as { registered_agents_only?: boolean } | undefined)?.registered_agents_only,
		);
		return { registered_agents_only: MOCK_ADMIN_STATE.registeredAgentsOnly };
	});
	on("GET", "/operator/retention", () => MOCK_ADMIN_STATE.retention);
	on("PUT", "/operator/retention", (req) => {
		const body = (req.body ?? {}) as Partial<typeof MOCK_ADMIN_STATE.retention>;
		MOCK_ADMIN_STATE.retention = { ...MOCK_ADMIN_STATE.retention, ...body };
		return MOCK_ADMIN_STATE.retention;
	});
	on("GET", "/operator/retention/preview", () => ({
		traces: 1200,
		spans: 54000,
		scores: 300,
		session_events: 87000,
		insight_reports: 4,
	}));
	on("GET", "/operator/ai-engine/models/providers", () => ({
		providers: [
			{ id: "anthropic", label: "Anthropic", model_count: 0 },
			{ id: "openai", label: "OpenAI", model_count: 0 },
			{ id: "bedrock", label: "Amazon Bedrock", model_count: 0 },
		],
	}));
	on("GET", "/operator/ai-engine/models", () => ({ models: [], provider: "anthropic" }));
	on("POST", "/operator/ai-engine/test-connection", () => ({
		success: true,
		model: "anthropic/claude-sonnet-4-5",
		latency_ms: 420,
	}));
	on("GET", "/operator/audit-log", () => MOCK_AUDIT_LOG);
	on("GET", "/operator/audit-log/export", () =>
		[
			"event_id,timestamp,actor_email,action,resource_type,outcome",
			...MOCK_AUDIT_LOG.map(
				(e) => `${e.event_id},${e.timestamp},${e.actor_email},${e.action},${e.resource_type},${e.outcome}`,
			),
		].join("\n"),
	);
	on("GET", "/operator/security-events", () => ({
		events: MOCK_SECURITY_EVENTS,
		total: MOCK_SECURITY_EVENTS.length,
	}));
	on("GET", "/operator/status", () => MOCK_SYSTEM_STATUS);
	on("GET", "/operator/retention/warnings", () => MOCK_RETENTION_WARNINGS);

	// ── Operator control plane (deployment-level) ──────────────────────
	on("GET", "/operator/overview", () => {
		const operators = MOCK_USERS.filter((u) => u.role === "operator").length;
		const reviewers = MOCK_USERS.filter((u) => u.role === "reviewer").length;
		const monday = new Date();
		monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
		const weeks = Array.from({ length: 12 }, (_, i) => {
			const d = new Date(monday);
			d.setUTCDate(d.getUTCDate() - 7 * (11 - i));
			return {
				week_start: d.toISOString().slice(0, 10),
				organizations: i === 11 ? 1 : 0,
				users: i >= 10 ? 2 : 0,
				projects: i === 11 ? 1 : 0,
			};
		});
		return {
			totals: {
				organizations: MOCK_ORGS.length,
				organizations_suspended: 0,
				projects: MOCK_ORGS.reduce((n, o) => n + (o.project_count ?? 0), 0),
				agents: 3,
				users: {
					total: MOCK_USERS.length,
					operators,
					reviewers,
					members: MOCK_USERS.length - operators - reviewers,
				},
			},
			growth: { weeks },
			activity: {
				available: true,
				sessions_30d: 128,
				events_30d: 9421,
				orgs_active_30d: Math.min(1, MOCK_ORGS.length),
				top_orgs: MOCK_ORGS.slice(0, 5).map((o, i) => ({
					id: o.id,
					slug: o.slug,
					name: o.name,
					sessions_30d: 128 - i * 40,
				})),
			},
		};
	});
	on("GET", "/operator/orgs", (req) => {
		const q = (req.query.get("q") ?? "").toLowerCase();
		const limit = Number(req.query.get("limit") ?? "50");
		const offset = Number(req.query.get("offset") ?? "0");
		const filtered = MOCK_ORGS.filter(
			(o) => !q || o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q),
		);
		return {
			items: filtered.slice(offset, offset + limit).map((o) => ({
				id: o.id,
				slug: o.slug,
				name: o.name,
				created_at: o.created_at,
				suspended_at: null,
				member_count: o.member_count ?? 0,
				project_count: o.project_count ?? 0,
				owner_email: MOCK_USERS[0].email,
				sessions_30d: 42,
			})),
			total: filtered.length,
			limit,
			offset,
			activity: "ok",
		};
	});
	on("POST", "/operator/orgs/:id/suspend", (req) => ({
		id: req.params.id,
		slug: MOCK_ORGS.find((o) => o.id === req.params.id)?.slug ?? "org",
		suspended_at: new Date().toISOString(),
	}));
	on("POST", "/operator/orgs/:id/reinstate", (req) => ({
		id: req.params.id,
		slug: MOCK_ORGS.find((o) => o.id === req.params.id)?.slug ?? "org",
		suspended_at: null,
	}));
	on("DELETE", "/operator/orgs/:id", () => json(204, undefined));


	on("GET", "/exec/adoption", () => MOCK_EXEC_ADOPTION);
	on("GET", "/exec/agent-counts", () => MOCK_EXEC_AGENT_COUNTS);
	on("GET", "/exec/usage-by-category", () => MOCK_EXEC_USAGE_BY_CATEGORY);
	on("GET", "/exec/platform-coverage", () => MOCK_EXEC_PLATFORM_COVERAGE);
	on("GET", "/exec/platforms", () => MOCK_EXEC_PLATFORMS);
	on("GET", "/exec/velocity", () => MOCK_EXEC_VELOCITY);
	on("GET", "/exec/top-agents", () => MOCK_EXEC_TOP_AGENTS);
	on("GET", "/exec/departments", () => MOCK_EXEC_DEPARTMENTS);
	on("GET", "/exec/dept-tokens", () => MOCK_EXEC_DEPT_TOKENS);
	on("GET", "/exec/cost-summary", () => MOCK_EXEC_COST_SUMMARY);
	on("GET", "/exec/roi-projections", () => MOCK_EXEC_ROI);
	on("GET", "/exec/strategic-insights", () => MOCK_EXEC_STRATEGIC);
	on("GET", "/exec/developer-breakdown", () => MOCK_EXEC_DEVELOPERS);
	on("GET", "/exec/inactivity-alerts", () => MOCK_EXEC_INACTIVITY);
	on("GET", "/exec/time-to-value", () => MOCK_EXEC_TIME_TO_VALUE);
	on("GET", "/exec/ai-insights", () => MOCK_EXEC_AI_INSIGHTS);
	on("POST", "/exec/ai-insights", () => MOCK_EXEC_AI_INSIGHTS);
	on("GET", "/exec/config", () => MOCK_EXEC_STATE.config);
	on("PUT", "/exec/config", (req) => {
		MOCK_EXEC_STATE.config = { ...MOCK_EXEC_STATE.config, ...((req.body ?? {}) as Partial<typeof MOCK_EXEC_STATE.config>) };
		return MOCK_EXEC_STATE.config;
	});

	return routes;
}

function matchRoute(route: Route, method: string, pathSegments: string[]): Record<string, string> | null {
	if (route.method !== method) return null;
	if (route.segments.length !== pathSegments.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < route.segments.length; i++) {
		const expected = route.segments[i];
		const actual = pathSegments[i];
		if (expected.startsWith(":")) {
			params[expected.slice(1)] = decodeURIComponent(actual);
		} else if (expected !== actual) {
			return null;
		}
	}
	return params;
}

export function dispatch(routes: Route[], method: string, path: string, query: URLSearchParams, body: unknown): MockResponse | null {
	const pathSegments = path.split("/").filter(Boolean);
	for (const route of routes) {
		const params = matchRoute(route, method, pathSegments);
		if (params === null) continue;
		const result = route.handler({ method, path, params, query, body });
		if (result && typeof result === "object" && "status" in (result as MockResponse) && typeof (result as MockResponse).status === "number") {
			return result as MockResponse;
		}
		return { status: 200, body: result };
	}
	return null;
}
