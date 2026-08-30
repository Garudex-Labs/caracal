
// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type {
	OverviewStats,
	TopItem,
	TopAgentItem,
	TrendPoint,
	SessionData,
	TokenStats,
	HarnessUsageData,
	AdminUser,
	AdminSetting,
	AdminSettingSection,
	Session,
	TraceQueryParams,
	TraceQueryResponse,
	TelemetryStatus,
	ReviewItem,
	ReviewIssue,
	ReviewIssuesResponse,
	ProjectResourcesResponse,
	ResourceActivityResponse,
	ResourceContributorsResponse,
	RegistryItem,
	IntelligenceRange,
	IntelligenceBriefing,
	IntelligenceCompareResponse,
	IntelligenceHistoryResponse,
	IntelligenceResourceQuery,
	IntelligenceResourceVersionsResponse,
	IntelligenceResourcesResponse,
	ValidationResult,
	VersionSuggestions,
	AgentVersionDetail,
	AgentVersionsResponse,
	ComponentVersionsResponse,
	ComponentVersionDetail,
	VersionDiff,
	BulkResult,
	AuditLogEntry,
	SecurityEvent,
	ActivityPage,
	SystemStatusResponse,
	RestartStatus,
	SystemWarning,
	InsightReportListItem,
	InsightReport,
	InsightAppliedItems,
	ExecAdoptionResponse,
	ExecAgentCounts,
	ExecUsageByCategory,
	ExecPlatformCoverage,
	ExecPlatformScore,
	ExecVelocityResponse,
	ExecTopAgent,
	ExecConfig,
	ExecDepartmentsResponse,
	ExecDeptTokenItem,
	ExecCostSummary,
	ExecROIProjectionsResponse,
	ExecStrategicInsightsResponse,
	ExecDeveloperBreakdown,
	ExecInactivityAlerts,
	ExecTimeToValueResponse,
	ExecAIInsightsResponse,
	UserSearchResult,
	RegistryResolution,
	RecommendationsResponse,
	InboxItem,
	InboxItemDetail,
	InboxListResponse,
	InboxCounts,
	InboxFilters,
	InboxState,
	Organization,
	OrgMember,
	OrgMembersPage,
	OrgProjectsPage,
	OrgListParams,
	MemberProject,
	OrgCreateBody,
	OrgMemberUpsertBody,
	OrgInvitation,
	OrgInvitationCreateBody,
	OnboardingSnapshot,
	Project,
	ProjectMember,
	ProjectCreateBody,
	ProjectMemberUpsertBody,
	ProjectResources,
	ResourceRetentionPolicy,
	ResourceRetentionPolicyUpdate,
} from "./types";
import {
	activateAuthContext,
	authContextForPath,
	clearAllAuthContexts,
	clearStoredAuthContext,
	emitAuthChange,
	getStoredAccessToken,
	getStoredUserAvatar,
	getStoredUserEmail,
	getStoredUserName,
	getStoredUserRole,
	getStoredUserUsername,
	hasActiveAuthContext,
	setStoredAccessToken,
	setStoredUserAvatar,
	setStoredUserEmail,
	setStoredUserName,
	setStoredUserRole,
	setStoredUserUsername,
	tokenAuthContext,
	tokenPayload,
	type AuthContext,
} from "./auth-context";
import { sessionExpiredLoginUrl } from "./safe-next";

export type { AuthContext } from "./auth-context";
export { activateAuthContext, hasActiveAuthContext } from "./auth-context";

const API = "/api/v1";

/** How the UI should react to a failed request. */
export type ApiErrorKind =
	| "network"
	| "timeout"
	| "auth"
	| "permission"
	| "not_found"
	| "conflict"
	| "validation"
	| "rate_limited"
	| "unavailable"
	| "server"
	| "client";

interface ApiErrorOptions {
	code?: string;
	requestId?: string;
	retryable?: boolean;
	retryAfterMs?: number;
}

/**
 * Error thrown by the API client. Carries the HTTP status (0 for
 * network/timeout failures), the server's machine-readable error code and
 * correlation id when present, and whether a retry may succeed.
 */
export class ApiError extends Error {
	readonly code?: string;
	readonly requestId?: string;
	readonly retryable: boolean;
	readonly retryAfterMs?: number;
	constructor(
		message: string,
		readonly status: number,
		options: ApiErrorOptions = {},
	) {
		super(message);
		this.name = "ApiError";
		this.code = options.code;
		this.requestId = options.requestId;
		this.retryable =
			options.retryable ?? (status === 0 || status === 429 || (status >= 502 && status <= 504));
		this.retryAfterMs = options.retryAfterMs;
	}

	get kind(): ApiErrorKind {
		if (this.status === 0) return this.code === "timeout" ? "timeout" : "network";
		if (this.status === 401) return "auth";
		if (this.status === 403) return "permission";
		if (this.status === 404 || this.status === 410) return "not_found";
		if (this.status === 409) return "conflict";
		if (this.status === 422) return "validation";
		if (this.status === 429) return "rate_limited";
		if (this.status >= 502 && this.status <= 504) return "unavailable";
		if (this.status >= 500) return "server";
		return "client";
	}
}

/** The HTTP status when the error came from the API client, else undefined. */
export function apiErrorStatus(error: unknown): number | undefined {
	return error instanceof ApiError ? error.status : undefined;
}

/** The classification when the error came from the API client, else undefined. */
export function apiErrorKind(error: unknown): ApiErrorKind | undefined {
	return error instanceof ApiError ? error.kind : undefined;
}

/** Whether retrying the failed operation unchanged may succeed. */
export function isRetryableError(error: unknown): boolean {
	return error instanceof ApiError && error.retryable;
}

// Authentication lives in the Better Auth identity service: the session is
// an HttpOnly cookie it manages. Registry API calls use a short-lived JWT
// minted from context-specific token endpoints; the JWT is cached in
// sessionStorage and re-fetched when it expires. No refresh tokens exist
// on this side anymore.
export function getAccessToken(context: AuthContext = "tenant"): string | null {
	return getStoredAccessToken(context);
}

function jwtExpiryMs(token: string): number {
	try {
		const payload = tokenPayload(token);
		return typeof payload?.exp === "number" ? payload.exp * 1000 : 0;
	} catch {
		return 0;
	}
}

function tokenIsFresh(token: string): boolean {
	// 30s slack so a token never dies mid-request.
	return jwtExpiryMs(token) - 30_000 > Date.now();
}

const _tokenPromise: Partial<Record<AuthContext, Promise<string | null>>> = {};

