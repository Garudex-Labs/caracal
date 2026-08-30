// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// ── Sessions ────────────────────────────────────────────────────────

export interface SessionsStats {
	total_sessions: number;
	total_prompts: number;
	total_api_requests: number;
	total_tool_calls: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_traces: number;
	total_spans: number;
}

export interface SessionTrace {
	trace_id: string;
	span_name: string;
	service_name?: string;
	duration_ns: number;
	status: string;
	session_id?: string;
	timestamp?: string;
}

export interface SubagentSession {
	session_id: string;
	spawned_by: string | null;
	events: RawSessionEvent[];
}

export interface SessionData {
	session_id: string;
	events: RawSessionEvent[];
	traces: unknown[];
	service_name: string;
	agent_id?: string | null;
	agent_name?: string | null;
	agent_version?: string | null;
	subagent_sessions?: SubagentSession[];
	max_offset?: number;
}

export interface RawSessionEvent {
	timestamp: string;
	event_name: string;
	body?: string;
	attributes?: Record<string, string>;
	service_name?: string;
}

// ── Sessions ────────────────────────────────────────────────────────

export interface Session {
	session_id: string;
	first_event_time: string;
	last_event_time: string;
	is_active?: boolean;
	prompt_count: number;
	api_request_count: number;
	tool_result_count: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cache_read_tokens?: number;
	total_cache_write_tokens?: number;
	total_credits?: number; // Kiro only: lifetime session credit spend
	model: string;
	service_name: string;
	user_id?: string;
	user_name?: string;
	platform?: string;
	terminal_type?: string;
	credits?: string;
	tools_used?: string;
	agent_id?: string | null;
	agent_name?: string | null;
	agent_version?: string | null;
}

export interface SessionsSummary {
	total_sessions: number;
	today_sessions: number;
}

// One row of the unified investigation listing; 64-bit counters can arrive
// as strings (ClickHouse JSON quoting), so numeric fields are coerced at
// render time.
export interface TraceListItem extends Session {
	duration_s?: number | string;
	total_tokens?: number | string;
}

export interface TraceQueryParams {
	q?: string;
	platform?: string;
	model?: string;
	agent?: string;
	user?: string;
	status?: string;
	days?: number;
	min_duration?: number;
	min_tokens?: number;
	sort?: string;
	page?: number;
	page_size?: number;
	mine?: boolean;
}

export interface TraceQueryResponse {
	items: TraceListItem[];
	total: number;
	page: number;
	page_size: number;
	p95_duration_s: number;
	p95_total_tokens: number;
}

export interface SessionErrorEvent {
	timestamp: string;
	event_name: string;
	body: string;
	session_id: string;
	tool_name: string;
	error: string;
	agent_id: string;
	agent_type: string;
	tool_input: string;
	tool_response: string;
	stop_reason: string;
	user_id: string;
	user_name?: string;
}

// ── Account devices (auth service) ──────────────────────────────────
// Device-grouped view of the account's authentication sessions. The auth
// service groups raw Better Auth sessions by stable device identity; the
// security page renders devices first and reveals per-device history on
// demand. Session tokens are never included in this payload.

export interface AccountDeviceSession {
	id: string;
	createdAt: string;
	lastActiveAt: string;
	expiresAt: string;
	ipAddress: string | null;
	current: boolean;
	active: boolean;
}

export interface AccountDevice {
	deviceId: string;
	label: string;
	clientType: "browser" | "cli" | "api" | "unknown";
	client: string;
	os: string;
	form: "desktop" | "mobile" | "cli" | "unknown";
	current: boolean;
	active: boolean;
	firstSeenAt: string;
	lastActiveAt: string;
	sessionCount: number;
	activeSessionCount: number;
	ipAddresses: string[];
	sessions: AccountDeviceSession[];
}

export interface AccountDevicesResponse {
	devices: AccountDevice[];
	retention_days: number;
}
