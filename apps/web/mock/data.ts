// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Static fixtures for the dev-only mock API (see plugin.ts). Shapes are
// typechecked against the real frontend types so drift shows up in `tsc`.

import type {
	RegistryItem,
	AdminUser,
	AdminSetting,
	AdminSettingSection,
	OverviewStats,
	TopItem,
	TopAgentItem,
	TrendPoint,
	TokenStats,
	HarnessUsageData,
	Session,
	SessionData,
	SessionsStats,
	SessionsSummary,
	SessionErrorEvent,
	RawSessionEvent,
	TelemetryStatus,
	ReviewItem,
	InboxItem,
	InboxCounts,
	Organization,
	OrgMember,
	Project,
	ProjectMember,
	ProjectResources,
	RecommendationsResponse,
	AgentVersionsResponse,
	AgentVersionDetail,
	ComponentVersionsResponse,
	ComponentVersionDetail,
	VersionSuggestions,
	AuditLogEntry,
	SecurityEvent,
	SystemStatusResponse,
	ExecAdoptionResponse,
	ExecAgentCounts,
	ExecUsageByCategory,
	ExecPlatformCoverage,
	ExecPlatformScore,
	ExecVelocityResponse,
	ExecTopAgent,
	ExecDepartmentsResponse,
	ExecDeptTokenItem,
	ExecCostSummary,
	ExecROIProjectionsResponse,
	ExecStrategicInsightsResponse,
	ExecDeveloperBreakdown,
	ExecInactivityAlerts,
	ExecTimeToValueResponse,
	ExecAIInsightsResponse,
	ExecConfig,
	OrgInvitation,
	Permission,
	ResourceRetentionPolicy,
} from "../src/lib/types";
import type { PublicConfig, HarnessEntry, RegistryType, RetentionWarnings } from "../src/lib/api";

// ── Time helpers ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(days: number, offsetMinutes = 0): string {
	return new Date(Date.now() - days * DAY_MS + offsetMinutes * 60_000).toISOString();
}

function dateOnly(daysBack: number): string {
	return new Date(Date.now() - daysBack * DAY_MS).toISOString().slice(0, 10);
}

// ── Users / auth ────────────────────────────────────────────────────

export const MOCK_USER = {
	id: "u0000000-0000-4000-8000-000000000001",
	email: "dev@caracal.run",
	username: "dev",
	name: "Dev User",
	// operator so every settings surface (including instance scope) is
	// reachable in backend-free development.
	role: "operator",
	avatar_url: null as string | null,
	created_at: daysAgo(120),
};

export const MOCK_USERS: AdminUser[] = [
	{ ...MOCK_USER, department: "Platform" },
	{
		id: "u0000000-0000-4000-8000-000000000002",
		email: "richard@caracal.run",
		username: "richard",
		name: "Richard Hendricks",
		role: "user",
		department: "Backend",
		created_at: daysAgo(90),
	},
	{
		id: "u0000000-0000-4000-8000-000000000003",
		email: "jared@caracal.run",
		username: "jared",
		name: "Jared Dunn",
		role: "reviewer",
		department: "DX",
		created_at: daysAgo(60),
	},
];

export function mockJwt(context: "tenant" | "operator" = "tenant"): string {
	// Syntactically valid unsigned JWT so the app's expiry parsing works.
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const header = b64({ alg: "none", typ: "JWT" });
	const role = context === "operator" ? "operator" : MOCK_USER.role === "reviewer" ? "reviewer" : "user";
	const payload = b64({
		sub: MOCK_USER.id,
		email: MOCK_USER.email,
		role,
		auth_context: context,
		exp: Math.floor(Date.now() / 1000) + 12 * 3600,
	});
	return `${header}.${payload}.mock`;
}

// ── Config ──────────────────────────────────────────────────────────

export const MOCK_PUBLIC_CONFIG: PublicConfig = {
	licensed: true,
	licensed_features: ["all"],
	auth: { email_password: true, google: false, github: false, sso: false, passkeys: true, magic_links: false, dev_login: true },
	auth_available: true,
	sso_enabled: false,
	google_sso_enabled: false,
	github_sso_enabled: false,
	sso_only: false,
	self_registration_enabled: true,
	saml_enabled: false,
	dev_login_enabled: true,
	exec_dashboard_available: true,
	enabled_features: [],
	branding_logo: null,
	branding_app_name: null,
	branding_wordmark: null,
};

export const GENERIC_MODELS = [
	"claude-sonnet-4-5",
	"claude-opus-4-1",
	"gpt-5",
	"gemini-2.5-pro",
];

// Used when packages/harness-data/registry.json cannot be read.
export const FALLBACK_HARNESSES: HarnessEntry[] = [
	{ name: "claude-code", display_name: "Claude Code", capabilities: ["hooks", "mcp_servers", "skills"], supported_models: GENERIC_MODELS, skill_support: "native", skill_mechanism: "agent_skill", hook_support: "native", hook_mechanism: "settings_json", agent_support: "native", agent_mechanism: "subagent_markdown", agent_multi: true },
	{ name: "kiro", display_name: "Kiro", capabilities: ["hooks", "mcp_servers", "skills"], supported_models: GENERIC_MODELS, skill_support: "native", skill_mechanism: "agent_skill", hook_support: "native", hook_mechanism: "agent_profile_json", agent_support: "native", agent_mechanism: "agent_json", agent_multi: true },
	{ name: "copilot", display_name: "Copilot", capabilities: ["hooks", "mcp_servers", "skills", "prompts"], supported_models: GENERIC_MODELS, skill_support: "native", skill_mechanism: "agent_skill", hook_support: "native", hook_mechanism: "command_json", agent_support: "native", agent_mechanism: "vscode_custom_agent", agent_multi: true },
];

// ── Registry ────────────────────────────────────────────────────────

const NAMESPACE = "caracal";

function registryBase(
	n: number,
	type: string,
	name: string,
	slug: string,
	description: string,
	extra: Record<string, unknown> = {},
): RegistryItem {
	return {
		id: `${type.slice(0, 1)}0000000-0000-4000-8000-00000000000${n}`,
		name,
		namespace: NAMESPACE,
		slug,
		qualified_name: `${NAMESPACE}/${slug}`,
		visibility: "project",
		is_private: true,
		description,
		status: "approved",
		version: "1.2.0",
		latest_version: "1.2.0",
		download_count: 40 + n * 17,
		owner: MOCK_USER.email,
		created_by_username: MOCK_USER.username,
		created_at: daysAgo(30 + n),
		updated_at: daysAgo(n),
		...extra,
	};
}

export const MOCK_REGISTRY: Record<RegistryType, RegistryItem[]> = {
	agents: [
		registryBase(1, "agents", "code-reviewer", "code-reviewer", "Reviews pull requests with security and style checks.", {
			component_count: 3,
			supported_harnesses: ["claude-code", "copilot", "kiro"],
			model_name: "claude-sonnet-4-5",
			components: [
				{ component_type: "mcp", component_id: "m0000000-0000-4000-8000-000000000001", name: "github-mcp" },
				{ component_type: "skill", component_id: "s0000000-0000-4000-8000-000000000001", name: "review-checklist" },
				{ component_type: "hook", component_id: "h0000000-0000-4000-8000-000000000001", name: "session-push" },
			],
			prompt: "You are a meticulous code reviewer.",
		}),
		registryBase(2, "agents", "docs-writer", "docs-writer", "Drafts and maintains project documentation from code changes.", {
			component_count: 2,
			supported_harnesses: ["claude-code", "opencode"],
			model_name: "gpt-5",
			components: [
				{ component_type: "mcp", component_id: "m0000000-0000-4000-8000-000000000002", name: "filesystem-mcp" },
				{ component_type: "prompt", component_id: "p0000000-0000-4000-8000-000000000001", name: "docs-style" },
			],
			prompt: "You write concise, accurate documentation.",
		}),
		registryBase(3, "agents", "test-runner", "test-runner", "Runs, triages, and fixes failing test suites autonomously.", {
			component_count: 2,
			supported_harnesses: ["kiro", "goose"],
			model_name: "claude-opus-4-1",
			components: [
				{ component_type: "mcp", component_id: "m0000000-0000-4000-8000-000000000003", name: "pytest-mcp" },
			],
			prompt: "You keep the test suite green.",
		}),
	],
	mcps: [
		registryBase(1, "mcps", "github-mcp", "github-mcp", "GitHub issues, PRs, and repo browsing over MCP.", {
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
		}),
		registryBase(2, "mcps", "filesystem-mcp", "filesystem-mcp", "Scoped filesystem access for agents.", {
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem"],
		}),
		registryBase(3, "mcps", "pytest-mcp", "pytest-mcp", "Run pytest suites and stream results.", {
			transport: "stdio",
			command: "uvx",
			args: ["pytest-mcp"],
		}),
	],
	skills: [
		registryBase(1, "skills", "review-checklist", "review-checklist", "Security and style checklist for PR review.", {
			task_type: "review",
			skill_md_content: "# Review checklist\n\n- Check auth boundaries\n- Check error handling\n",
		}),
		registryBase(2, "skills", "commit-hygiene", "commit-hygiene", "Conventional commit rules and message drafting.", {
			task_type: "git",
			skill_md_content: "# Commit hygiene\n\nUse conventional commits.\n",
		}),
	],
	hooks: [
		registryBase(1, "hooks", "session-push", "session-push", "Pushes session telemetry after each turn.", {
			event: "stop",
			execution_mode: "async",
			handler_type: "script",
		}),
		registryBase(2, "hooks", "secret-guard", "secret-guard", "Blocks tool calls that would read secret files.", {
			event: "pretooluse",
			execution_mode: "sync",
			handler_type: "script",
		}),
	],
	prompts: [
		registryBase(1, "prompts", "docs-style", "docs-style", "House style for generated documentation.", {
			category: "writing",
			template: "Write documentation in the {{tone}} tone.",
			variables: [{ name: "tone", default: "concise" }],
		}),
		registryBase(2, "prompts", "bug-triage", "bug-triage", "Structured triage template for incoming bug reports.", {
			category: "triage",
			template: "Triage the following bug: {{report}}",
			variables: [{ name: "report" }],
		}),
	],
};