async function _fetchJwtFromSession(context: AuthContext): Promise<string | null> {
	try {
		const res = await fetch(`/api/auth/${context}-token`, {
			credentials: "include",
			cache: "no-store",
		});
		if (!res.ok) return null;
		const data = await res.json();
		if (!data?.token) return null;
		if (tokenAuthContext(data.token) !== context) return null;
		setStoredAccessToken(context, data.token);
		activateAuthContext(context);
		return data.token as string;
	} catch {
		return null;
	}
}

function tokenArgs(contextOrForce: AuthContext | boolean = "tenant", force = false) {
	if (typeof contextOrForce === "boolean") return { context: "tenant" as const, force: contextOrForce };
	return { context: contextOrForce, force };
}

/**
 * Return a fresh access JWT, minting one from the identity-service session
 * when the cached one is missing or expired. Concurrent callers share one
 * in-flight fetch. Returns null when there is no live session.
 */
export async function ensureAccessToken(contextOrForce: AuthContext | boolean = "tenant", force = false): Promise<string | null> {
	if (typeof window === "undefined") return null;
	const args = tokenArgs(contextOrForce, force);
	if (!args.force && !hasActiveAuthContext(args.context)) return null;
	const cached = getAccessToken(args.context);
	if (!args.force && cached && tokenIsFresh(cached)) return cached;
	if (!_tokenPromise[args.context]) {
		_tokenPromise[args.context] = _fetchJwtFromSession(args.context).finally(() => {
			delete _tokenPromise[args.context];
		});
	}
	return _tokenPromise[args.context] ?? null;
}

export function clearSession(context?: AuthContext) {
	if (context) {
		clearStoredAuthContext(context);
		emitAuthChange();
		return;
	}
	clearAllAuthContexts();
	emitAuthChange();
}

export function setUserRole(role: string, context: AuthContext = "tenant") {
	setStoredUserRole(role, context);
}

export function getUserRole(context: AuthContext = "tenant"): string | null {
	return getStoredUserRole(context);
}

export function setUserName(name: string, context: AuthContext = "tenant") {
	setStoredUserName(name, context);
}

export function getUserName(context: AuthContext = "tenant"): string | null {
	return getStoredUserName(context);
}

export function setUserEmail(email: string, context: AuthContext = "tenant") {
	setStoredUserEmail(email, context);
}

export function getUserEmail(context: AuthContext = "tenant"): string | null {
	return getStoredUserEmail(context);
}

export function setUserUsername(username: string, context: AuthContext = "tenant") {
	setStoredUserUsername(username, context);
}

export function getUserUsername(context: AuthContext = "tenant"): string | null {
	return getStoredUserUsername(context);
}

export function setUserAvatar(avatar: string | null, context: AuthContext = "tenant") {
	setStoredUserAvatar(avatar, context);
}

export function getUserAvatar(context: AuthContext = "tenant"): string | null {
	return getStoredUserAvatar(context);
}

// The active org/project ride on every API call so the server can bind new
// resources to the caller's working context. Slugs are lookup keys only -
// membership is validated server-side on each request.
import { getTenant, isProjectFreePath, pathWithoutProjectPrefix } from "@/lib/tenant-host";

function tenancyHeaders(): Record<string, string> {
	if (typeof window === "undefined") return {};
	const { hostOrg, urlProject } = getTenant();
	// Org: authoritative from the host subdomain, else the session's selected
	// org (single-host deployments). Project: ONLY the URL prefix - a cached or
	// remembered project must never scope a request the URL did not ask for.
	const org = hostOrg ?? localStorage.getItem("caracal_current_org") ?? "";
	if (!org) return {};
	const out: Record<string, string> = { "X-Caracal-Org": org };
	const unprefixedPath = pathWithoutProjectPrefix(window.location.pathname, urlProject);
	if (urlProject && !isProjectFreePath(unprefixedPath)) out["X-Caracal-Project"] = urlProject;
	return out;
}

/** Per-request deadline so a hung upstream never leaves a query pending forever. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * fetch() with a deadline and normalized transport failures: timeouts and
 * network errors surface as retryable ApiError(status 0) instead of raw
 * TypeError/AbortError, so every status-based branch downstream keeps working.
 */
async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch {
		if (controller.signal.aborted) {
			throw new ApiError("The request timed out. Try again.", 0, {
				code: "timeout",
				retryable: true,
			});
		}
		throw new ApiError("Can't reach the server. Check your connection.", 0, {
			code: "network",
			retryable: true,
		});
	} finally {
		clearTimeout(timer);
	}
}

/** Build an ApiError from a non-2xx response, parsing the server's error envelope. */
function parseErrorResponse(text: string, response: Response): ApiError {
	let detail = text;
	let code: string | undefined;
	let requestId: string | undefined;
	let retryable: boolean | undefined;

	// Guard against raw HTML responses (e.g. nginx 502 Bad Gateway)
	if (text.trim().startsWith("<")) {
		detail =
			response.status >= 500
				? "Unable to reach the server. Please try again later."
				: `Request failed (${response.status})`;
	} else {
		try {
			const parsed = JSON.parse(text);
			if (parsed.detail) {
				if (typeof parsed.detail === "string") {
					detail = parsed.detail;
				} else if (Array.isArray(parsed.detail)) {
					detail = parsed.detail
						.map(
							(e: { msg?: string }) =>
								e.msg?.replace(/^Value error, /i, "") || "Validation error",
						)
						.join(". ");
				} else {
					detail = JSON.stringify(parsed.detail);
				}
			} else if (parsed.error) {
				detail =
					typeof parsed.error === "string"
						? parsed.error
						: JSON.stringify(parsed.error);
			}
			if (typeof parsed.code === "string") code = parsed.code;
			if (typeof parsed.request_id === "string") requestId = parsed.request_id;
			if (typeof parsed.retryable === "boolean") retryable = parsed.retryable;
		} catch {
			if (detail.length > 200 || detail.includes("Traceback") || detail.includes("Error:")) {
				detail = `Request failed (${response.status})`;
			}
		}
	}

	requestId ??= response.headers.get("x-request-id") ?? undefined;
	const retryAfter = Number(response.headers.get("retry-after"));
	const retryAfterMs =
		Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
	return new ApiError(detail, response.status, { code, requestId, retryable, retryAfterMs });
}

