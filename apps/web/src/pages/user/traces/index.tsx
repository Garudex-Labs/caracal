// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// The trace investigation workspace. One server-side query - search, facet
// filters, thresholds, deterministic sort, and offset pagination - resolves
// behind /api/v1/sessions/query, and the URL is the single source of truth
// so any investigation state is shareable and survives reloads. Anomaly
// flags are grounded in the window's own p95 percentiles returned by the
// server; nothing is inferred client-side from partial pages.

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
	Activity,
	ArrowUpDown,
	Bot,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Copy,
	Flame,
	GitCompareArrows,
	ListFilter,
	Search,
	SearchX,
	Timer,
	X,
} from "lucide-react";
import { PageHeader } from "@/components/layouts/page-header";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";
import { ErrorState } from "@/components/shared/error-state";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useTraceQuery, useSessionSubscription } from "@/hooks/use-api";
import { hasMinRole } from "@/hooks/use-role-guard";
import { getUserRole } from "@/lib/api";
import type { TraceListItem } from "@/lib/types";
import {
	TRACE_PAGE_SIZES,
	type TracesSearch,
} from "@/routes/_authed/_user/traces/index";

/** Quickstart docs URL shown in the first-time empty state CTA. */
const DOCS_QUICKSTART_URL =
	"https://github.com/Garudex-Labs/caracal/blob/main/docs/getting-started/quickstart.md";

const RANGE_LABELS: Record<string, string> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
	all: "All time",
};
const RANGE_DAYS: Record<string, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, all: 0 };
const DEFAULT_RANGE = "30d";

const SORT_LABELS: Record<string, string> = {
	recent: "Newest first",
	oldest: "Oldest first",
	duration: "Longest duration",
	tokens: "Most tokens",
	credits: "Most credits",
	prompts: "Most prompts",
	tools: "Most tool calls",
};

const HARNESSES: { value: string; label: string }[] = [
	{ value: "claude-code", label: "Claude Code" },
	{ value: "kiro", label: "Kiro" },
	{ value: "cursor", label: "Cursor" },
	{ value: "copilot-cli", label: "Copilot CLI" },
	{ value: "copilot", label: "Copilot" },
	{ value: "codex", label: "Codex CLI" },
	{ value: "opencode", label: "OpenCode" },
	{ value: "goose", label: "Goose" },
	{ value: "pi", label: "Pi" },
	{ value: "antigravity", label: "Antigravity" },
];

const DURATION_FLOORS: { value: number; label: string }[] = [
	{ value: 60, label: "≥ 1 minute" },
	{ value: 300, label: "≥ 5 minutes" },
	{ value: 900, label: "≥ 15 minutes" },
	{ value: 3600, label: "≥ 1 hour" },
];

const TOKEN_FLOORS: { value: number; label: string }[] = [
	{ value: 10_000, label: "≥ 10k" },
	{ value: 100_000, label: "≥ 100k" },
	{ value: 500_000, label: "≥ 500k" },
	{ value: 1_000_000, label: "≥ 1M" },
];

// Percentile flags stay off until the window is big enough to make a p95
// meaningful; below this the "anomaly" would just be the max of a handful.
const FLAG_MIN_WINDOW = 20;

/* ── Value helpers ─────────────────────────────────────────────────── */

function toNum(value: number | string | undefined | null): number {
	if (value == null) return 0;
	const n = typeof value === "number" ? value : parseFloat(value);
	return Number.isFinite(n) ? n : 0;
}

const TS_UPPER_BOUND_MS = new Date("2099-01-01").getTime();

function toDate(ts: string): Date {
	if (ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) return new Date(ts);
	// ClickHouse DateTime64 arrives as "YYYY-MM-DD HH:MM:SS.mmm" (UTC, no Z).
	return new Date(ts.replace(" ", "T") + "Z");
}