export const MOCK_DELETED_AGENTS: RegistryItem[] = [
	{
		...registryBase(8, "agents", "incident-summarizer", "incident-summarizer", "Summarizes operational incident threads."),
		id: "a0000000-0000-4000-8000-000000000008",
		project_id: "p0000000-0000-4000-8000-000000000001",
		visibility: "project",
		is_private: true,
		status: "deleted",
		deleted_at: daysAgo(3),
		scheduled_purge_at: daysAgo(-27),
	},
	{
		...registryBase(9, "agents", "private-refactorer", "private-refactorer", "Personal refactoring assistant."),
		id: "a0000000-0000-4000-8000-000000000009",
		project_id: "p0000000-0000-4000-8000-000000000001",
		visibility: "private",
		is_private: true,
		status: "deleted",
		deleted_at: daysAgo(8),
		scheduled_purge_at: daysAgo(-22),
	},
];

export const MOCK_RESOURCE_RETENTION_POLICIES: Record<string, ResourceRetentionPolicy> = {
	platform: {
		private_retention_days: 30,
		project_retention_days: 30,
		bounds: { private: { min_days: 0, max_days: 90 }, project: { min_days: 7, max_days: 180 } },
		can_update: true,
	},
};

// The agent detail page reads `component_links`; resolve/manifest read `components`.
for (const agent of MOCK_REGISTRY.agents) {
	agent.component_links = agent.components;
}

export function findRegistryItem(type: RegistryType, idOrSlug: string): RegistryItem | undefined {
	return MOCK_REGISTRY[type].find(
		(item) => item.id === idOrSlug || item.slug === idOrSlug || item.qualified_name === idOrSlug,
	);
}

export const MOCK_VERSION_SUGGESTIONS: VersionSuggestions = {
	current: "1.2.0",
	suggestions: { patch: "1.2.1", minor: "1.3.0", major: "2.0.0" },
};

export function mockAgentVersions(agentId: string): AgentVersionsResponse {
	return {
		items: [
			{
				id: `${agentId}-v2`,
				agent_id: agentId,
				version: "1.2.0",
				description: "Adds harness capability gating.",
				status: "approved",
				is_prerelease: false,
				download_count: 52,
				supported_harnesses: ["claude-code", "copilot"],
				released_by: MOCK_USER.email,
				released_at: daysAgo(5),
				created_at: daysAgo(5),
				rejection_reason: null,
				component_count: 3,
			},
			{
				id: `${agentId}-v1`,
				agent_id: agentId,
				version: "1.1.0",
				description: "Initial public release.",
				status: "approved",
				is_prerelease: false,
				download_count: 31,
				supported_harnesses: ["claude-code"],
				released_by: MOCK_USER.email,
				released_at: daysAgo(30),
				created_at: daysAgo(30),
				rejection_reason: null,
				component_count: 2,
			},
		],
		total: 2,
		page: 1,
		page_size: 20,
	};
}

export function mockAgentVersionDetail(agentId: string, version: string): AgentVersionDetail {
	const agent = MOCK_REGISTRY.agents.find((a) => a.id === agentId) ?? MOCK_REGISTRY.agents[0];
	return {
		id: `${agentId}-${version}`,
		agent_id: agentId,
		version,
		description: agent.description ?? "",
		status: "approved",
		is_prerelease: false,
		download_count: 52,
		supported_harnesses: (agent.supported_harnesses as string[] | undefined) ?? ["claude-code"],
		released_by: MOCK_USER.email,
		released_at: daysAgo(5),
		created_at: daysAgo(5),
		rejection_reason: null,
		component_count: (agent.component_count as number | undefined) ?? 0,
		prompt: (agent.prompt as string | undefined) ?? "You are a helpful agent.",
		model_name: (agent.model_name as string | undefined) ?? "claude-sonnet-4-5",
		components: (agent.components as AgentVersionDetail["components"] | undefined) ?? [],
		success_criteria: null,
	};
}

export function mockComponentVersionDetail(listingId: string, version: string): ComponentVersionDetail {
	return {
		id: `${listingId}-${version}`,
		listing_id: listingId,
		version,
		description: "Current release.",
		changelog: "Improved error handling.",
		status: "approved",
		rejection_reason: null,
		download_count: 44,
		supported_harnesses: ["claude-code", "copilot"],
		released_by: MOCK_USER.email,
		released_at: daysAgo(5),
		created_at: daysAgo(5),
	};
}

export function mockComponentVersions(listingId: string): ComponentVersionsResponse {
	return {
		items: [
			{
				id: `${listingId}-v1`,
				listing_id: listingId,
				version: "1.2.0",
				description: "Current release.",
				changelog: "Improved error handling.",
				status: "approved",
				rejection_reason: null,
				download_count: 44,
				supported_harnesses: ["claude-code", "copilot"],
				released_by: MOCK_USER.email,
				released_at: daysAgo(5),
				created_at: daysAgo(5),
			},
		],
		total: 1,
		page: 1,
		page_size: 20,
	};
}

// ── Overview / dashboard ────────────────────────────────────────────

export const MOCK_OVERVIEW_STATS: OverviewStats = {
	total_mcps: 3,
	total_agents: 3,
	total_users: 3,
	total_tool_calls: 12842,
	total_agent_interactions: 3121,
};

export function mockTrends(days = 30): TrendPoint[] {
	return Array.from({ length: days }, (_, i) => {
		const back = days - 1 - i;
		return {
			date: dateOnly(back),
			submissions: Math.max(0, Math.round(6 + 4 * Math.sin(i / 3) + (i % 5))),
			users: Math.max(1, Math.round(3 + 2 * Math.cos(i / 4) + (i % 3))),
		};
	});
}

export const MOCK_TOP_MCPS: TopItem[] = [
	{ id: MOCK_REGISTRY.mcps[0].id, name: "github-mcp", value: 412 },
	{ id: MOCK_REGISTRY.mcps[1].id, name: "filesystem-mcp", value: 260 },
	{ id: MOCK_REGISTRY.mcps[2].id, name: "pytest-mcp", value: 187 },
];

export const MOCK_TOP_AGENTS: TopAgentItem[] = MOCK_REGISTRY.agents.map((agent, i) => ({
	id: agent.id,
	name: agent.name,
	namespace: agent.namespace,
	slug: agent.slug,
	qualified_name: agent.qualified_name,
	description: agent.description ?? "",
	owner: MOCK_USER.email,
	created_by_username: MOCK_USER.username,
	version: "1.2.0",
	download_count: 90 - i * 20,
}));

export function mockIntelligenceResources() {
	return {
		range: "7d",
		generated_at: new Date().toISOString(),
		sources: [
			{ name: "telemetry", status: "fresh", message: null, updated_at: new Date().toISOString() },
			{ name: "registry", status: "fresh", message: null, updated_at: new Date().toISOString() },
			{ name: "cost", status: "fresh", message: null, updated_at: new Date().toISOString() },
		],
		cost_restricted: false,
		rows: MOCK_TOP_AGENTS.slice(0, 4).map((agent, index) => ({
			agent_id: agent.id,
			name: agent.name,
			qualified_name: agent.qualified_name,
			owner: agent.owner,
			version: agent.version,
			status: "approved",
			sessions: 26 - index * 8,
			previous_sessions: [15, 27, 4][index] ?? 0,
			change_pct: [73.3, -33.3, 150][index] ?? null,
			tool_calls: 140 - index * 42,
			tool_completion_pct: [68.5, 96.2, 92.4][index] ?? null,
			tokens: 45_000 - index * 11_000,
			credits: Math.round((6.8 - index * 1.9) * 100) / 100,
			credits_per_session: Math.round(((6.8 - index * 1.9) / Math.max(1, 26 - index * 8)) * 10_000) / 10_000,
			downloads: 14 - index * 4,
			previous_downloads: 8 - index * 2,
			open_issues: index === 0 ? 4 : 0,
			resolved_issues: 3 - index,
			last_used: new Date(Date.now() - index * 86_400_000).toISOString(),
			updated_at: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
			attention_reasons: index === 0 ? ["open review issues", "low tool completion"] : index === 1 ? ["declining usage"] : [],
		})),
		total: MOCK_TOP_AGENTS.length,
		page: 1,
		page_size: 25,
	};
}