async function request<T = unknown>(
	method: string,
	path: string,
	body?: unknown,
	context: AuthContext = authContextForPath(path),
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...tenancyHeaders(),
	};
	const token = await ensureAccessToken(context);
	if (token) headers["Authorization"] = `Bearer ${token}`;

	const doFetch = () =>
		fetchWithTimeout(`${API}${path}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			cache: "no-store",
		});

	// Only idempotent requests get an automatic in-place retry: re-sending a
	// mutation that 500ed after committing would double-submit it.
	const idempotent = method === "GET" || method === "HEAD";

	let response = await doFetch();
	if (response.status >= 500 && idempotent) {
		// Brief pause before a single retry on 5xx
		await new Promise((r) => setTimeout(r, 500));
		response = await doFetch();
	}

	if (!response.ok) {
		// On 401, mint a fresh JWT from the identity-service session and retry
		// once; a dead session redirects to login.
		if (response.status === 401) {
			const newToken = hasActiveAuthContext(context) ? await ensureAccessToken(context, true) : null;

			if (newToken) {
				headers["Authorization"] = `Bearer ${newToken}`;
				const retryRes = await fetchWithTimeout(`${API}${path}`, {
					method,
					headers,
					body: body !== undefined ? JSON.stringify(body) : undefined,
					cache: "no-store",
				});
				if (retryRes.ok) {
					if (retryRes.status === 204) return undefined as T;
					return retryRes.json() as Promise<T>;
				}
				const retryText = await retryRes.text().catch(() => "Request failed");
				throw parseErrorResponse(retryText, retryRes);
			}

			// No live session: send the user to sign in again.
			clearSession();
			if (typeof window !== "undefined") {
				window.location.href = sessionExpiredLoginUrl();
				return new Promise<T>(() => {});
			}
			throw new ApiError("Session expired", 401);
		}

		const text = await response.text().catch(() => response.statusText);
		throw parseErrorResponse(text, response);
	}

	if (response.status === 204) return undefined as T;

	return response.json() as Promise<T>;
}

function get<T = unknown>(path: string, context?: AuthContext) {
	return request<T>("GET", path, undefined, context);
}
function post<T = unknown>(path: string, body?: unknown, context?: AuthContext) {
	return request<T>("POST", path, body, context);
}
function put<T = unknown>(path: string, body?: unknown, context?: AuthContext) {
	return request<T>("PUT", path, body, context);
}
function del<T = unknown>(path: string, context?: AuthContext) {
	return request<T>("DELETE", path, undefined, context);
}
function patch<T = unknown>(path: string, body?: unknown, context?: AuthContext) {
	return request<T>("PATCH", path, body, context);
}

export async function graphql<T = unknown>(
	query: string,
	variables?: Record<string, unknown>,
): Promise<T> {
	const res = await post<{ data: T; errors?: { message: string }[] }>(
		"/graphql",
		{ query, variables },
	);
	if (res.errors?.length) throw new Error(res.errors[0].message);
	return res.data;
}

// ── Auth ────────────────────────────────────────────────────────────
// Sign-in, sign-up, sessions, passwords, SSO, passkeys, and magic links
// all go through the Better Auth client (lib/auth-client.ts). Only
// application-profile endpoints remain on the registry API.

export const auth = {
	whoami: (context: AuthContext = "tenant") =>
		get<{
			id: string;
			email: string;
			username?: string | null;
			name: string;
			role: string;
			auth_context?: AuthContext | null;
			avatar_url?: string | null;
		}>("/auth/whoami", context),
	updateUsername: (body: { username: string }) =>
		put<{ username: string }>("/auth/profile/username", body),
	uploadAvatar: (body: { avatar_url: string }) =>
		put<{ avatar_url: string | null }>("/auth/profile/avatar", body),
	deleteAvatar: () => del<{ avatar_url: null }>("/auth/profile/avatar"),
};

// ── Registry (agents + all component types) ────────────────────────
export type RegistryType =
	| "mcps"
	| "agents"
	| "skills"
	| "hooks"
	| "prompts"
	| "sandboxes";

// GET /registry/resolve takes the singular form of each registry type.
const SINGULAR_REGISTRY_TYPE: Record<RegistryType, string> = {
	agents: "agent",
	mcps: "mcp",
	skills: "skill",
	hooks: "hook",
	prompts: "prompt",
	sandboxes: "sandbox",
};

export const registry = {
	list: (type: RegistryType, params?: Record<string, string>) => {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		return get<RegistryItem[]>(`/${type}${qs}`);
	},
	get: (type: RegistryType, id: string) => get<RegistryItem>(`/${type}/${id}`),
	create: (type: RegistryType, body: unknown) =>
		post<RegistryItem>(`/${type}`, body),
	install: (type: RegistryType, id: string, body?: unknown) =>
		post<unknown>(`/${type}/${id}/install`, body),
	delete: (type: RegistryType, id: string) => del(`/${type}/${id}`),
	metrics: (type: RegistryType, id: string) =>
		get<unknown>(`/${type}/${id}/metrics`),
	resolve: (id: string) => get<unknown>(`/agents/${id}/resolve`),
	// Canonical `namespace/slug` (or UUID) → registry identity, for shareable URLs.
	resolveIdentifier: (type: RegistryType, identifier: string) =>
		get<RegistryResolution>(
			`/registry/resolve?type=${SINGULAR_REGISTRY_TYPE[type]}&identifier=${encodeURIComponent(identifier)}`,
		),
	manifest: (id: string) =>
		get<Record<string, unknown>>(`/agents/${id}/manifest`),
	downloads: (id: string) =>
		get<{ total: number; unique_users: number; recent_7d: number }>(
			`/agents/${id}/downloads`,
		),
	validate: (body: {
		components: { component_type: string; component_id: string }[];
		project_id?: string;
		// Mirrors the server's Visibility literal (schemas/constants.py).
		visibility?: "public" | "team" | "private";
	}) => post<ValidationResult>("/agents/validate", body),
	previewConfig: (body: {
		name: string;
		description: string;
		prompt: string;
		model_name: string;
		components: { component_type: string; component_id: string }[];
		target_harnesses?: string[];
	}) =>
		post<{ configs: Record<string, Record<string, string>> }>(
			"/agents/preview-config",
			body,
		),
	my: (type?: RegistryType) => get<RegistryItem[]>(`/${type ?? "agents"}/my`),
	deletedAgents: () => get<RegistryItem[]>("/agents/deleted"),
	purgeDeletedAgent: (id: string, body: { confirm: string }) => post(`/agents/${id}/purge`, body),
	archive: (id: string) => patch(`/agents/${id}/archive`),
	unarchive: (id: string) => patch(`/agents/${id}/unarchive`),
	restoreDeletedAgent: (id: string, body?: { name?: string }) => patch(`/agents/${id}/restore`, body ?? {}),
	archiveComponent: (type: RegistryType, id: string) => patch(`/${type}/${id}/archive`),
	unarchiveComponent: (type: RegistryType, id: string) => patch(`/${type}/${id}/unarchive`),
	draft: (body: unknown, type?: RegistryType) =>
		post<RegistryItem>(`/${type ?? "agents"}/draft`, body),
	updateDraft: (id: string, body: unknown, type?: RegistryType) =>
		put<RegistryItem>(`/${type ?? "agents"}/${id}/draft`, body),
	updateAgent: (id: string, body: unknown) =>
		put<RegistryItem>(`/agents/${id}`, body),
	submitDraft: (id: string, type?: RegistryType) =>
		post(`/${type ?? "agents"}/${id}/submit`),
	submit: (type: RegistryType, body: unknown) =>
		post<RegistryItem>(`/${type}/submit`, body),
	listVersions: (agentId: string, page = 1, pageSize = 50) =>
		get<AgentVersionsResponse>(
			`/agents/${agentId}/versions?page=${page}&page_size=${pageSize}`,
		),
	getVersion: (agentId: string, version: string) =>
		get<AgentVersionDetail>(`/agents/${agentId}/versions/${version}`),
	getVersionDiff: (agentId: string, v1: string, v2: string) =>
		get<VersionDiff>(`/agents/${agentId}/versions/${v1}/diff/${v2}`),

	// Component versions
	listComponentVersions: (
		type: RegistryType,
		listingId: string,
		page = 1,
		pageSize = 50,
	) =>
		get<ComponentVersionsResponse>(
			`/${type}/${listingId}/versions?page=${page}&page_size=${pageSize}`,
		),
	getComponentVersion: (
		type: RegistryType,
		listingId: string,
		version: string,
	) => get<ComponentVersionDetail>(`/${type}/${listingId}/versions/${version}`),
	publishComponentVersion: (
		type: RegistryType,
		listingId: string,
		body: unknown,
	) => post<ComponentVersionDetail>(`/${type}/${listingId}/versions`, body),
	componentVersionSuggestions: (type: RegistryType, listingId: string) =>
		get<VersionSuggestions>(`/${type}/${listingId}/version-suggestions`),
	// ── Resource lifecycle: derived history, attribution, controlled rollback ──
	resourceActivity: (subjectId: string, limit = 100) =>
		get<ResourceActivityResponse>(`/resources/${subjectId}/activity?limit=${limit}`),
	resourceContributors: (subjectId: string) =>
		get<ResourceContributorsResponse>(`/resources/${subjectId}/contributors`),
	restoreAgentVersion: (agentId: string, version: string, reason?: string) =>
		post<AgentVersionDetail & { restored_from: string }>(
			`/agents/${agentId}/versions/${version}/restore`,
			reason ? { reason } : {},
		),
	restoreComponentVersion: (
		type: RegistryType,
		listingId: string,
		version: string,
		reason?: string,
	) =>
		post<ComponentVersionDetail & { restored_from: string }>(
			`/${type}/${listingId}/versions/${version}/restore`,
			reason ? { reason } : {},
		),
	startEdit: (id: string, type?: RegistryType) =>
		post<{ status: string }>(`/${type ?? "agents"}/${id}/start-edit`),
	cancelEdit: (id: string, type?: RegistryType) =>
		post<{ status: string }>(`/${type ?? "agents"}/${id}/cancel-edit`),
};

// ── Review ──────────────────────────────────────────────────────────
export const review = {
	get: (id: string) => get<ReviewItem>(`/review/${id}`),
	// ── Review issues: focused, resolvable feedback on a change ───────────
	issues: (subjectId: string, params?: Record<string, string>) => {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		return get<ReviewIssuesResponse>(`/review/${subjectId}/issues${qs}`);
	},
	createIssue: (
		subjectId: string,
		body: { title: string; body?: string; version_id?: string; context?: string },
	) => post<ReviewIssue>(`/review/${subjectId}/issues`, body),
	setIssueStatus: (issueId: string, status: "open" | "resolved") =>
		patch<ReviewIssue>(`/review/issues/${issueId}`, { status }),
	commentIssue: (issueId: string, body: string) =>
		post<ReviewIssue>(`/review/issues/${issueId}/comments`, { body }),
	approve: (id: string) => post(`/review/${id}/approve`),
	reject: (id: string, body: { reason: string }) =>
		post(`/review/${id}/reject`, body),
	approveAgent: (id: string, body?: { category?: string }) =>
		post(`/review/agents/${id}/approve`, body),
	rejectAgent: (id: string, body: { reason: string }) =>
		post(`/review/agents/${id}/reject`, body),
	approveBundle: (id: string) => post(`/review/bundles/${id}/approve`),
	rejectBundle: (id: string, body: { reason: string }) =>
		post(`/review/bundles/${id}/reject`, body),
	relatedSkills: (id: string) =>
		get<{ skills: ReviewItem[] }>(`/review/${id}/related-skills`),
	approveWithSkills: (id: string, body: { skill_ids: string[] }) =>
		post(`/review/${id}/approve-with-skills`, body),
};

// ── Telemetry ───────────────────────────────────────────────────────
export const telemetry = {
	status: () => get<TelemetryStatus>("/telemetry/status"),
};

// ── Users ───────────────────────────────────────────────────────────
export const users = {
	search: (params: { q: string; limit?: number }) => {
		const qs = new URLSearchParams({ q: params.q });
		if (params.limit) qs.set("limit", String(params.limit));
		return get<UserSearchResult[]>(`/users/search?${qs}`);
	},
};

// ── Organizations & projects ────────────────────────────────────────
// Path identity is the slug; the server validates membership on every
// request and answers 404 for organizations the caller cannot see.

/** Query string for the paginated org listings; omits empty values. */
function listQuery(params?: OrgListParams): string {
	if (!params) return "";
	const qs = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && `${value}` !== "") qs.set(key, `${value}`);
	}
	const s = qs.toString();
	return s ? `?${s}` : "";
}

export const orgs = {
	list: () => get<Organization[]>("/orgs"),
	get: (slug: string) => get<Organization>(`/orgs/${encodeURIComponent(slug)}`),
	auditLog: (slug: string, params?: Record<string, string>) => {
		const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
		return get<ActivityPage<AuditLogEntry>>(`/orgs/${encodeURIComponent(slug)}/audit-log${qs}`);
	},
	securityEvents: (slug: string, params?: Record<string, string>) => {
		const qs = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : "";
		return get<ActivityPage<SecurityEvent>>(`/orgs/${encodeURIComponent(slug)}/security-events${qs}`);
	},
	create: (body: OrgCreateBody) => post<Organization>("/orgs", body),
	update: (slug: string, body: { name?: string; description?: string; slug?: string }) =>
		patch<Organization>(`/orgs/${encodeURIComponent(slug)}`, body),
	delete: (slug: string) => del(`/orgs/${encodeURIComponent(slug)}`),
	members: (slug: string, params?: OrgListParams) =>
		get<OrgMembersPage>(`/orgs/${encodeURIComponent(slug)}/members${listQuery(params)}`),
	memberProjects: (slug: string, userId: string) =>
		get<MemberProject[]>(`/orgs/${encodeURIComponent(slug)}/members/${encodeURIComponent(userId)}/projects`),
	upsertMember: (slug: string, body: OrgMemberUpsertBody) =>
		post<OrgMember>(`/orgs/${encodeURIComponent(slug)}/members`, body),
	removeMember: (slug: string, userId: string) =>
		del(`/orgs/${encodeURIComponent(slug)}/members/${userId}`),
	transferOwnership: (slug: string, userId: string) =>
		post<OrgMember>(`/orgs/${encodeURIComponent(slug)}/transfer-ownership`, { user_id: userId }),
	projects: (slug: string, params?: OrgListParams) =>
		get<OrgProjectsPage>(`/orgs/${encodeURIComponent(slug)}/projects${listQuery(params)}`),
	project: (slug: string, project: string) =>
		get<Project>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}`),
	createProject: (slug: string, body: ProjectCreateBody) =>
		post<Project>(`/orgs/${encodeURIComponent(slug)}/projects`, body),
	updateProject: (slug: string, project: string, body: { name?: string; description?: string }) =>
		patch<Project>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}`, body),
	deleteProject: (slug: string, project: string) =>
		del(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}`),
	projectMembers: (slug: string, project: string) =>
		get<ProjectMember[]>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/members`),
	upsertProjectMember: (slug: string, project: string, body: ProjectMemberUpsertBody) =>
		post<ProjectMember>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/members`, body),
	removeProjectMember: (slug: string, project: string, userId: string) =>
		del(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/members/${userId}`),
	projectResources: (slug: string, project: string) =>
		get<ProjectResources>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/resources`),
	resourceRetentionPolicy: (slug: string, project: string) =>
		get<ResourceRetentionPolicy>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/retention-policy`),
	updateResourceRetentionPolicy: (slug: string, project: string, body: ResourceRetentionPolicyUpdate, preview = false) =>
		put<ResourceRetentionPolicy>(`/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(project)}/retention-policy${preview ? "?preview=true" : ""}`, body),
	invitations: (slug: string) => get<OrgInvitation[]>(`/orgs/${encodeURIComponent(slug)}/invitations`),
	createInvitation: (slug: string, body: OrgInvitationCreateBody) =>
		post<OrgInvitation>(`/orgs/${encodeURIComponent(slug)}/invitations`, body),
	revokeInvitation: (slug: string, id: string) =>
		del(`/orgs/${encodeURIComponent(slug)}/invitations/${id}`),
};

// ── Onboarding (server-derived setup state) ─────────────────────────

export const onboarding = {
	snapshot: () => get<OnboardingSnapshot>("/onboarding"),
	completeProfile: () => post<{ completed: boolean }>("/onboarding/profile/complete", {}),
};

// The caller's own invitations: listed by address, accepted by id or link token.
export const invitations = {
	mine: () => get<OrgInvitation[]>("/invitations"),
	accept: (id: string) => post<Organization>(`/invitations/${id}/accept`, {}),
	previewToken: (token: string) => get<OrgInvitation>(`/invitations/token/${encodeURIComponent(token)}`),
	acceptToken: (token: string) => post<Organization>(`/invitations/token/${encodeURIComponent(token)}/accept`, {}),
};

// ── Project Intelligence ─────────────────────────────────
const intelligenceBase = (org: string, project: string) =>
	`/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/intelligence`;

export const intelligence = {
	briefing: (org: string, project: string, range: IntelligenceRange) =>
		get<IntelligenceBriefing>(`${intelligenceBase(org, project)}/briefing?range=${range}`),
	resources: (org: string, project: string, query: IntelligenceResourceQuery) => {
		const params = new URLSearchParams({ range: query.range });
		if (query.focus && query.focus !== "all") params.set("focus", query.focus);
		if (query.search) params.set("search", query.search);
		if (query.sort) params.set("sort", query.sort);
		if (query.page) params.set("page", String(query.page));
		if (query.pageSize) params.set("page_size", String(query.pageSize));
		return get<IntelligenceResourcesResponse>(`${intelligenceBase(org, project)}/resources?${params}`);
	},
	compare: (org: string, project: string, range: IntelligenceRange, a: string, b: string) =>
		get<IntelligenceCompareResponse>(
			`${intelligenceBase(org, project)}/resources/compare?range=${range}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
		),
	resourceVersions: (org: string, project: string, resource: string, range: IntelligenceRange) =>
		get<IntelligenceResourceVersionsResponse>(
			`${intelligenceBase(org, project)}/resources/${encodeURIComponent(resource)}/versions?range=${range}`,
		),
	history: (
		org: string,
		project: string,
		range: IntelligenceRange,
		params?: { resource?: string; category?: string; page?: number; pageSize?: number },
	) => {
		const query = new URLSearchParams({ range });
		if (params?.resource) query.set("resource", params.resource);
		if (params?.category && params.category !== "all") query.set("category", params.category);
		if (params?.page) query.set("page", String(params.page));
		if (params?.pageSize) query.set("page_size", String(params.pageSize));
		return get<IntelligenceHistoryResponse>(`${intelligenceBase(org, project)}/history?${query}`);
	},
};