function fmtTokens(value: number | string | undefined): string {
	const n = toNum(value);
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCredits(value: number | string | undefined | null): string | null {
	const n = toNum(value);
	if (n <= 0) return null;
	return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

function fmtDurationS(seconds: number | string | undefined): string {
	const s = Math.floor(toNum(seconds));
	if (s <= 0) return "< 1m";
	const hours = Math.floor(s / 3600);
	const mins = Math.floor((s % 3600) / 60);
	if (hours > 0) return `${hours}h ${String(mins).padStart(2, "0")}m`;
	if (mins > 0) return `${mins}m`;
	return `${s}s`;
}

function relTime(ts?: string): string {
	if (!ts) return "–";
	const t = toDate(ts).getTime();
	if (t >= TS_UPPER_BOUND_MS) return "–";
	const ms = Date.now() - t;
	if (ms < 0) return "just now";
	const mins = Math.floor(ms / 60_000);
	const hours = Math.floor(ms / 3_600_000);
	const days = Math.floor(ms / 86_400_000);
	if (days > 0) return `${days}d ago`;
	if (hours > 0) return `${hours}h ago`;
	if (mins > 0) return `${mins}m ago`;
	return "just now";
}

function absTime(ts?: string): string {
	if (!ts) return "";
	return toDate(ts).toLocaleString();
}

function shortModel(raw?: string): string {
	if (!raw) return "";
	return raw.replace("claude-", "").replace("anthropic.", "").replace(/-\d{8}$/, "");
}

/** Middle-truncates a long identifier; the full value rides in the title. */
function shortId(id: string): string {
	if (id.length <= 20) return id;
	return `${id.slice(0, 12)}…${id.slice(-6)}`;
}

function traceTitle(row: TraceListItem): string {
	const model = shortModel(row.model);
	const agent = row.agent_name
		? `${row.agent_name}${row.agent_version ? ` v${row.agent_version}` : ""}`
		: "";
	if (agent && model) return `${agent} · ${model}`;
	if (agent) return agent;
	if (model) return model;
	return row.platform ?? row.service_name ?? "session";
}

/* ── Small pieces ──────────────────────────────────────────────────── */

function CopyIdButton({ id }: { id: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label="Copy session id"
			title={copied ? "Copied" : `Copy ${id}`}
			onClick={(e) => {
				e.stopPropagation();
				void navigator.clipboard.writeText(id).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1_500);
				});
			}}
			className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
		>
			{copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
		</button>
	);
}

function StatusCell({ row }: { row: TraceListItem }) {
	if (row.is_active) {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
				<span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" />
				Active
			</span>
		);
	}
	return <span className="text-xs text-muted-foreground">Completed</span>;
}

/** Grounded anomaly marker: only rendered when the server-computed window
 * p95 exists and the row exceeds it. Icon + text, never color alone. */
function AnomalyFlag({
	kind,
	detail,
}: {
	kind: "slow" | "tokens";
	detail: string;
}) {
	const Icon = kind === "slow" ? Timer : Flame;
	return (
		<Badge
			variant="outline"
			title={detail}
			className="ml-1.5 gap-0.5 border-warning/40 px-1 py-0 text-[10px] font-medium text-warning"
		>
			<Icon aria-hidden className="h-2.5 w-2.5" />
			{kind === "slow" ? "slow" : "high"}
		</Badge>
	);
}

/* ── Compare sheet ─────────────────────────────────────────────────── */

type MetricRow = {
	label: string;
	value: (row: TraceListItem) => string;
	num?: (row: TraceListItem) => number;
	fmt?: (n: number) => string;
};

const COMPARE_METRICS: MetricRow[] = [
	{ label: "Started", value: (r) => absTime(r.first_event_time) || "–" },
	{
		label: "Duration",
		value: (r) => fmtDurationS(r.duration_s),
		num: (r) => toNum(r.duration_s),
		fmt: fmtDurationS,
	},
	{ label: "Prompts", value: (r) => `${toNum(r.prompt_count)}`, num: (r) => toNum(r.prompt_count) },
	{
		label: "Tool results",
		value: (r) => `${toNum(r.tool_result_count)}`,
		num: (r) => toNum(r.tool_result_count),
	},
	{
		label: "Input tokens",
		value: (r) => fmtTokens(r.total_input_tokens),
		num: (r) => toNum(r.total_input_tokens),
		fmt: fmtTokens,
	},
	{
		label: "Output tokens",
		value: (r) => fmtTokens(r.total_output_tokens),
		num: (r) => toNum(r.total_output_tokens),
		fmt: fmtTokens,
	},
	{
		label: "Cache read",
		value: (r) => fmtTokens(r.total_cache_read_tokens),
		num: (r) => toNum(r.total_cache_read_tokens),
		fmt: fmtTokens,
	},
	{
		label: "Credits",
		value: (r) => fmtCredits(r.total_credits) ?? "–",
		num: (r) => toNum(r.total_credits),
		fmt: (n) => n.toFixed(2),
	},
	{ label: "Model", value: (r) => shortModel(r.model) || "–" },
	{ label: "Platform", value: (r) => r.platform ?? r.service_name ?? "–" },
	{
		label: "Resource",
		value: (r) =>
			r.agent_name ? `${r.agent_name}${r.agent_version ? ` v${r.agent_version}` : ""}` : "–",
	},
	{ label: "User", value: (r) => r.user_name ?? "–" },
];