export function mockIntelligenceBriefing() {
	const resources = mockIntelligenceResources().rows;
	const generatedAt = new Date().toISOString();
	const activity = Array.from({ length: 7 }, (_, index) => ({
		date: new Date(Date.now() - (6 - index) * 86_400_000).toISOString().slice(0, 10),
		sessions: [6, 8, 7, 11, 9, 12, 15][index],
		active_users: [2, 3, 2, 4, 3, 4, 5][index],
		tool_calls: 40 + index * 13,
		tokens: 12_000 + index * 1_800,
		credits: Math.round((1.2 + index * 0.4) * 100) / 100,
	}));
	return {
		range: "7d",
		comparison: "previous_7d",
		generated_at: generatedAt,
		sources: [
			{ name: "telemetry", status: "fresh", message: null, updated_at: generatedAt },
			{ name: "registry", status: "fresh", message: null, updated_at: generatedAt },
			{ name: "cost", status: "fresh", message: null, updated_at: generatedAt },
			{ name: "ownership", status: "fresh", message: null, updated_at: generatedAt },
		],
		has_data: true,
		metrics: [
			{ key: "sessions", label: "Sessions", value: 58, previous: 41, change_pct: 41.5, unit: "sessions", restricted: false },
			{ key: "active_users", label: "Active users", value: 5, previous: 4, change_pct: 25, unit: "users", restricted: false },
			{ key: "tool_calls", label: "Tool calls", value: 342, previous: 265, change_pct: 29.1, unit: "calls", restricted: false },
			{ key: "tool_completion", label: "Tool completion", value: 88.4, previous: 94.1, change_pct: -5.7, unit: "%", restricted: false },
			{ key: "credits", label: "Cost", value: 18.42, previous: 12.1, change_pct: 52.2, unit: "credits", restricted: false },
			{ key: "downloads", label: "Installs", value: 30, previous: 18, change_pct: 66.7, unit: "installs", restricted: false },
		],
		activity,
		adoption: {
			active_users: 5,
			new_users: 2,
			returning_users: 3,
			top_resource_share_pct: 48.1,
			attributed_sessions: 54,
		},
		ownership: [
			{ user_id: MOCK_USERS[0].id, name: MOCK_USERS[0].name ?? MOCK_USERS[0].email, role: "lead", department: "Platform", resources_owned: 2, changes_submitted: 4, issues_opened: 1, issues_resolved: 3 },
			{ user_id: MOCK_USERS[1].id, name: MOCK_USERS[1].name ?? MOCK_USERS[1].email, role: "user", department: "Developer Experience", resources_owned: 1, changes_submitted: 2, issues_opened: 2, issues_resolved: 1 },
		],
		signals: [
			{
				id: `attention:${resources[0]?.agent_id}`,
				kind: "resource_attention",
				classification: "anomaly",
				severity: "critical",
				title: `${resources[0]?.name ?? "Code reviewer"} needs attention`,
				explanation: "open review issues, low tool completion.",
				impact: "This is the most-used resource in the project, so unresolved reliability signals have a wide blast radius.",
				agent_id: resources[0]?.agent_id ?? null,
				qualified_name: resources[0]?.qualified_name ?? null,
				evidence: [{ label: "Sessions", value: 26, unit: "sessions" }, { label: "Open issues", value: 4, unit: "issues" }, { label: "Tool completion", value: 68.5, unit: "%" }],
				actions: [{ kind: "investigate_resource", label: "Investigate resource" }, { kind: "open_resource", label: "Open resource" }],
			},
			{
				id: "cost-divergence",
				kind: "cost_divergence",
				classification: "anomaly",
				severity: "warning",
				title: "Cost rose 52.2% faster than usage",
				explanation: "Credits grew materially faster than session volume.",
				impact: "The project is spending more per unit of activity and should inspect its largest cost drivers.",
				agent_id: null,
				qualified_name: null,
				evidence: [{ label: "Cost change", value: 52.2, unit: "%" }, { label: "Session change", value: 41.5, unit: "%" }],
				actions: [{ kind: "inspect_cost", label: "Inspect cost drivers" }],
			},
			{
				id: `attention:${resources[1]?.agent_id}`,
				kind: "resource_attention",
				classification: "anomaly",
				severity: "warning",
				title: `${resources[1]?.name ?? "Docs writer"} usage declined 33.3%`,
				explanation: "Current sessions are below the previous equal-length period.",
				impact: "Declining adoption after recent changes can indicate a workflow regression or loss of relevance.",
				agent_id: resources[1]?.agent_id ?? null,
				qualified_name: resources[1]?.qualified_name ?? null,
				evidence: [{ label: "Current sessions", value: 18, unit: "sessions" }, { label: "Previous sessions", value: 27, unit: "sessions" }],
				actions: [{ kind: "investigate_resource", label: "Investigate resource" }],
			},
			{
				id: "usage-shift",
				kind: "usage_shift",
				classification: "fact",
				severity: "info",
				title: "Project usage increased 41.5%",
				explanation: "Sessions are compared with the immediately preceding seven-day period.",
				impact: "More project activity is flowing through the agent estate.",
				agent_id: null,
				qualified_name: null,
				evidence: [{ label: "Current sessions", value: 58, unit: "sessions" }, { label: "Previous sessions", value: 41, unit: "sessions" }],
				actions: [{ kind: "open_history", label: "Review the change over time" }],
			},
			{
				id: "ownership-concentration",
				kind: "ownership_concentration",
				classification: "interpretation",
				severity: "warning",
				title: "One maintainer owns all active resources",
				explanation: "Maintainer concentration is calculated from current resource ownership.",
				impact: "A concentrated maintenance surface increases continuity and review bottleneck risk.",
				agent_id: null,
				qualified_name: null,
				evidence: [{ label: "Resources owned", value: resources.length, unit: "resources" }, { label: "Project resources", value: resources.length, unit: "resources" }],
				actions: [{ kind: "inspect_ownership", label: "Review ownership" }],
			},
		],
		resource_highlights: resources,
	};
}

export function mockIntelligenceHistory() {
	const resources = mockIntelligenceResources().rows;
	const generatedAt = new Date().toISOString();
	return {
		range: "7d",
		generated_at: generatedAt,
		sources: [
			{ name: "registry", status: "fresh", message: null, updated_at: generatedAt },
			{ name: "telemetry", status: "fresh", message: null, updated_at: generatedAt },
		],
		events: [
			{ id: "issue:1", occurred_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), kind: "issue_opened", category: "quality", classification: "fact", severity: "warning", title: `${resources[0]?.name} received a review issue`, detail: "Tool responses became inconsistent after the latest change.", agent_id: resources[0]?.agent_id ?? null, qualified_name: resources[0]?.qualified_name ?? null, version_id: null, version: resources[0]?.version ?? null, issue_id: "issue-1", evidence: [{ label: "Issue", value: "Inconsistent tool results", unit: "" }] },
			{ id: "usage:today", occurred_at: new Date(Date.now() - 8 * 3_600_000).toISOString(), kind: "usage_shift", category: "usage", classification: "fact", severity: "info", title: "Project usage increased 36%", detail: "Daily sessions compared with the previous day.", agent_id: null, qualified_name: null, version_id: null, version: null, issue_id: null, evidence: [{ label: "Sessions", value: 15, unit: "sessions" }, { label: "Previous day", value: 11, unit: "sessions" }] },
			{ id: "version:1", occurred_at: new Date(Date.now() - 30 * 3_600_000).toISOString(), kind: "version_released", category: "change", classification: "fact", severity: "info", title: `${resources[1]?.name} released ${resources[1]?.version}`, detail: "The reviewed version became the active release.", agent_id: resources[1]?.agent_id ?? null, qualified_name: resources[1]?.qualified_name ?? null, version_id: "version-1", version: resources[1]?.version ?? null, issue_id: null, evidence: [{ label: "Version", value: resources[1]?.version ?? "1.2.0", unit: "" }] },
			{ id: "cost:1", occurred_at: new Date(Date.now() - 52 * 3_600_000).toISOString(), kind: "cost_shift", category: "cost", classification: "fact", severity: "warning", title: "Project cost increased 44%", detail: "Daily credits compared with the previous day.", agent_id: null, qualified_name: null, version_id: null, version: null, issue_id: null, evidence: [{ label: "Credits", value: 4.2, unit: "credits" }] },
		],
		total: 4,
		page: 1,
		page_size: 30,
		has_more: false,
	};
}