// ── Dashboard ───────────────────────────────────────────────────────
export const dashboard = {
	stats: (range?: string) =>
		get<OverviewStats>(`/overview/stats${range ? `?range=${range}` : ""}`),
	topMcps: () => get<TopItem[]>("/overview/top-mcps"),
	topAgents: (limit?: number) =>
		get<TopAgentItem[]>(
			`/overview/top-agents${limit ? `?limit=${limit}` : ""}`,
		),
	trends: (range?: string) =>
		get<TrendPoint[]>(`/overview/trends${range ? `?range=${range}` : ""}`),
	tokenStats: (range?: string) =>
		get<TokenStats>(`/dashboard/tokens${range ? `?range=${range}` : ""}`),
	harnessUsage: () => get<HarnessUsageData>("/dashboard/harness-usage"),
	sessions: (params?: {
		status?: string;
		platform?: string;
		user?: string;
		days?: number;
		limit?: number;
		offset?: number;
		mine?: boolean;
	}) => {
		const qs = new URLSearchParams();
		if (params?.status) qs.set("status", params.status);
		if (params?.platform) qs.set("platform", params.platform);
		if (params?.user) qs.set("user", params.user);
		if (params?.days) qs.set("days", String(params.days));
		if (params?.limit) qs.set("limit", String(params.limit));
		if (params?.offset) qs.set("offset", String(params.offset));
		if (params?.mine) qs.set("mine", "true");
		const suffix = qs.toString() ? `?${qs}` : "";
		return get<Session[]>(`/sessions${suffix}`);
	},
	sessionsQuery: (params: TraceQueryParams) => {
		const qs = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "" && value !== false && value !== 0) qs.set(key, String(value));
		}
		const suffix = qs.toString() ? `?${qs}` : "";
		return get<TraceQueryResponse>(`/sessions/query${suffix}`);
	},
	session: (id: string) =>
		get<SessionData>(`/sessions/${encodeURIComponent(id)}`),
};