function CompareSheet({
	pair,
	open,
	onOpenChange,
}: {
	pair: [TraceListItem, TraceListItem];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [a, b] = pair;
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle className="flex items-center gap-2 text-sm">
						<GitCompareArrows className="h-4 w-4 text-muted-foreground" />
						Compare traces
					</SheetTitle>
				</SheetHeader>
				<div className="mt-4 space-y-4">
					<table className="w-full text-sm">
						<thead>
							<tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
								<th scope="col" className="py-1.5 pr-2 font-medium">
									Metric
								</th>
								{[a, b].map((row, index) => (
									<th key={index} scope="col" className="py-1.5 pr-2 font-medium">
										<Link
											to="/traces/$traceId"
											params={{ traceId: row.session_id }}
											className="font-mono text-[11px] normal-case tracking-normal underline-offset-2 hover:underline"
											title={row.session_id}
										>
											{shortId(row.session_id)}
										</Link>
									</th>
								))}
								<th scope="col" className="py-1.5 font-medium">
									Δ (B − A)
								</th>
							</tr>
						</thead>
						<tbody>
							{COMPARE_METRICS.map((metric) => {
								const delta =
									metric.num !== undefined ? metric.num(b) - metric.num(a) : undefined;
								const fmt = metric.fmt ?? ((n: number) => `${Math.abs(n)}`);
								return (
									<tr key={metric.label} className="border-b border-border/60 last:border-b-0">
										<td className="py-1.5 pr-2 text-xs text-muted-foreground">{metric.label}</td>
										<td className="py-1.5 pr-2 text-xs tabular-nums">{metric.value(a)}</td>
										<td className="py-1.5 pr-2 text-xs tabular-nums">{metric.value(b)}</td>
										<td className="py-1.5 text-xs tabular-nums">
											{delta === undefined || delta === 0 ? (
												<span className="text-muted-foreground">–</span>
											) : (
												<span className={delta > 0 ? "text-warning" : "text-success"}>
													{delta > 0 ? "+" : "−"}
													{fmt(Math.abs(delta))}
												</span>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
					<p className="text-[11px] text-muted-foreground">
						Values come from the stored session summaries. Open either trace for the full
						execution timeline.
					</p>
				</div>
			</SheetContent>
		</Sheet>
	);
}

/* ── Page ──────────────────────────────────────────────────────────── */

export default function TracesPage() {
	const navigate = useNavigate();
	const search = useSearch({ from: "/_authed/_user/traces/" });
	const isAdmin = hasMinRole(getUserRole(), "operator");
	useSessionSubscription();

	const range = search.range && RANGE_LABELS[search.range] ? search.range : DEFAULT_RANGE;
	const sort = search.sort && SORT_LABELS[search.sort] ? search.sort : "recent";
	const page = search.page ?? 1;
	const per = search.per ?? TRACE_PAGE_SIZES[0];

	// Every filter change resets to page 1; page moves go through goPage.
	const patch = (updates: Partial<TracesSearch>, replace = false) =>
		navigate({
			to: "/traces",
			replace,
			search: (prev: TracesSearch): TracesSearch => ({ ...prev, page: undefined, ...updates }),
		});

	const goPage = (next: number) =>
		navigate({
			to: "/traces",
			search: (prev: TracesSearch): TracesSearch => ({ ...prev, page: next > 1 ? next : undefined }),
		});

	const [searchInput, setSearchInput] = useState(search.q ?? "");
	const [modelInput, setModelInput] = useState(search.model ?? "");
	const [userInput, setUserInput] = useState(search.user ?? "");
	useEffect(() => setSearchInput(search.q ?? ""), [search.q]);
	useEffect(() => setModelInput(search.model ?? ""), [search.model]);
	useEffect(() => setUserInput(search.user ?? ""), [search.user]);

	// Debounce free-text search into the URL (replace, not history spam).
	useEffect(() => {
		const q = searchInput.trim();
		if (q === (search.q ?? "")) return;
		const handle = setTimeout(() => void patch({ q: q || undefined }, true), 300);
		return () => clearTimeout(handle);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchInput]);

	const query = useTraceQuery({
		q: search.q,
		platform: search.platform,
		model: search.model,
		agent: search.agent,
		user: search.user,
		status: search.status,
		days: RANGE_DAYS[range],
		min_duration: search.minDur,
		min_tokens: search.minTok,
		sort,
		page,
		page_size: per,
	});
	const { data, isLoading, isError, error, isFetching, refetch, dataUpdatedAt } = query;

	const items = data?.items ?? [];
	const total = data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / per));
	const p95Duration = data?.p95_duration_s ?? 0;
	const p95Tokens = data?.p95_total_tokens ?? 0;
	const flagsActive = total >= FLAG_MIN_WINDOW;

	// Snap back when the result set shrinks under the current page.
	useEffect(() => {
		if (data && page > 1 && page > totalPages) {
			void navigate({
				to: "/traces",
				replace: true,
				search: (prev: TracesSearch): TracesSearch => ({
					...prev,
					page: totalPages > 1 ? totalPages : undefined,
				}),
			});
		}
	}, [data, page, totalPages, navigate]);

	// Compare selection persists across pages (items, not just ids).
	const [compareSel, setCompareSel] = useState<TraceListItem[]>([]);
	const [compareOpen, setCompareOpen] = useState(false);
	const selectedIds = useMemo(() => new Set(compareSel.map((r) => r.session_id)), [compareSel]);
	const toggleCompare = (row: TraceListItem) =>
		setCompareSel((prev) => {
			if (prev.some((r) => r.session_id === row.session_id)) {
				return prev.filter((r) => r.session_id !== row.session_id);
			}
			if (prev.length >= 2) return prev;
			return [...prev, row];
		});

	const filterCount =
		[search.platform, search.model, search.agent, search.user, search.status].filter(Boolean)
			.length + (search.minDur ? 1 : 0) + (search.minTok ? 1 : 0);

	const clearFilters = () =>
		void patch({
			platform: undefined,
			model: undefined,
			agent: undefined,
			user: undefined,
			status: undefined,
			minDur: undefined,
			minTok: undefined,
		});

	const rangeStart = total === 0 ? 0 : (page - 1) * per + 1;
	const rangeEnd = Math.min(page * per, total);
	const platformLabelFor = (value: string) =>
		HARNESSES.find((h) => h.value === value)?.label ?? value;

	/* Filter chips shown under the toolbar so the active query is explicit. */
	const chips: { key: string; label: string; clear: () => void }[] = [];
	if (search.platform)
		chips.push({
			key: "platform",
			label: `Platform: ${platformLabelFor(search.platform)}`,
			clear: () => void patch({ platform: undefined }),
		});
	if (search.model)
		chips.push({ key: "model", label: `Model: ${search.model}`, clear: () => void patch({ model: undefined }) });
	if (search.agent) {
		const known = items.find((r) => r.agent_id === search.agent)?.agent_name;
		chips.push({
			key: "agent",
			label: `Agent: ${known ?? shortId(search.agent)}`,
			clear: () => void patch({ agent: undefined }),
		});
	}
	if (search.user)
		chips.push({ key: "user", label: `User: ${search.user}`, clear: () => void patch({ user: undefined }) });
	if (search.status)
		chips.push({ key: "status", label: `Status: ${search.status}`, clear: () => void patch({ status: undefined }) });
	if (search.minDur) {
		const label = DURATION_FLOORS.find((f) => f.value === search.minDur)?.label ?? `≥ ${search.minDur}s`;
		chips.push({ key: "minDur", label: `Duration ${label}`, clear: () => void patch({ minDur: undefined }) });
	}
	if (search.minTok) {
		const label = TOKEN_FLOORS.find((f) => f.value === search.minTok)?.label ?? `≥ ${search.minTok}`;
		chips.push({ key: "minTok", label: `Tokens ${label}`, clear: () => void patch({ minTok: undefined }) });
	}

	return (
		<>
			<PageHeader title="Traces" breadcrumbs={[{ label: "My Traces" }]} />
			<div className="mx-auto w-full max-w-7xl space-y-3 p-6">
				{/* Toolbar: one unified query - search, range, filters, sort. */}
				<div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Trace query">
					<div className="relative min-w-0 flex-1 sm:max-w-80">
						<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={searchInput}
							onChange={(e) => setSearchInput(e.target.value)}
							placeholder="Search session id or model…"
							aria-label="Search traces"
							className="h-8 pl-7 pr-7 text-xs"
						/>
						{searchInput && (
							<button
								type="button"
								onClick={() => setSearchInput("")}
								aria-label="Clear search"
								className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<X className="h-3 w-3" />
							</button>
						)}
					</div>
					<Select value={range} onValueChange={(value) => void patch({ range: value === DEFAULT_RANGE ? undefined : value })}>
						<SelectTrigger className="h-8 w-36 text-xs" aria-label="Time range">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Object.entries(RANGE_LABELS).map(([value, label]) => (
								<SelectItem key={value} value={value} className="text-xs">
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="ml-auto flex items-center gap-1.5">
						{filterCount > 0 && (
							<Button
								variant="ghost"
								size="sm"
								className="h-8 gap-1 px-2 text-xs text-muted-foreground"
								onClick={clearFilters}
							>
								<X className="h-3 w-3" />
								Clear
							</Button>
						)}
						<Popover>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs">
									<ListFilter className="h-3.5 w-3.5" />
									Filters
									{filterCount > 0 && (
										<span className="rounded-sm bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
											{filterCount}
										</span>
									)}
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-72 space-y-3 p-3">
								<div className="grid grid-cols-2 gap-2">
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Platform</Label>
										<Select
											value={search.platform ?? "any"}
											onValueChange={(value) => void patch({ platform: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by platform">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any platform
												</SelectItem>
												{HARNESSES.map((h) => (
													<SelectItem key={h.value} value={h.value} className="text-xs">
														{h.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Status</Label>
										<Select
											value={search.status ?? "any"}
											onValueChange={(value) => void patch({ status: value === "any" ? undefined : value })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by status">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any status
												</SelectItem>
												<SelectItem value="active" className="text-xs">
													Active
												</SelectItem>
												<SelectItem value="completed" className="text-xs">
													Completed
												</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Min duration</Label>
										<Select
											value={search.minDur ? String(search.minDur) : "any"}
											onValueChange={(value) => void patch({ minDur: value === "any" ? undefined : Number(value) })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by minimum duration">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any duration
												</SelectItem>
												{DURATION_FLOORS.map((f) => (
													<SelectItem key={f.value} value={String(f.value)} className="text-xs">
														{f.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<div className="space-y-1">
										<Label className="text-[11px] text-muted-foreground">Min tokens</Label>
										<Select
											value={search.minTok ? String(search.minTok) : "any"}
											onValueChange={(value) => void patch({ minTok: value === "any" ? undefined : Number(value) })}
										>
											<SelectTrigger className="h-7 text-xs" aria-label="Filter by minimum tokens">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="any" className="text-xs">
													Any usage
												</SelectItem>
												{TOKEN_FLOORS.map((f) => (
													<SelectItem key={f.value} value={String(f.value)} className="text-xs">
														{f.label}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								</div>
								<div className="space-y-1">
									<Label htmlFor="traces-model" className="text-[11px] text-muted-foreground">
										Model contains
									</Label>
									<Input
										id="traces-model"
										value={modelInput}
										onChange={(e) => setModelInput(e.target.value)}
										onBlur={() => {
											const model = modelInput.trim();
											if (model !== (search.model ?? "")) void patch({ model: model || undefined });
										}}
										onKeyDown={(e) => {
											if (e.key === "Enter") e.currentTarget.blur();
										}}
										placeholder="e.g. sonnet"
										className="h-7 text-xs"
									/>
								</div>
								{isAdmin && (
									<div className="space-y-1">
										<Label htmlFor="traces-user" className="text-[11px] text-muted-foreground">
											User
										</Label>
										<Input
											id="traces-user"
											value={userInput}
											onChange={(e) => setUserInput(e.target.value)}
											onBlur={() => {
												const user = userInput.trim();
												if (user !== (search.user ?? "")) void patch({ user: user || undefined });
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") e.currentTarget.blur();
											}}
											placeholder="Name, username, or email"
											className="h-7 text-xs"
										/>
									</div>
								)}
								<div className="flex items-center justify-between border-t border-border pt-2">
									<Button
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-xs text-muted-foreground"
										onClick={clearFilters}
										disabled={filterCount === 0}
									>
										Reset filters
									</Button>
									<span className="text-[11px] tabular-nums text-muted-foreground">
										{total} result{total === 1 ? "" : "s"}
									</span>
								</div>
							</PopoverContent>
						</Popover>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" aria-label="Sort traces">
									<ArrowUpDown className="h-3.5 w-3.5" />
									<span className="hidden sm:inline">{SORT_LABELS[sort]}</span>
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-44">
								<DropdownMenuRadioGroup
									value={sort}
									onValueChange={(value) => void patch({ sort: value === "recent" ? undefined : value })}
								>
									{Object.entries(SORT_LABELS).map(([value, label]) => (
										<DropdownMenuRadioItem key={value} value={value} className="text-xs">
											{label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>

				{/* Active filter chips + compare bar */}
				{(chips.length > 0 || compareSel.length > 0) && (
					<div className="flex min-h-7 flex-wrap items-center gap-2" aria-label="Active filters">
						{chips.map((chip) => (
							<Button
								key={chip.key}
								variant="secondary"
								size="sm"
								className="h-6 gap-1 px-2 text-[11px]"
								onClick={chip.clear}
							>
								{chip.label}
								<X className="h-3 w-3" />
							</Button>
						))}
						{compareSel.length > 0 && (
							<span className="ml-auto flex items-center gap-1.5">
								<span className="text-[11px] text-muted-foreground">
									{compareSel.length} of 2 selected
								</span>
								<Button
									size="sm"
									variant="outline"
									className="h-6 gap-1 px-2 text-[11px]"
									disabled={compareSel.length !== 2}
									onClick={() => setCompareOpen(true)}
								>
									<GitCompareArrows className="h-3 w-3" />
									Compare
								</Button>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 px-2 text-[11px] text-muted-foreground"
									onClick={() => setCompareSel([])}
								>
									Clear
								</Button>
							</span>
						)}
					</div>
				)}

				{isLoading ? (
					<TableSkeleton rows={10} cols={8} />
				) : isError ? (
					<ErrorState
						message={error instanceof Error ? error.message : "Trace store is unavailable"}
						onRetry={() => refetch()}
					/>
				) : items.length === 0 ? (
					search.q ? (
						<EmptyState
							icon={SearchX}
							title={`No traces match “${search.q.length > 50 ? `${search.q.slice(0, 50)}…` : search.q}”`}
							description="Search covers session ids and model names. Try a different term or clear the search."
							actionLabel="Clear search"
							onAction={() => setSearchInput("")}
						/>
					) : filterCount > 0 ? (
						<EmptyState
							icon={ListFilter}
							title="No traces match the active filters"
							description="Loosen or reset the filters to see more of your executions."
							actionLabel="Reset filters"
							onAction={clearFilters}
						/>
					) : range !== "all" ? (
						<EmptyState
							icon={Activity}
							title={`No traces in the ${RANGE_LABELS[range].toLowerCase()}`}
							description="Nothing was captured in this time range. Older executions may still exist."
							actionLabel="Show all time"
							onAction={() => void patch({ range: "all" })}
						/>
					) : (
						<EmptyState
							icon={Activity}
							title="No traces yet"
							description="Traces are captured automatically once a harness delivers sessions through Caracal."
							actionLabel="Connect your first harness"
							actionHref={DOCS_QUICKSTART_URL}
						/>
					)
				) : (
					<div className="overflow-hidden rounded-md border border-border">
						<div className="max-h-[70vh] overflow-y-auto">
							<table className={`w-full text-sm transition-opacity ${isFetching ? "opacity-60" : ""}`}>
								<thead className="sticky top-0 z-1 bg-background shadow-[inset_0_-1px_0_0_var(--color-border)]">
									<tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
										<th scope="col" className="w-8 px-2 py-2">
											<span className="sr-only">Compare</span>
										</th>
										<th scope="col" className="px-3 py-2 font-medium">
											Trace
										</th>
										<th scope="col" className="px-3 py-2 font-medium">
											Resource
										</th>
										<th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
											User
										</th>
										<th scope="col" className="hidden px-3 py-2 font-medium md:table-cell">
											Model / Platform
										</th>
										<th scope="col" className="px-3 py-2 font-medium">
											Status
										</th>
										<th scope="col" className="hidden px-3 py-2 text-right font-medium xl:table-cell">
											Activity
										</th>
										<th scope="col" className="px-3 py-2 text-right font-medium">
											Tokens
										</th>
										<th scope="col" className="hidden px-3 py-2 text-right font-medium xl:table-cell">
											Credits
										</th>
										<th scope="col" className="px-3 py-2 text-right font-medium">
											Duration
										</th>
										<th scope="col" className="px-3 py-2 text-right font-medium">
											Started
										</th>
									</tr>
								</thead>
								<tbody>
									{items.map((row) => {
										const durationS = toNum(row.duration_s);
										const totalTokens = toNum(row.total_tokens);
										const slow = flagsActive && p95Duration > 0 && durationS > p95Duration;
										const heavy = flagsActive && p95Tokens > 0 && totalTokens > p95Tokens;
										const credits = fmtCredits(row.total_credits ?? row.credits);
										return (
											<tr
												key={row.session_id}
												onClick={() =>
													navigate({ to: "/traces/$traceId", params: { traceId: row.session_id } })
												}
												className="cursor-pointer border-b border-border transition-colors last:border-b-0 hover:bg-accent/40"
											>
												<td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
													<Checkbox
														aria-label={`Select ${row.session_id} for comparison`}
														checked={selectedIds.has(row.session_id)}
														disabled={compareSel.length >= 2 && !selectedIds.has(row.session_id)}
														onCheckedChange={() => toggleCompare(row)}
													/>
												</td>
												<td className="max-w-0 px-3 py-2" style={{ minWidth: "12rem" }}>
													<Link
														to="/traces/$traceId"
														params={{ traceId: row.session_id }}
														onClick={(e) => e.stopPropagation()}
														className="block truncate text-[13px] font-medium underline-offset-2 hover:underline"
													>
														{traceTitle(row)}
													</Link>
													<span className="flex items-center gap-1">
														<span
															className="truncate font-mono text-[11px] text-muted-foreground"
															title={row.session_id}
														>
															{shortId(row.session_id)}
														</span>
														<CopyIdButton id={row.session_id} />
													</span>
												</td>
												<td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
													{row.agent_id ? (
														<span className="flex items-center gap-1 whitespace-nowrap">
															<Bot aria-hidden className="h-3 w-3 text-muted-foreground" />
															<Link
																to="/agents/$agentId"
																params={{ agentId: row.agent_id }}
																className="max-w-36 truncate text-xs underline-offset-2 hover:underline"
																title="Open the agent this trace ran"
															>
																{row.agent_name ?? shortId(row.agent_id)}
															</Link>
															{row.agent_version && (
																<Link
																	to="/agents/$agentId"
																	params={{ agentId: row.agent_id }}
																	search={{ view: "versions" }}
																	className="font-mono text-[10px] text-muted-foreground underline-offset-2 hover:underline"
																	title="Open this version in the resource history"
																>
																	v{row.agent_version}
																</Link>
															)}
															<button
																type="button"
																aria-label="Filter traces by this agent"
																title="Show only this agent's traces"
																onClick={() => void patch({ agent: row.agent_id ?? undefined })}
																className="rounded p-0.5 text-muted-foreground/50 hover:text-foreground"
															>
																<ListFilter className="h-3 w-3" />
															</button>
														</span>
													) : (
														<span className="text-xs text-muted-foreground">–</span>
													)}
												</td>
												<td className="hidden max-w-28 truncate px-3 py-2 text-xs text-muted-foreground lg:table-cell">
													{row.user_name ?? "–"}
												</td>
												<td className="hidden px-3 py-2 md:table-cell">
													<span className="block max-w-40 truncate font-mono text-xs" title={row.model}>
														{shortModel(row.model) || "–"}
													</span>
													<span className="block text-[11px] text-muted-foreground">
														{row.platform ?? row.service_name}
													</span>
												</td>
												<td className="whitespace-nowrap px-3 py-2">
													<StatusCell row={row} />
												</td>
												<td className="hidden whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground xl:table-cell">
													{toNum(row.prompt_count)}p · {toNum(row.tool_result_count)}t
												</td>
												<td
													className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular-nums"
													title={`In ${toNum(row.total_input_tokens).toLocaleString()} · Out ${toNum(row.total_output_tokens).toLocaleString()} · Cache read ${toNum(row.total_cache_read_tokens).toLocaleString()}`}
												>
													{totalTokens > 0 ? (
														<>
															{fmtTokens(row.total_input_tokens)}
															<span className="text-muted-foreground/50">/</span>
															{fmtTokens(row.total_output_tokens)}
															{heavy && (
																<AnomalyFlag
																	kind="tokens"
																	detail={`Above the 95th percentile (${fmtTokens(p95Tokens)}) for the current result window`}
																/>
															)}
														</>
													) : (
														<span className="text-muted-foreground">–</span>
													)}
												</td>
												<td className="hidden whitespace-nowrap px-3 py-2 text-right font-mono text-xs tabular-nums xl:table-cell">
													{credits ? `${credits} cr` : <span className="text-muted-foreground">–</span>}
												</td>
												<td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums">
													{fmtDurationS(durationS)}
													{slow && (
														<AnomalyFlag
															kind="slow"
															detail={`Above the 95th percentile (${fmtDurationS(p95Duration)}) for the current result window`}
														/>
													)}
												</td>
												<td
													className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted-foreground"
													title={absTime(row.first_event_time)}
												>
													{relTime(row.first_event_time)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5">
							<span className="text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
								Showing {rangeStart}–{rangeEnd} of {total}
								{flagsActive && p95Duration > 0 && (
									<span className="ml-2 hidden sm:inline">
										· p95 {fmtDurationS(p95Duration)} / {fmtTokens(p95Tokens)} tokens
									</span>
								)}
								{dataUpdatedAt > 0 && (
									<span className="ml-2 hidden md:inline">
										· updated {relTime(new Date(dataUpdatedAt).toISOString())}
									</span>
								)}
							</span>
							<div className="flex items-center gap-2">
								<Select
									value={String(per)}
									onValueChange={(value) =>
										void patch({ per: Number(value) === TRACE_PAGE_SIZES[0] ? undefined : Number(value) })
									}
								>
									<SelectTrigger className="h-6 w-24 text-[11px]" aria-label="Rows per page">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{TRACE_PAGE_SIZES.map((size) => (
											<SelectItem key={size} value={String(size)} className="text-xs">
												{size} / page
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<nav aria-label="Pagination" className="flex items-center gap-0.5">
									<Button
										variant="ghost"
										size="sm"
										className="h-6 gap-0.5 px-1.5 text-[11px]"
										disabled={page <= 1}
										onClick={() => goPage(page - 1)}
									>
										<ChevronLeft className="h-3 w-3" />
										Prev
									</Button>
									<span className="px-1.5 text-[11px] tabular-nums text-muted-foreground">
										{page} / {totalPages}
									</span>
									<Button
										variant="ghost"
										size="sm"
										className="h-6 gap-0.5 px-1.5 text-[11px]"
										disabled={page >= totalPages}
										onClick={() => goPage(page + 1)}
									>
										Next
										<ChevronRight className="h-3 w-3" />
									</Button>
								</nav>
							</div>
						</div>
					</div>
				)}
			</div>
			{compareSel.length === 2 && (
				<CompareSheet
					pair={[compareSel[0], compareSel[1]]}
					open={compareOpen}
					onOpenChange={setCompareOpen}
				/>
			)}
		</>
	);
}