export function mockIntelligenceCompare(a: string, b: string) {
	const resourceData = mockIntelligenceResources();
	const rows = resourceData.rows;
	const side = (id: string, fallback: number) => rows.find((row) => row.agent_id === id) ?? rows[fallback];
	const sideA = side(a, 0);
	const sideB = side(b, 1);
	const pct = (x: number | null, y: number | null) => x === null || y === null || x === 0 ? null : Math.round(((y - x) / x) * 1000) / 10;
	return {
		range: "7d",
		generated_at: resourceData.generated_at,
		sources: resourceData.sources,
		a: sideA,
		b: sideB,
		deltas: {
			sessions_pct: pct(sideA.sessions, sideB.sessions),
			tool_calls_pct: pct(sideA.tool_calls, sideB.tool_calls),
			tokens_pct: pct(sideA.tokens, sideB.tokens),
			downloads_pct: pct(sideA.downloads, sideB.downloads),
			credits_pct: pct(sideA.credits, sideB.credits),
			tool_completion_delta:
				sideA.tool_completion_pct === null || sideB.tool_completion_pct === null
					? null
					: Math.round((sideB.tool_completion_pct - sideA.tool_completion_pct) * 10) / 10,
		},
	};
}

export function mockIntelligenceResourceVersions() {
	const generatedAt = new Date().toISOString();
	return {
		range: "7d",
		generated_at: generatedAt,
		sources: [
			{ name: "registry", status: "fresh", message: null, updated_at: generatedAt },
			{ name: "telemetry", status: "fresh", message: null, updated_at: generatedAt },
		],
		versions: [
			{ version: "1.2.0", status: "approved", released_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), sessions: 26, tool_calls: 140, tool_completion_pct: 68.5, tokens: 45_000, credits: 6.8 },
			{ version: "1.1.0", status: "approved", released_at: new Date(Date.now() - 25 * 86_400_000).toISOString(), sessions: 19, tool_calls: 92, tool_completion_pct: 94.6, tokens: 31_500, credits: 4.2 },
			{ version: "1.0.0", status: "approved", released_at: new Date(Date.now() - 60 * 86_400_000).toISOString(), sessions: 8, tool_calls: 37, tool_completion_pct: 91.9, tokens: 14_000, credits: 1.9 },
		],
	};
}

export const MOCK_TOKEN_STATS: TokenStats = {
	total_input: 1_842_000,
	total_output: 421_500,
	total_tokens: 2_263_500,
	avg_per_trace: 18_100,
	by_agent: [
		{ name: "code-reviewer", input: 920_000, output: 210_000, total: 1_130_000, traces: 61 },
		{ name: "docs-writer", input: 540_000, output: 130_500, total: 670_500, traces: 38 },
		{ name: "test-runner", input: 382_000, output: 81_000, total: 463_000, traces: 26 },
	],
	by_mcp: [
		{ name: "github-mcp", input: 610_000, output: 95_000, total: 705_000, traces: 52 },
		{ name: "filesystem-mcp", input: 420_000, output: 62_000, total: 482_000, traces: 44 },
	],
	over_time: Array.from({ length: 14 }, (_, i) => ({
		date: dateOnly(13 - i),
		input: 90_000 + (i % 4) * 22_000,
		output: 21_000 + (i % 3) * 6_000,
	})),
};

export const MOCK_HARNESS_USAGE: HarnessUsageData = {
	harnesses: [
		{ harness: "claude-code", traces: 84, avg_latency_ms: 1420, error_count: 3, error_rate: 0.036 },
		{ harness: "kiro", traces: 41, avg_latency_ms: 1710, error_count: 1, error_rate: 0.024 },
		{ harness: "copilot-cli", traces: 22, avg_latency_ms: 1220, error_count: 0, error_rate: 0 },
	],
};

// ── Sessions ────────────────────────────────────────────────────────

export const MOCK_SESSIONS: Session[] = [
	{
		session_id: "sess-mock-0001",
		first_event_time: daysAgo(0, -95),
		last_event_time: daysAgo(0, -12),
		is_active: false,
		prompt_count: 6,
		api_request_count: 18,
		tool_result_count: 24,
		total_input_tokens: 148_200,
		total_output_tokens: 31_400,
		model: "claude-sonnet-4-5",
		service_name: "claude-code",
		user_id: MOCK_USER.id,
		user_name: MOCK_USER.name,
		platform: "claude-code",
		agent_id: MOCK_REGISTRY.agents[0].id,
		agent_name: "code-reviewer",
		agent_version: "1.2.0",
	},
	{
		session_id: "sess-mock-0002",
		first_event_time: daysAgo(1),
		last_event_time: daysAgo(1, 42),
		is_active: false,
		prompt_count: 3,
		api_request_count: 9,
		tool_result_count: 11,
		total_input_tokens: 64_800,
		total_output_tokens: 12_900,
		model: "gpt-5",
		service_name: "kiro",
		user_id: MOCK_USERS[1].id,
		user_name: MOCK_USERS[1].name,
		platform: "kiro",
		agent_id: MOCK_REGISTRY.agents[2].id,
		agent_name: "test-runner",
		agent_version: "1.1.0",
	},
	{
		session_id: "sess-mock-0003",
		first_event_time: daysAgo(2),
		last_event_time: daysAgo(2, 18),
		is_active: false,
		prompt_count: 1,
		api_request_count: 4,
		tool_result_count: 5,
		total_input_tokens: 21_300,
		total_output_tokens: 4_100,
		model: "claude-sonnet-4-5",
		service_name: "copilot-cli",
		user_id: MOCK_USERS[2].id,
		user_name: MOCK_USERS[2].name,
		platform: "copilot-cli",
		agent_id: null,
		agent_name: null,
		agent_version: null,
	},
];

function sessionEvents(base: string): RawSessionEvent[] {
	const t0 = new Date(base).getTime();
	const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
	return [
		{ timestamp: at(0), event_name: "hook_sessionstart", body: "Session started", attributes: { harness: "claude-code" } },
		{ timestamp: at(1), event_name: "user_prompt", body: "Review the open PR for auth changes and flag anything risky." },
		{
			timestamp: at(2),
			event_name: "api_request",
			body: "assistant turn",
			attributes: { model: "claude-sonnet-4-5", input_tokens: "8200", output_tokens: "640", duration_ms: "2100" },
		},
		{
			timestamp: at(3),
			event_name: "tool_result",
			body: "Fetched PR #482 diff (14 files)",
			attributes: { tool_name: "github-mcp.get_pull_request", success: "true" },
		},
		{
			timestamp: at(4),
			event_name: "hook_posttoolusefailure",
			body: "github-mcp.list_reviews failed",
			attributes: { tool_name: "github-mcp.list_reviews", error: "403 rate limited: secondary quota exhausted" },
		},
		{
			timestamp: at(5),
			event_name: "hook_assistant_response",
			body: "The token refresh path skips the revocation check; flagging as a blocker.",
		},
		{ timestamp: at(6), event_name: "hook_stop", body: "Turn complete", attributes: { stop_reason: "end_turn" } },
	];
}

export function mockSessionData(sessionId: string): SessionData | undefined {
	const session = MOCK_SESSIONS.find((s) => s.session_id === sessionId);
	if (!session) return undefined;
	return {
		session_id: session.session_id,
		events: sessionEvents(session.first_event_time),
		traces: [],
		service_name: session.service_name,
		agent_id: session.agent_id,
		agent_name: session.agent_name,
		agent_version: session.agent_version,
		subagent_sessions: [],
		max_offset: 6,
	};
}

export const MOCK_SESSIONS_SUMMARY: SessionsSummary = {
	total_sessions: 148,
	today_sessions: 6,
};

export const MOCK_SESSIONS_STATS: SessionsStats = {
	total_sessions: 148,
	total_prompts: 512,
	total_api_requests: 1840,
	total_tool_calls: 2260,
	total_input_tokens: 9_420_000,
	total_output_tokens: 1_870_000,
	total_traces: 148,
	total_spans: 4102,
};

export const MOCK_SESSION_ERRORS: SessionErrorEvent[] = [
	{
		timestamp: daysAgo(0, -40),
		event_name: "hook_posttoolusefailure",
		body: "Tool failed",
		session_id: "sess-mock-0001",
		tool_name: "github-mcp.get_pull_request",
		error: "rate limited (403)",
		agent_id: MOCK_REGISTRY.agents[0].id,
		agent_type: "agent",
		tool_input: '{"pr": 482}',
		tool_response: "403 rate limit exceeded",
		stop_reason: "tool_error",
		user_id: MOCK_USER.id,
		user_name: MOCK_USER.name,
	},
];