// ── Admin ───────────────────────────────────────────────────────────
export const admin = {
	settings: () =>
		get<AdminSetting[] | Record<string, string>>("/operator/settings"),
	settingsSchema: () => get<AdminSettingSection[]>("/operator/settings/schema"),
	updateSetting: (key: string, body: unknown) =>
		put<unknown>(`/operator/settings/${key}`, body),
	deleteSetting: (key: string) => del(`/operator/settings/${key}`),
	revokeSetting: (key: string) =>
		post<{ revoked: string; message: string }>(
			`/operator/settings/${key}/revoke`,
			{},
		),
	testAiEngineConnection: (body?: { model?: string }) =>
		post<{
			success: boolean;
			model?: string;
			latency_ms?: number;
			error?: string;
			hint?: string;
		}>("/operator/ai-engine/test-connection", body ?? {}),
	aiEngineModelProviders: () => get<import("./types").LiteLLMProviderList>("/operator/ai-engine/models/providers"),
	aiEngineModels: (provider: string) =>
		get<import("./types").LiteLLMModelList>(`/operator/ai-engine/models?provider=${encodeURIComponent(provider)}`),
	purgeTracesAndInsights: () =>
		post<{
			project_id: string;
			clickhouse_tables: string[];
			deleted_reports?: number;
			deleted_facets?: number;
			deleted_session_meta?: number;
			deleted_meta_cache?: number;
		}>("/operator/settings/danger/purge-traces-insights", {}),
	users: (params?: { q?: string; role?: string; sort?: string; order?: string; limit?: number; offset?: number }) => {
		const qs = new URLSearchParams();
		if (params?.q) qs.set("q", params.q);
		if (params?.role) qs.set("role", params.role);
		if (params?.sort) qs.set("sort", params.sort);
		if (params?.order) qs.set("order", params.order);
		if (params?.limit !== undefined) qs.set("limit", String(params.limit));
		if (params?.offset !== undefined) qs.set("offset", String(params.offset));
		const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
		return get<import("./types/admin").AdminUserPage>(`/operator/users${suffix}`);
	},
	updateRole: (id: string, body: { role: string }) =>
		put<AdminUser>(`/operator/users/${id}/role`, body),
	updateDepartment: (id: string, body: { department: string | null }) =>
		put<AdminUser>(`/operator/users/${id}/department`, body),
	bulkDepartment: (entries: { email: string; department: string }[]) =>
		post<{ updated: number; not_found: string[] }>(
			"/operator/users/bulk-department",
			{ entries },
		),
	deleteUser: (id: string) => del(`/operator/users/${id}`),
	applyResources: () =>
		post<{ applied: Record<string, string>; message: string }>(
			"/operator/resources/apply",
			{},
		),
	getTracePrivacy: () =>
		get<{ trace_privacy: boolean }>("/operator/trace-privacy"),
	setTracePrivacy: (enabled: boolean) =>
		put<{ trace_privacy: boolean }>("/operator/trace-privacy", {
			trace_privacy: enabled,
		}),
	getRegisteredAgentsOnly: () =>
		get<{ registered_agents_only: boolean }>(
			"/operator/registered-agents-only",
		),
	setRegisteredAgentsOnly: (enabled: boolean) =>
		put<{ registered_agents_only: boolean }>(
			"/operator/registered-agents-only",
			{ registered_agents_only: enabled },
		),
	auditLog: (params?: Record<string, string>) => {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		return get<AuditLogEntry[]>(`/operator/audit-log${qs}`);
	},
	auditLogExport: async (params?: Record<string, string>) => {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		const token = await ensureAccessToken("operator");
		const headers: Record<string, string> = {};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		const res = await fetch(`${API}/operator/audit-log/export${qs}`, { headers });
		if (!res.ok) throw new Error("Export failed");
		return res.text();
	},
	securityEvents: (params?: Record<string, string>) => {
		const qs = params ? `?${new URLSearchParams(params)}` : "";
		return get<{ events: SecurityEvent[]; total: number }>(
			`/operator/security-events${qs}`,
		);
	},
	systemStatus: () => get<SystemStatusResponse>("/operator/status"),
	restartStatus: () => get<RestartStatus>("/operator/restart/status"),
	systemWarnings: () => get<SystemWarning[]>("/operator/system-warnings"),
	restartApi: () =>
		post<{ detail: string; delay_seconds: number }>("/operator/restart", {}),
	getRetention: () => get<RetentionConfig>("/operator/retention"),
	setRetention: (body: RetentionConfigUpdate) =>
		put<RetentionConfig>("/operator/retention", body),
	previewRetention: (days: number) =>
		get<RetentionPreview>(`/operator/retention/preview?days=${days}`),
	getRetentionStats: () => get<RetentionStats>("/operator/retention/stats"),
	getRetentionWarnings: () =>
		get<RetentionWarnings>("/operator/retention/warnings"),
	// ── Migration ──────────────────────────────────────────────
	migrateExport: (scope: string) =>
		post<{ job_id: string }>("/operator/migrate/export", { scope }),
	migrateImport: async (formData: FormData) => {
		const token = await ensureAccessToken("operator");
		const headers: Record<string, string> = {};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		const res = await fetch(`${API}/operator/migrate/import`, {
			method: "POST",
			headers,
			body: formData,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "Import failed");
			let detail = text;
			try {
				const parsed = JSON.parse(text);
				if (parsed.detail) detail = parsed.detail;
			} catch {
				/* raw text */
			}
			throw new Error(detail);
		}
		return res.json() as Promise<{ job_id: string }>;
	},
	migrateValidate: async (formData: FormData) => {
		const token = await ensureAccessToken("operator");
		const headers: Record<string, string> = {};
		if (token) headers["Authorization"] = `Bearer ${token}`;
		const res = await fetch(`${API}/operator/migrate/validate`, {
			method: "POST",
			headers,
			body: formData,
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "Validate failed");
			let detail = text;
			try {
				const parsed = JSON.parse(text);
				if (parsed.detail) detail = parsed.detail;
			} catch {
				/* raw text */
			}
			throw new Error(detail);
		}
		return res.json() as Promise<{ job_id: string }>;
	},
	migrateJob: (id: string) =>
		get<import("./types/admin").MigrationJob>(`/operator/migrate/jobs/${id}`),
	migrateJobs: () =>
		get<import("./types/admin").MigrationJob[]>("/operator/migrate/jobs"),
	migrateDownloadToken: (jobId: string, name: string) =>
		post<import("./types/admin").MigrationDownloadToken>(
			`/operator/migrate/jobs/${jobId}/artifacts/${name}/token`,
			{},
		),
};

