// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// ── Overview ────────────────────────────────────────────────────────

export interface OverviewStats {
	total_mcps: number;
	total_agents: number;
	total_users: number;
	total_tool_calls: number;
	total_agent_interactions: number;
}

export interface TopItem {
	id: string;
	name: string;
	value: number;
}

export interface TrendPoint {
	date: string;
	submissions: number;
	users: number;
}

// ── Tokens ──────────────────────────────────────────────────────────

export interface TokenStats {
	total_input: number;
	total_output: number;
	total_tokens: number;
	avg_per_trace: number;
	by_agent: TokenUsageRow[];
	by_mcp: TokenUsageRow[];
	over_time: { date: string; input: number; output: number }[];
}

export interface TokenUsageRow {
	name: string;
	input: number;
	output: number;
	total: number;
	traces: number;
}

// ── harness Usage ───────────────────────────────────────────────────────

export interface HarnessRow {
	harness: string;
	traces: number;
	avg_latency_ms: number;
	error_count: number;
	error_rate: number;
}

export interface HarnessUsageData {
	harnesses: HarnessRow[];
}