export const MOCK_TELEMETRY_STATUS: TelemetryStatus = {
	clickhouse: true,
	traces_count: 148,
	spans_count: 4102,
	scores_count: 37,
};

// ── Review queue ────────────────────────────────────────────────────

export const MOCK_REVIEW_ITEMS: ReviewItem[] = [
	{
		id: "r0000000-0000-4000-8000-000000000001",
		name: "jira-mcp",
		description: "Jira issue management over MCP.",
		version: "0.9.0",
		type: "mcp",
		listing_type: "mcp",
		submitted_by: MOCK_USERS[1].email,
		submitted_at: daysAgo(1),
		status: "pending",
		transport: "stdio",
		command: "npx",
		args: ["-y", "jira-mcp"],
	},
	{
		id: "r0000000-0000-4000-8000-000000000002",
		name: "changelog-writer",
		description: "Skill for drafting changelog entries.",
		version: "1.0.0",
		type: "skill",
		listing_type: "skill",
		submitted_by: MOCK_USERS[2].email,
		submitted_at: daysAgo(2),
		status: "pending",
		skill_md_content: "# Changelog writer\n\nDraft entries from merged PRs.\n",
	},
];

// ── Inbox ───────────────────────────────────────────────────────────

export const MOCK_INBOX_ITEMS: InboxItem[] = [
	{
		id: "i0000000-0000-4000-8000-000000000001",
		kind: "review_requested",
		state: "open",
		read: false,
		read_at: null,
		action_required: true,
		title: "jira-mcp is waiting for review",
		body: "Submitted by richard@caracal.run",
		subject_type: "mcp",
		subject_id: MOCK_REVIEW_ITEMS[0].id ?? null,
		subject_namespace: NAMESPACE,
		subject_slug: "jira-mcp",
		action_url: `/components/${MOCK_REVIEW_ITEMS[0].id}?type=mcps&view=review`,
		action_command: null,
		actor_id: MOCK_USERS[1].id,
		project_id: null,
		payload: {},
		created_at: daysAgo(1),
		resolved_at: null,
	},
	{
		id: "i0000000-0000-4000-8000-000000000002",
		kind: "insight_ready",
		state: "open",
		read: true,
		read_at: daysAgo(0, -30),
		action_required: false,
		title: "New insight report for code-reviewer",
		body: "30-day report is ready to view.",
		subject_type: "agent",
		subject_id: MOCK_REGISTRY.agents[0].id,
		subject_namespace: NAMESPACE,
		subject_slug: "code-reviewer",
		action_url: null,
		action_command: null,
		actor_id: null,
		project_id: null,
		payload: {},
		created_at: daysAgo(0, -60),
		resolved_at: null,
	},
];

export const MOCK_INBOX_COUNTS: InboxCounts = {
	unread: 1,
	action_required: 1,
	open: 2,
	done: 0,
	dismissed: 0,
	by_kind: {},
	by_subject_type: {},
};

// ── Organizations & projects ────────────────────────────────────────

// Effective permissions mirror the server's tenancy resolver so mock-mode
// permission gating matches production; org owner/admin inherit project
// administration across the organization.
const ORG_ROLE_PERMISSIONS: Record<string, Permission[]> = {
	owner: [
		"org.view", "org.update", "org.delete", "org.ownership.transfer",
		"org.members.manage", "org.projects.manage", "org.audit.read", "org.security.read",
	],
	admin: [
		"org.view", "org.update", "org.members.manage", "org.projects.manage",
		"org.audit.read", "org.security.read",
	],
	member: ["org.view"],
};

const PROJECT_ROLE_PERMISSIONS: Record<string, Permission[]> = {
	lead: [
		"project.view", "project.update", "project.delete", "project.members.manage",
		"project.resources.read", "project.resources.write", "project.audit.read", "project.security.read",
	],
	user: ["project.view", "project.resources.read", "project.resources.write"],
};

const ORG_ADMIN_PROJECT_PERMISSIONS: Permission[] = [
	"project.view", "project.update", "project.delete", "project.members.manage",
	"project.resources.read", "project.resources.write", "project.audit.read", "project.security.read",
];

export function orgPermissions(role?: string | null): Permission[] {
	return ORG_ROLE_PERMISSIONS[role ?? ""] ?? [];
}

export function projectPermissions(orgRole?: string | null, projectRole?: string | null): Permission[] {
	if (orgPermissions(orgRole).includes("org.projects.manage")) return ORG_ADMIN_PROJECT_PERMISSIONS;
	return PROJECT_ROLE_PERMISSIONS[projectRole ?? ""] ?? [];
}

export const MOCK_ORGS: Organization[] = [
	{
		id: "o0000000-0000-4000-8000-000000000001",
		slug: "primary",
		name: "Primary",
		description: "Default organization for this deployment.",
		role: "owner",
		permissions: orgPermissions("owner"),
		member_count: MOCK_USERS.length,
		project_count: 2,
		created_at: daysAgo(100),
	},
	{
		id: "o0000000-0000-4000-8000-000000000002",
		slug: "acme",
		name: "Acme Inc",
		description: "Example second organization.",
		role: "member",
		permissions: orgPermissions("member"),
		member_count: 2,
		project_count: 1,
		created_at: daysAgo(30),
	},
];

export const MOCK_ORG_MEMBERS: Record<string, OrgMember[]> = {
	primary: MOCK_USERS.map((user, i) => ({
		id: user.id,
		email: user.email ?? "",
		username: user.username,
		name: user.name,
		role: (i === 0 ? "owner" : i === 1 ? "admin" : "member") as OrgMember["role"],
	})),
	acme: MOCK_USERS.slice(0, 2).map((user, i) => ({
		id: user.id,
		email: user.email ?? "",
		username: user.username,
		name: user.name,
		role: (i === 0 ? "owner" : "member") as OrgMember["role"],
	})),
};

export const MOCK_PROJECTS: Record<string, Project[]> = {
	primary: [
		{
			id: "p0000000-0000-4000-8000-000000000001",
			organization_id: "o0000000-0000-4000-8000-000000000001",
			slug: "platform",
			name: "Platform",
			description: "Platform engineering project.",
			is_default: true,
			role: "lead",
			permissions: projectPermissions("owner", "lead"),
			member_count: 3,
			created_at: daysAgo(100),
		},
		{
			id: "p0000000-0000-4000-8000-000000000002",
			organization_id: "o0000000-0000-4000-8000-000000000001",
			slug: "payments",
			name: "Payments",
			description: "Billing and payments agents.",
			role: "user",
			permissions: projectPermissions("owner", "user"),
			member_count: 2,
			created_at: daysAgo(20),
		},
	],
	acme: [
		{
			id: "p0000000-0000-4000-8000-000000000003",
			organization_id: "o0000000-0000-4000-8000-000000000002",
			slug: "research",
			name: "Research",
			description: null,
			is_default: true,
			role: null,
			permissions: projectPermissions("member", null),
			member_count: 1,
			created_at: daysAgo(10),
		},
	],
};

// Mutable onboarding state: the mock user starts fully onboarded so the app
// is reachable in backend-free development; flip profileCompleted to walk
// the onboarding stages.
export const MOCK_ONBOARDING = { profileCompleted: true };

export const MOCK_ORG_INVITATIONS: Record<string, OrgInvitation[]> = {
	primary: [],
	acme: [],
};

export const MOCK_PROJECT_MEMBERS: Record<string, ProjectMember[]> = {
	platform: MOCK_USERS.slice(0, 3).map((user, i) => ({
		id: user.id,
		email: user.email ?? "",
		username: user.username,
		name: user.name,
		role: (i === 0 ? "lead" : "user") as ProjectMember["role"],
	})),
	payments: MOCK_USERS.slice(0, 2).map((user, i) => ({
		id: user.id,
		email: user.email ?? "",
		username: user.username,
		name: user.name,
		role: (i === 0 ? "lead" : "user") as ProjectMember["role"],
	})),
	research: MOCK_USERS.slice(0, 1).map((user) => ({
		id: user.id,
		email: user.email ?? "",
		username: user.username,
		name: user.name,
		role: "lead" as ProjectMember["role"],
	})),
};

export const MOCK_PROJECT_RESOURCES: Record<string, ProjectResources> = {
	platform: {
		total: 3,
		items: [
			{
				id: MOCK_REGISTRY.agents[0]?.id ?? "a-1",
				type: "agent",
				name: MOCK_REGISTRY.agents[0]?.name ?? "helper",
				qualified_name: MOCK_REGISTRY.agents[0]?.qualified_name ?? "platform/helper",
				visibility: "team",
			},
			{
				id: MOCK_REGISTRY.mcps[0]?.id ?? "m-1",
				type: "mcp",
				name: MOCK_REGISTRY.mcps[0]?.name ?? "github",
				qualified_name: MOCK_REGISTRY.mcps[0]?.qualified_name ?? "platform/github",
				visibility: "project",
			},
			{
				id: MOCK_REGISTRY.skills[0]?.id ?? "s-1",
				type: "skill",
				name: MOCK_REGISTRY.skills[0]?.name ?? "review",
				qualified_name: MOCK_REGISTRY.skills[0]?.qualified_name ?? "platform/review",
				visibility: "team",
			},
		],
	},
	payments: { total: 0, items: [] },
	research: { total: 0, items: [] },
};