// ── Operator control plane (deployment-level, never tenant content) ──
export type OperatorOverview = {
	totals: {
		organizations: number;
		organizations_suspended: number;
		projects: number;
		agents: number;
		users: { total: number; operators: number; reviewers: number; members: number };
	};
	growth: {
		weeks: { week_start: string; organizations: number; users: number; projects: number }[];
	};
	activity:
		| { available: false }
		| {
				available: true;
				sessions_30d: number;
				events_30d: number;
				orgs_active_30d: number;
				top_orgs: { id: string; slug: string; name: string; sessions_30d: number }[];
		  };
};

export type OperatorOrg = {
	id: string;
	slug: string;
	name: string;
	created_at: string;
	suspended_at: string | null;
	member_count: number;
	project_count: number;
	owner_email: string | null;
	sessions_30d: number | null;
};

export type OperatorOrgParams = {
	q?: string;
	status?: "active" | "suspended";
	sort?: "created" | "name" | "members" | "projects" | "activity";
	order?: "asc" | "desc";
	limit?: number;
	offset?: number;
};

export type OperatorOrgPage = {
	items: OperatorOrg[];
	total: number;
	limit: number;
	offset: number;
	activity: "ok" | "unavailable";
};

export const operator = {
	overview: () => get<OperatorOverview>("/operator/overview"),
	orgs: (params?: OperatorOrgParams) => {
		const qs = new URLSearchParams();
		if (params?.q) qs.set("q", params.q);
		if (params?.status) qs.set("status", params.status);
		if (params?.sort) qs.set("sort", params.sort);
		if (params?.order) qs.set("order", params.order);
		if (params?.limit !== undefined) qs.set("limit", String(params.limit));
		if (params?.offset !== undefined) qs.set("offset", String(params.offset));
		const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
		return get<OperatorOrgPage>(`/operator/orgs${suffix}`);
	},
	suspendOrg: (id: string, confirm: string) =>
		post<{ id: string; slug: string; suspended_at: string }>(
			`/operator/orgs/${id}/suspend`,
			{ confirm },
		),
	reinstateOrg: (id: string, confirm: string) =>
		post<{ id: string; slug: string; suspended_at: null }>(
			`/operator/orgs/${id}/reinstate`,
			{ confirm },
		),
	deleteOrg: (id: string, confirm: string) =>
		request<void>("DELETE", `/operator/orgs/${id}`, { confirm }),
};

