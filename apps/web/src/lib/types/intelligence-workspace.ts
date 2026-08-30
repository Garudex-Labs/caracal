// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

export type IntelligenceRange = "24h" | "7d" | "30d" | "90d";
export type IntelligenceSourceStatus = "fresh" | "partial" | "unavailable" | "restricted";
export type IntelligenceSeverity = "info" | "warning" | "critical";
export type IntelligenceClassification = "fact" | "anomaly" | "interpretation" | "recommendation";
export type ResourceFocus = "all" | "attention" | "growing" | "declining" | "underused";
export type ResourceSort = "impact" | "attention" | "growth" | "cost" | "name";
export type HistoryCategory = "all" | "usage" | "cost" | "change" | "quality";

export interface IntelligenceSource {
	name: "telemetry" | "registry" | "cost" | string;
	status: IntelligenceSourceStatus;
	message: string | null;
	updated_at: string;
}

export interface BriefingMetric {
	key: string;
	label: string;
	value: number | null;
	previous: number | null;
	change_pct: number | null;
	unit: string;
	restricted: boolean;
}

export interface IntelligenceActivityPoint {
	date: string;
	sessions: number | null;
	active_users: number | null;
	tool_calls: number | null;
	tokens: number | null;
	credits: number | null;
}

export interface SignalEvidence {
	label: string;
	value: number | string;
	unit: string;
}

export interface SignalAction {
	kind: "investigate_resource" | "open_resource" | "open_history" | "inspect_cost" | string;
	label: string;
}

export interface IntelligenceSignal {
	id: string;
	kind: string;
	classification: IntelligenceClassification;
	severity: IntelligenceSeverity;
	title: string;
	explanation: string;
	impact: string;
	agent_id: string | null;
	qualified_name: string | null;
	evidence: SignalEvidence[];
	actions: SignalAction[];
}

export interface IntelligenceAdoptionBrief {
	active_users: number | null;
	new_users: number | null;
	returning_users: number | null;
	top_resource_share_pct: number | null;
	attributed_sessions: number | null;
}

export interface IntelligenceOwner {
	user_id: string;
	name: string;
	role: string;
	department: string | null;
	resources_owned: number;
	changes_submitted: number;
	issues_opened: number;
	issues_resolved: number;
}

export interface IntelligenceResource {
	agent_id: string;
	name: string;
	qualified_name: string | null;
	owner: string | null;
	version: string | null;
	status: string | null;
	sessions: number | null;
	previous_sessions: number | null;
	change_pct: number | null;
	tool_calls: number | null;
	tool_completion_pct: number | null;
	tokens: number | null;
	credits: number | null;
	credits_per_session: number | null;
	downloads: number | null;
	previous_downloads: number | null;
	open_issues: number | null;
	resolved_issues: number | null;
	last_used: string | null;
	updated_at: string | null;
	attention_reasons: string[];
}

export interface IntelligenceBriefing {
	range: IntelligenceRange;
	comparison: string;
	generated_at: string;
	sources: IntelligenceSource[];
	has_data: boolean;
	metrics: BriefingMetric[];
	activity: IntelligenceActivityPoint[];
	signals: IntelligenceSignal[];
	resource_highlights: IntelligenceResource[];
	adoption: IntelligenceAdoptionBrief;
	ownership: IntelligenceOwner[];
}

export interface IntelligenceResourcesResponse {
	range: IntelligenceRange;
	generated_at: string;
	sources: IntelligenceSource[];
	cost_restricted: boolean;
	rows: IntelligenceResource[];
	total: number;
	page: number;
	page_size: number;
}

export interface IntelligenceResourceQuery {
	range: IntelligenceRange;
	focus?: ResourceFocus;
	search?: string;
	sort?: ResourceSort;
	page?: number;
	pageSize?: number;
}

export interface IntelligenceCompareResponse {
	range: IntelligenceRange;
	generated_at: string;
	sources: IntelligenceSource[];
	a: IntelligenceResource;
	b: IntelligenceResource;
	deltas: Record<string, number | null>;
}

export interface IntelligenceResourceVersion {
	version: string;
	status: string;
	released_at: string | null;
	sessions: number | null;
	tool_calls: number | null;
	tool_completion_pct: number | null;
	tokens: number | null;
	credits: number | null;
}

export interface IntelligenceResourceVersionsResponse {
	range: IntelligenceRange;
	generated_at: string;
	sources: IntelligenceSource[];
	versions: IntelligenceResourceVersion[];
}

export interface IntelligenceHistoryEvent {
	id: string;
	occurred_at: string;
	kind: string;
	category: Exclude<HistoryCategory, "all">;
	classification: IntelligenceClassification;
	severity: IntelligenceSeverity;
	title: string;
	detail: string;
	agent_id: string | null;
	qualified_name: string | null;
	version_id: string | null;
	version: string | null;
	issue_id: string | null;
	evidence: SignalEvidence[];
}

export interface IntelligenceHistoryResponse {
	range: IntelligenceRange;
	generated_at: string;
	sources: IntelligenceSource[];
	events: IntelligenceHistoryEvent[];
	total: number;
	page: number;
	page_size: number;
	has_more: boolean;
}