// ── Recommendations ─────────────────────────────────────────────────

export const MOCK_RECOMMENDATIONS: RecommendationsResponse = {
	items: MOCK_REGISTRY.mcps.slice(0, 2).map((mcp, i) => ({
		type: "mcp",
		id: mcp.id,
		name: mcp.name,
		namespace: mcp.namespace ?? NAMESPACE,
		slug: mcp.slug ?? mcp.name,
		qualified_name: mcp.qualified_name ?? `${NAMESPACE}/${mcp.name}`,
		description: mcp.description ?? "",
		category: null,
		latest_version: "1.2.0",
		download_count: 60 - i * 10,
		matched_on: ["python", "testing"],
		score: 0.9 - i * 0.2,
		reason: "Used by agents similar to your recent sessions.",
	})),
	personalized: true,
	profile_sessions: 12,
	topics: ["python", "testing", "code review"],
};

// ── Admin settings (instance settings pages) ────────────────────────────────
// Mirrors caracal-server/services/dynamic_settings.py SECTIONS/DEFAULTS.

const SETTING_DEFAULTS: Record<string, string> = {
	"insights.api_key": "",
	"insights.api_base": "",
	"insights.api_version": "",
	"insights.model_sections": "",
	"insights.model_synthesis": "",
	"insights.model_facets": "",
	"insights.batch_enabled": "true",
	"insights.batch_period_days": "14",
	"insights.min_sessions": "5",
	"insights.facet_max_calls": "100",
	"insights.facet_concurrency": "25",
	"insights.registry_match_enabled": "true",
	"insights.registry_match_per_type": "6",
	"insights.registry_match_max_items": "24",
	"deployment.frontend_url": "http://localhost:8000",
	"deployment.public_url": "",
	"deployment.cors_origins": "http://localhost:8000",
	"deployment.base_domain": "",
	"danger.purge_traces_insights": "",
	"security.allow_internal_git_urls": "false",
	"security.allow_draft_install": "false",
	"security.trace_privacy": "false",
	"security.trusted_proxy_ips": "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16,127.0.0.1",
	"registry.registered_agents_only": "false",
	"retention.enabled": "false",
	"retention.trace_days": "",
	"retention.score_days": "",
	"retention.max_trace_count": "",
	"resource.db_pool_size": "10",
	"resource.db_max_overflow": "20",
	"resource.redis_max_connections": "50",
	"resource.redis_socket_timeout": "2.0",
	"resource.clickhouse_max_connections": "20",
	"resource.clickhouse_max_keepalive": "10",
	"resource.clickhouse_timeout": "10.0",
	"data.retention_days": "90",
	"inbox.retention_days": "90",
	"data.cache_ttl_default": "30",
	"data.cache_ttl_dashboard": "60",
	"observability.log_level": "INFO",
	"observability.log_format": "json",
	"observability.enable_openapi": "false",
	"observability.enable_metrics": "false",
	"misc.harness_allowlist": "",
	"misc.default_harness": "",
	"misc.git_mirror_base_path": "",
};

const RESTART_REQUIRED_SETTING_KEYS = new Set([
	"data.cache_ttl_default",
	"data.cache_ttl_dashboard",
	"observability.log_format",
	"observability.enable_openapi",
	"observability.enable_metrics",
	"misc.git_mirror_base_path",
]);

function settingLabel(key: string): string {
	const label = key
		.split(".")
		.pop()!
		.split("_")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
	return label.replace("Api", "API").replace("Url", "URL").replace("Db ", "DB ").replace("Ttl", "TTL");
}

function schemaSection(
	id: string,
	title: string,
	description: string,
	prefixes: string[],
	danger = false,
): AdminSettingSection {
	return {
		id,
		title,
		description,
		...(danger ? { danger } : {}),
		settings: Object.keys(SETTING_DEFAULTS)
			.filter((key) => prefixes.some((p) => key.startsWith(p)))
			.map((key) => ({
				key,
				label: settingLabel(key),
				subtitle: "",
				default: SETTING_DEFAULTS[key],
				restart_required: RESTART_REQUIRED_SETTING_KEYS.has(key),
			})),
	};
}

export const MOCK_SETTINGS_SCHEMA: AdminSettingSection[] = [
	schemaSection("insights", "AI Engine", "Configure the shared LLM provider and batch policy.", ["insights."]),
	schemaSection("danger", "Danger Zone", "Destructive maintenance actions.", ["danger."], true),
	schemaSection("deployment", "Deployment", "Core deployment configuration. Changes may affect authentication and access.", ["deployment."], true),
	schemaSection("security", "Security", "Security policies and rate limiting.", ["security."], true),
	schemaSection("resource", "Resource Tuning", "Connection pool sizes and query limits.", ["resource."]),
	schemaSection("data", "Data & Retention", "Deployment-wide retention policies and cache TTLs.", ["data.", "retention.", "inbox."]),
	schemaSection("registry", "Registry", "Deployment-wide registry policy.", ["registry."]),
	schemaSection("observability", "Observability", "Logging and metrics configuration.", ["observability."]),
	schemaSection("misc", "Miscellaneous", "Other system settings.", ["misc."]),
];

export const MOCK_ADMIN_SETTINGS: AdminSetting[] = [
	{ key: "deployment.frontend_url", value: "http://localhost:8000" },
	{ key: "observability.log_level", value: "INFO" },
	{ key: "insights.api_key", value: "**REDACTED**", is_sensitive: true, is_set: true },
	{ key: "insights.model_sections", value: "anthropic/claude-sonnet-4-5" },
];

export const MOCK_ADMIN_STATE = {
	tracePrivacy: false,
	registeredAgentsOnly: false,
	retention: {
		retention_enabled: false,
		data_retention_days: null as number | null,
		score_retention_days: null as number | null,
		max_trace_count: null as number | null,
		global_retention_days: 90,
	},
};

// ── Admin observability (audit log, security events, diagnostics) ───

function auditEntry(n: number, overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
	return {
		event_id: `e0000000-0000-4000-8000-00000000000${n}`,
		timestamp: daysAgo(0, -n * 47),
		actor_id: MOCK_USER.id,
		actor_email: MOCK_USER.email,
		actor_role: "operator",
		action: "update",
		resource_type: "setting",
		resource_id: "observability.log_level",
		resource_name: "observability.log_level",
		http_method: "PUT",
		http_path: "/api/v1/operator/settings/observability.log_level",
		status_code: 200,
		ip_address: "127.0.0.1",
		user_agent: "Mozilla/5.0 (mock)",
		detail: "",
		sensitivity: "normal",
		request_id: `r0000000-0000-4000-8000-00000000000${n}`,
		outcome: "success",
		duration_ms: 12 + n * 3,
		chain_hash: `mockchainhash${n}`,
		source: "api",
		...overrides,
	};
}

export const MOCK_AUDIT_LOG: AuditLogEntry[] = [
	auditEntry(1),
	auditEntry(2, {
		action: "publish",
		resource_type: "agent",
		resource_id: MOCK_REGISTRY.agents[0].id,
		resource_name: "code-reviewer",
		http_method: "POST",
		http_path: "/api/v1/agents/code-reviewer/publish",
	}),
	auditEntry(3, {
		actor_id: MOCK_USERS[1].id,
		actor_email: MOCK_USERS[1].email,
		actor_role: "user",
		action: "delete",
		resource_type: "skill",
		resource_id: "commit-hygiene",
		resource_name: "commit-hygiene",
		http_method: "DELETE",
		http_path: "/api/v1/registry/skill/commit-hygiene",
		status_code: 403,
		outcome: "denied",
	}),
	auditEntry(4, {
		action: "export",
		resource_type: "audit_log",
		resource_id: "audit-log",
		resource_name: "Audit log export",
		http_method: "GET",
		http_path: "/api/v1/operator/audit-log/export",
		sensitivity: "phi_adjacent",
	}),
	auditEntry(5, {
		actor_id: MOCK_USERS[2].id,
		actor_email: MOCK_USERS[2].email,
		actor_role: "reviewer",
		action: "approve",
		resource_type: "submission",
		resource_id: MOCK_REGISTRY.mcps[0].id,
		resource_name: "github-mcp",
		http_method: "POST",
		http_path: "/api/v1/review/approve",
	}),
];