// ── Retention Types ───────────────────────────────────────────────
export type RetentionConfig = {
	retention_enabled: boolean;
	data_retention_days: number | null;
	score_retention_days: number | null;
	max_trace_count: number | null;
	global_retention_days: number;
};

export type RetentionConfigUpdate = {
	retention_enabled: boolean;
	data_retention_days?: number | null;
	score_retention_days?: number | null;
	max_trace_count?: number | null;
};

export type RetentionPreview = {
	traces: number;
	spans: number;
	scores: number;
	session_events: number;
	insight_reports: number;
};

export type RetentionStats = {
	retention_enabled: boolean;
	data_retention_days: number | null;
	score_retention_days: number | null;
	total_traces: number;
	oldest_trace_age_days: number;
	traces_expiring_7d: number;
	next_purge_approx: string | null;
};

export type RetentionWarnings = {
	warnings: {
		agent_id: string;
		agent_name: string;
		traces_expiring_soon: number;
		last_insight_report: string | null;
	}[];
	retention_days: number | null;
	retention_enabled: boolean;
};

// ── Config ─────────────────────────────────────────────────────────
export type PublicConfig = {
	licensed: boolean;
	licensed_features: string[];
	auth?: Record<string, boolean>;
	/** False when the identity service did not answer the capability probe. */
	auth_available?: boolean;
	sso_enabled: boolean;
	google_sso_enabled: boolean;
	github_sso_enabled: boolean;
	sso_only: boolean;
	self_registration_enabled: boolean;
	saml_enabled: boolean;
	dev_login_enabled?: boolean;
	exec_dashboard_available: boolean;
	enabled_features: string[];
	branding_logo: string | null;
	branding_app_name: string | null;
	branding_wordmark: string | null;
	/** Whether the deployment addresses organizations as subdomains ({org}.{base}). */
	org_subdomains?: boolean;
};

export type VersionConfig = {
	server_version: string;
	max_cli_version: string | null;
	api_version: string | null;
	frontend_version: string;
	recommended_cli_version: string;
};

export interface HarnessEntry {
	name: string;
	display_name: string;
	capabilities: string[];
	supported_models: string[];
}

interface HarnessesResponse {
	harnesses: HarnessEntry[];
	default_harness?: string | null;
}

export type HealthCheck = {
	name: string;
	label: string;
	status: "pass" | "fail" | "skip";
	message?: string;
	hint?: string;
};

export type SsoProbeResult = {
	ok: boolean;
	latency_ms?: number;
	error?: string;
	checks?: HealthCheck[];
};

export type SsoHealthResult = {
	identity_service: { ok: boolean; latency_ms: number; error: string | null };
	capabilities: Record<string, boolean>;
};

export const config = {
	public: () => get<PublicConfig>("/config/public"),
	version: () => get<VersionConfig>("/config/version"),
	harnesses: () => get<HarnessesResponse>("/config/harnesses"),
	ssoHealth: () => get<SsoHealthResult>("/config/sso-health"),
};

// ── Bulk ───────────────────────────────────────────────────────────
export const bulk = {
	createAgents: (body: { agents: unknown[]; dry_run?: boolean }) =>
		post<BulkResult>("/bulk/agents", body),
};

// ── Insights ───────────────────────────────────────────────────────
export const recommendations = {
	me: (limit = 8, type?: string) =>
		get<RecommendationsResponse>(
			`/recommendations/me?limit=${limit}${type ? `&type=${encodeURIComponent(type)}` : ""}`,
		),
	feedback: (componentType: string, componentId: string, action: string) =>
		post<void>("/recommendations/feedback", {
			component_type: componentType,
			component_id: componentId,
			action,
		}),
};

// ── Inbox ──────────────────────────────────────────────────────────
function inboxQuery(filters: InboxFilters = {}): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(filters)) {
		if (value !== undefined && value !== null && value !== "") {
			params.set(key, String(value));
		}
	}
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