export const MOCK_SECURITY_EVENTS: SecurityEvent[] = [
	{
		event_id: "v0000000-0000-4000-8000-000000000001",
		timestamp: daysAgo(0, -30),
		event_type: "login_failed",
		severity: "warning",
		actor_id: "",
		actor_email: "richard@caracal.run",
		actor_role: "",
		target_id: MOCK_USERS[1].id,
		target_type: "user",
		outcome: "denied",
		source_ip: "127.0.0.1",
		user_agent: "Mozilla/5.0 (mock)",
		detail: "Invalid password (2nd attempt)",
	},
	{
		event_id: "v0000000-0000-4000-8000-000000000002",
		timestamp: daysAgo(1),
		event_type: "rate_limited",
		severity: "info",
		actor_id: MOCK_USERS[2].id,
		actor_email: MOCK_USERS[2].email ?? "",
		actor_role: "reviewer",
		target_id: "/api/v1/agents",
		target_type: "endpoint",
		outcome: "throttled",
		source_ip: "127.0.0.1",
		user_agent: "caracal-cli/1.0",
		detail: "Burst limit exceeded",
	},
	{
		event_id: "v0000000-0000-4000-8000-000000000003",
		timestamp: daysAgo(2),
		event_type: "token_revoked",
		severity: "critical",
		actor_id: MOCK_USER.id,
		actor_email: MOCK_USER.email,
		actor_role: "operator",
		target_id: MOCK_USERS[1].id,
		target_type: "user",
		outcome: "success",
		source_ip: "127.0.0.1",
		user_agent: "Mozilla/5.0 (mock)",
		detail: "All sessions revoked by admin",
	},
];

// ── Organization-scoped activity (cursor pagination fixtures) ────────
// Enough rows, with varied actors/outcomes/event types and strictly
// descending timestamps, to exercise multi-page navigation, filtering, and
// sorting against the mock's server-style pagination.

function activityTimestamp(minutesAgo: number): string {
	const base = Date.UTC(2026, 7, 30, 18, 0, 0);
	return new Date(base - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 23);
}