export const inbox = {
	list: (filters: InboxFilters = {}) =>
		get<InboxListResponse>(`/inbox${inboxQuery(filters)}`),
	// Facets are opt-in: the nav badge polls this every minute for one number
	// and should not pay for the sidebar's per-kind breakdown.
	counts: (opts: { facets?: boolean; facetState?: InboxState } = {}) =>
		get<InboxCounts>(
			`/inbox/count${
				opts.facets
					? `?facets=true${opts.facetState ? `&facet_state=${opts.facetState}` : ""}`
					: ""
			}`,
		),
	detail: (id: string) => get<InboxItemDetail>(`/inbox/${id}`),
	read: (id: string) => post<InboxItem>(`/inbox/${id}/read`),
	unread: (id: string) => post<InboxItem>(`/inbox/${id}/unread`),
	done: (id: string) => post<InboxItem>(`/inbox/${id}/done`),
	dismiss: (id: string) => post<InboxItem>(`/inbox/${id}/dismiss`),
	reopen: (id: string) => post<InboxItem>(`/inbox/${id}/reopen`),
	// Filter-scoped on purpose: a blanket read-all over an actionable feed
	// clears the unread signal on work nobody has looked at.
	readAll: (filters: InboxFilters = {}) =>
		post<{ updated: number }>(`/inbox/read-all${inboxQuery(filters)}`),
};

export const insights = {
	status: () => get<{ available: boolean; reason: string | null }>("/insights/status"),
	sessionCount: (agentId: string, agentVersion?: string) =>
		get<{ session_count: number; agent_version?: string; agent_version_id?: string }>(
			`/agents/${agentId}/insights/session-count${agentVersion ? `?agent_version=${encodeURIComponent(agentVersion)}` : ""}`,
		),
	generate: (agentId: string, periodDays?: number, agentVersion?: string, comparisonAgentVersion?: string) =>
		post<InsightReportListItem>(`/agents/${agentId}/insights/reports`, {
			...(periodDays ? { period_days: periodDays } : {}),
			...(agentVersion ? { agent_version: agentVersion } : {}),
			...(comparisonAgentVersion ? { comparison_agent_version: comparisonAgentVersion } : {}),
		}),
	listReports: (agentId: string) =>
		get<InsightReportListItem[]>(`/agents/${agentId}/insights/reports`),
	getReport: (agentId: string, reportId: string) =>
		get<InsightReport>(`/agents/${agentId}/insights/reports/${reportId}`),
	applySuggestions: (agentId: string, reportId: string, selection?: { config_indices?: number[]; feature_indices?: number[]; pattern_indices?: number[] }) =>
		post<{ applied: boolean; report_id: string; items: InsightAppliedItems }>(
			`/agents/${agentId}/insights/reports/${reportId}/apply`,
			selection ?? {},
		),
	exportHtml: async (agentId: string, reportId: string): Promise<void> => {
		let token = await ensureAccessToken();
		let res = await fetch(`${API}/agents/${agentId}/insights/reports/${reportId}/export/html`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		if (res.status === 401) {
			token = hasActiveAuthContext("tenant") ? await ensureAccessToken("tenant", true) : null;
			if (token) {
				res = await fetch(`${API}/agents/${agentId}/insights/reports/${reportId}/export/html`, {
					headers: { Authorization: `Bearer ${token}` },
				});
			}
		}
		if (!res.ok) throw new Error("Export failed");
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `insight-report-${reportId.slice(0, 8)}.html`;
		a.click();
		URL.revokeObjectURL(url);
	},
};

// ── Exec Dashboard ─────────────────────────────────────────────────
export const exec = {
	adoption: () => get<ExecAdoptionResponse>("/exec/adoption"),
	agentCounts: () => get<ExecAgentCounts>("/exec/agent-counts"),
	usageByCategory: (range?: string) =>
		get<ExecUsageByCategory[]>(
			`/exec/usage-by-category${range ? `?range=${range}` : ""}`,
		),
	platformCoverage: () =>
		get<ExecPlatformCoverage[]>("/exec/platform-coverage"),
	platforms: () => get<ExecPlatformScore[]>("/exec/platforms"),
	velocity: () => get<ExecVelocityResponse>("/exec/velocity"),
	topAgents: (limit?: number) =>
		get<ExecTopAgent[]>(`/exec/top-agents${limit ? `?limit=${limit}` : ""}`),
	departments: (range?: string) =>
		get<ExecDepartmentsResponse>(
			`/exec/departments${range ? `?range=${range}` : ""}`,
		),
	deptTokens: (range?: string) =>
		get<ExecDeptTokenItem[]>(
			`/exec/dept-tokens${range ? `?range=${range}` : ""}`,
		),
	costSummary: (range?: string) =>
		get<ExecCostSummary>(`/exec/cost-summary${range ? `?range=${range}` : ""}`),
	roiProjections: () =>
		get<ExecROIProjectionsResponse>("/exec/roi-projections"),
	strategicInsights: () =>
		get<ExecStrategicInsightsResponse>("/exec/strategic-insights"),
	developerBreakdown: (limit?: number) =>
		get<ExecDeveloperBreakdown>(
			`/exec/developer-breakdown${limit ? `?limit=${limit}` : ""}`,
		),
	inactivityAlerts: () => get<ExecInactivityAlerts>("/exec/inactivity-alerts"),
	timeToValue: () => get<ExecTimeToValueResponse>("/exec/time-to-value"),
	aiInsights: () => get<ExecAIInsightsResponse>("/exec/ai-insights"),
	generateAiInsights: () => post<ExecAIInsightsResponse>("/exec/ai-insights"),
	config: () => get<ExecConfig | null>("/exec/config"),
	updateConfig: (data: Partial<ExecConfig>) =>
		put<ExecConfig>("/exec/config", data),
};

// ── Unified project resources ──────────────────────────────────────
export interface ProjectResourcesQuery {
	type?: string;
	search?: string;
	mine?: boolean;
	include_unpublished?: boolean;
	scope?: string;
	status?: string;
	owner?: string;
	updated_after?: string;
	created_after?: string;
	sort?: string;
	page?: number;
	page_size?: number;
}

export const projectResources = {
	list: (params?: ProjectResourcesQuery) => {
		const qs = new URLSearchParams();
		if (params?.type) qs.set("type", params.type);
		if (params?.search) qs.set("search", params.search);
		if (params?.mine) qs.set("mine", "true");
		if (params?.include_unpublished) qs.set("include_unpublished", "true");
		if (params?.scope) qs.set("scope", params.scope);
		if (params?.status) qs.set("status", params.status);
		if (params?.owner) qs.set("owner", params.owner);
		if (params?.updated_after) qs.set("updated_after", params.updated_after);
		if (params?.created_after) qs.set("created_after", params.created_after);
		if (params?.sort) qs.set("sort", params.sort);
		if (params?.page && params.page > 1) qs.set("page", String(params.page));
		if (params?.page_size) qs.set("page_size", String(params.page_size));
		const suffix = qs.size ? `?${qs}` : "";
		return get<ProjectResourcesResponse>(`/resources${suffix}`);
	},
};

// ── Health ──────────────────────────────────────────────────────────
export const health = () => fetch("/health").then((r) => r.json());