function activityEventId(prefix: string, n: number): string {
	return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const ORG_ACTIVITY_ACTORS = [MOCK_USER, MOCK_USERS[1], MOCK_USERS[2]];

const ORG_AUDIT_REQUESTS = [
	{ method: "PATCH", path: "/api/v1/orgs/acme", outcome: "success", status: 200 },
	{ method: "POST", path: "/api/v1/orgs/acme/members", outcome: "success", status: 201 },
	{ method: "DELETE", path: "/api/v1/orgs/acme/members/u-9", outcome: "denied", status: 403 },
	{ method: "POST", path: "/api/v1/orgs/acme/projects", outcome: "success", status: 201 },
	{ method: "GET", path: "/api/v1/orgs/acme/members/ghost", outcome: "not_found", status: 404 },
	{ method: "POST", path: "/api/v1/orgs/acme/invitations", outcome: "error", status: 500 },
];

export const MOCK_ORG_AUDIT_LOG: AuditLogEntry[] = Array.from({ length: 130 }, (_, i) => {
	const actor = ORG_ACTIVITY_ACTORS[i % ORG_ACTIVITY_ACTORS.length];
	const req = ORG_AUDIT_REQUESTS[i % ORG_AUDIT_REQUESTS.length];
	return {
		event_id: activityEventId("a1000000", i),
		timestamp: activityTimestamp(i * 17),
		actor_id: actor.id,
		actor_email: actor.email ?? "",
		actor_role: "admin",
		action: `${req.method.toLowerCase()}.${req.path}`,
		resource_type: "",
		resource_id: i % ORG_AUDIT_REQUESTS.length === 0 ? "org-acme" : "",
		resource_name: "",
		http_method: req.method,
		http_path: req.path,
		status_code: req.status,
		ip_address: "127.0.0.1",
		user_agent: "Mozilla/5.0 (mock)",
		detail: "",
		sensitivity: "standard",
		request_id: activityEventId("r1000000", i),
		outcome: req.outcome,
		duration_ms: 8 + (i % 40),
		chain_hash: `mockchain${i}`,
		source: "server",
	};
});

const ORG_SECURITY_KINDS = [
	{ event_type: "org.created", severity: "info", outcome: "success", detail: "Created organization 'acme'" },
	{ event_type: "org.membership.changed", severity: "warning", outcome: "success", detail: "Set richard@caracal.run to admin in 'acme'" },
	{ event_type: "org.invitation.created", severity: "info", outcome: "success", detail: "Invited teammate@example.com to project 'acme/platform'" },
	{ event_type: "org.invitation.accepted", severity: "info", outcome: "success", detail: "Invitation accepted for teammate@example.com" },
	{ event_type: "org.project.membership.changed", severity: "warning", outcome: "success", detail: "Updated project membership for 'acme/payments'" },
	{ event_type: "org.renamed", severity: "warning", outcome: "success", detail: "Organization id changed from 'caracal' to 'acme'" },
	{ event_type: "org.invitation.revoked", severity: "warning", outcome: "denied", detail: "Revoked a pending invitation after suspicious forwarding" },
	{ event_type: "org.ownership.transferred", severity: "critical", outcome: "success", detail: "Ownership transferred to raw@caracal.run" },
	{ event_type: "org.project.retention.changed", severity: "high", outcome: "success", detail: "Changed resource deletion retention policy for project 'acme/platform'" },
	{ event_type: "login_failed", severity: "warning", outcome: "failure", detail: "Rejected organization admin sign-in for richard@caracal.run" },
	{ event_type: "rate_limited", severity: "info", outcome: "throttled", detail: "Blocked burst of organization member edits from one source" },
];

export const MOCK_ORG_SECURITY_EVENTS: SecurityEvent[] = Array.from({ length: 130 }, (_, i) => {
	const actor = ORG_ACTIVITY_ACTORS[i % ORG_ACTIVITY_ACTORS.length];
	const kind = ORG_SECURITY_KINDS[i % ORG_SECURITY_KINDS.length];
	return {
		event_id: activityEventId("s1000000", i),
		timestamp: activityTimestamp(i * 23),
		event_type: kind.event_type,
		severity: kind.severity,
		actor_id: actor.id,
		actor_email: actor.email ?? "",
		actor_role: "admin",
		target_id: "org-acme",
		target_type: "organization",
		outcome: kind.outcome,
		source_ip: i % 4 === 0 ? "10.20.30.40" : "127.0.0.1",
		user_agent: i % 5 === 0 ? "caracal-cli/1.0" : "Mozilla/5.0 (mock)",
		detail: kind.detail,
	};
});

export const MOCK_SYSTEM_STATUS: SystemStatusResponse = {
	overall: "degraded",
	checked_at: new Date().toISOString(),
	cache_ttl_seconds: 5,
	version: "dev-mock",
	uptime_seconds: 86_400 * 3 + 4_500,
	degraded_components: ["worker_queue"],
	failing_components: [],
	components: [
		{
			id: "database",
			name: "PostgreSQL",
			purpose: "Registry data: users, organizations, projects, agents, components",
			status: "healthy",
			latency_ms: 3.4,
			detail: null,
			metrics: { users: MOCK_USERS.length },
			checked_at: new Date().toISOString(),
		},
		{
			id: "identity",
			name: "Identity service",
			purpose: "Sign-in, sessions, and JWT signing keys (Better Auth)",
			status: "healthy",
			latency_ms: 12.8,
			detail: null,
			metrics: { jwks_keys: 1 },
			checked_at: new Date().toISOString(),
		},
		{
			id: "clickhouse",
			name: "ClickHouse",
			purpose: "Session events, telemetry, audit and security event storage",
			status: "healthy",
			latency_ms: 6.1,
			detail: null,
			metrics: {},
			checked_at: new Date().toISOString(),
		},
		{
			id: "redis",
			name: "Redis",
			purpose: "Background job queue, settings cache, token revocation, live updates",
			status: "healthy",
			latency_ms: 1.2,
			detail: null,
			metrics: {},
			checked_at: new Date().toISOString(),
		},
		{
			id: "worker_queue",
			name: "Background jobs",
			purpose: "Catalog sync, alert evaluation, and data maintenance (arq worker)",
			status: "degraded",
			latency_ms: 1.5,
			detail: "142 queued job(s); the worker is falling behind or not running",
			metrics: { queued_jobs: 142 },
			checked_at: new Date().toISOString(),
		},
		{
			id: "runtime_config",
			name: "Runtime configuration",
			purpose: "Deployment settings this instance boots with",
			status: "healthy",
			latency_ms: null,
			detail: null,
			metrics: {},
			checked_at: new Date().toISOString(),
		},
	],
};

export const MOCK_RETENTION_WARNINGS: RetentionWarnings = {
	warnings: [],
	retention_days: 90,
	retention_enabled: false,
};

// ── Exec dashboard ──────────────────────────────────────────────────

const EXEC_MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

export const MOCK_EXEC_ADOPTION: ExecAdoptionResponse = {
	monthly: EXEC_MONTHS.map((month, i) => ({ month, adoption_pct: 22 + i * 9 })),
	current_pct: 67,
	total_users: MOCK_USERS.length,
	active_users: 2,
	departments_covered: 3,
};

export const MOCK_EXEC_AGENT_COUNTS: ExecAgentCounts = {
	total: 3,
	active: 3,
	published: 3,
	in_development: 1,
	by_category: [
		{ category: "development", count: 2 },
		{ category: "documentation", count: 1 },
	],
};

export const MOCK_EXEC_USAGE_BY_CATEGORY: ExecUsageByCategory[] = [
	{ category: "development", sessions: 42, growth_pct: 18 },
	{ category: "documentation", sessions: 17, growth_pct: 6 },
	{ category: "testing", sessions: 11, growth_pct: -3 },
];

export const MOCK_EXEC_PLATFORM_COVERAGE: ExecPlatformCoverage[] = [
	{ platform: "claude-code", users: 2, sessions: 38 },
	{ platform: "kiro", users: 1, sessions: 21 },
	{ platform: "copilot", users: 1, sessions: 11 },
];

export const MOCK_EXEC_PLATFORMS: ExecPlatformScore[] = [
	{
		platform: "claude-code",
		composite_score: 87,
		sessions: 38,
		avg_cost: 0.42,
		avg_latency_ms: 1900,
		success_rate: 0.94,
		error_rate: 0.06,
		users: 2,
	},
	{
		platform: "kiro",
		composite_score: 79,
		sessions: 21,
		avg_cost: 0.31,
		avg_latency_ms: 2300,
		success_rate: 0.9,
		error_rate: 0.1,
		users: 1,
	},
];

export const MOCK_EXEC_VELOCITY: ExecVelocityResponse = {
	weekly: Array.from({ length: 8 }, (_, i) => ({
		week: dateOnly((7 - i) * 7),
		traces: 14 + i * 4,
	})),
	current_weekly_avg: 40,
	baseline_weekly_avg: 16,
	multiplier: 2.5,
};

export const MOCK_EXEC_TOP_AGENTS: ExecTopAgent[] = MOCK_REGISTRY.agents.map((agent, i) => ({
	id: agent.id,
	name: agent.name,
	category: "development",
	composite_score: 91 - i * 8,
	sessions: 34 - i * 9,
	downloads: 120 - i * 30,
	weekly_trend: [3, 5, 4, 7, 6, 9, 8].map((v) => Math.max(1, v - i)),
}));

export const MOCK_EXEC_DEPARTMENTS: ExecDepartmentsResponse = {
	departments: [
		{ department: "Platform", user_count: 1, agent_count: 2, utilization_pct: 74, sessions_per_user: 19 },
		{ department: "Backend", user_count: 1, agent_count: 1, utilization_pct: 58, sessions_per_user: 12 },
		{ department: "DX", user_count: 1, agent_count: 1, utilization_pct: 41, sessions_per_user: 7 },
	],
};

export const MOCK_EXEC_DEPT_TOKENS: ExecDeptTokenItem[] = [
	{ department: "Platform", tokens_used: 2_400_000, cost_per_task: 0.38, sessions_per_user: 19, trend_pct: 12 },
	{ department: "Backend", tokens_used: 1_100_000, cost_per_task: 0.29, sessions_per_user: 12, trend_pct: 4 },
	{ department: "DX", tokens_used: 600_000, cost_per_task: 0.22, sessions_per_user: 7, trend_pct: -2 },
];

export const MOCK_EXEC_COST_SUMMARY: ExecCostSummary = {
	monthly_savings: 8400,
	cost_reduction_pct: 31,
	projected_annual_savings: 100800,
	cost_per_task: 0.34,
	monthly_trend: EXEC_MONTHS.map((month, i) => ({
		month,
		ai_spend: 900 + i * 120,
		savings: 4200 + i * 840,
	})),
	by_category: [
		{ category: "development", baseline_cost: 14200, actual_cost: 9400, saved_pct: 34 },
		{ category: "documentation", baseline_cost: 5100, actual_cost: 3800, saved_pct: 25 },
	],
	configured: true,
};

export const MOCK_EXEC_ROI: ExecROIProjectionsResponse = {
	projections: [
		{ quarter: "2026-Q3", projected_savings: 25200, cumulative_savings: 25200, confidence: 0.9 },
		{ quarter: "2026-Q4", projected_savings: 28100, cumulative_savings: 53300, confidence: 0.75 },
		{ quarter: "2027-Q1", projected_savings: 31400, cumulative_savings: 84700, confidence: 0.6 },
	],
	growth_rate_pct: 11,
	time_to_breakeven_months: 4,
	total_invested: 18000,
	total_saved: 42600,
	roi_multiple: 2.4,
};

export const MOCK_EXEC_STRATEGIC: ExecStrategicInsightsResponse = {
	model_comparison: [
		{ model: "claude-sonnet-4-5", sessions: 41, avg_cost: 0.36, avg_tokens: 48000, success_rate: 0.94, best_at: "code review" },
		{ model: "gpt-5", sessions: 18, avg_cost: 0.44, avg_tokens: 52000, success_rate: 0.9, best_at: "documentation" },
	],
	department_gaps: [
		{ department: "DX", adoption_pct: 41, sessions: 7, opportunity: "Roll out test-runner to the DX team" },
	],
	quick_wins: [
		{ title: "Enable prompt caching", detail: "Half of code-reviewer sessions reuse the same context.", estimated_savings: 1200, effort: "low" },
	],
	platform_comparison: [
		{ platform: "claude-code", avg_task_time_ms: 210000, sessions: 38, success_rate: 0.94 },
		{ platform: "kiro", avg_task_time_ms: 260000, sessions: 21, success_rate: 0.9 },
	],
	power_user_pct: 33,
	power_user_value_pct: 61,
	total_active_users: 2,
	automatable_pct: 27,
};

export const MOCK_EXEC_DEVELOPERS: ExecDeveloperBreakdown = {
	total_developers: MOCK_USERS.length,
	active_developers: 2,
	top_20_value_pct: 58,
	developers: MOCK_USERS.map((user, i) => ({
		user_id: user.id,
		name: user.name ?? "",
		department: user.department ?? "Platform",
		sessions: 24 - i * 8,
		tokens_consumed: 1_800_000 - i * 600_000,
		cost: 96 - i * 34,
		percentile: 95 - i * 20,
	})),
};

export const MOCK_EXEC_INACTIVITY: ExecInactivityAlerts = {
	inactive_agents: [
		{ id: MOCK_REGISTRY.agents[2].id, name: "test-runner", category: "testing", last_session_days_ago: 12, previous_sessions: 9 },
	],
	inactive_users: [
		{ user_id: MOCK_USERS[2].id, name: MOCK_USERS[2].name ?? "", department: "DX", last_session_days_ago: 9, previous_sessions: 5 },
	],
};

export const MOCK_EXEC_TIME_TO_VALUE: ExecTimeToValueResponse = {
	agents: MOCK_REGISTRY.agents.map((agent, i) => ({
		id: agent.id,
		name: agent.name,
		category: "development",
		created_at: daysAgo(60 - i * 15),
		days_to_100: i === 2 ? null : 21 + i * 9,
		current_sessions: 34 - i * 9,
	})),
	avg_days_to_100: 25,
};

export const MOCK_EXEC_AI_INSIGHTS: ExecAIInsightsResponse = {
	quick_wins: [
		{ title: "Cache review context", detail: "Prompt caching would cut code-reviewer costs.", estimated_savings: "$1,200/mo", effort: "low" },
	],
	adoption_gaps: [
		{ title: "DX team underuses agents", detail: "41% adoption vs 74% on Platform.", impact: "medium" },
	],
	platform_insight: { title: "Claude Code leads", detail: "Highest success rate at the lowest latency." },
	model_insight: { title: "Sonnet is the workhorse", detail: "Best cost/quality ratio for review tasks." },
	automation_opportunity: { title: "Automate triage", detail: "27% of sessions follow a repeatable triage pattern." },
	usage_pattern: { title: "Weekday peaks", detail: "Sessions cluster Tuesday–Thursday mornings." },
	generated: true,
	generated_at: daysAgo(1),
};

export const MOCK_EXEC_STATE: { config: ExecConfig } = {
	config: {
		id: "x0000000-0000-4000-8000-0000000000c1",
		hourly_dev_cost: 95,
		pre_ai_baselines: { code_review_minutes: 45, docs_page_minutes: 120 },
		department_budgets: {
			Platform: { headcount: 1, monthly_budget: 4000 },
			Backend: { headcount: 1, monthly_budget: 2500 },
			DX: { headcount: 1, monthly_budget: 1500 },
		},
		target_adoption_pct: 80,
		target_adoption_date: dateOnly(-120),
	},
};
