// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Link } from "@tanstack/react-router";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type {
	BriefingMetric,
	IntelligenceRange,
	IntelligenceSource,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export const RANGES: { value: IntelligenceRange; label: string }[] = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
];

export function formatNumber(value: number): string {
	if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (Math.abs(value) >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
	return value.toLocaleString();
}

export function formatMetricValue(metric: BriefingMetric): string {
	if (metric.restricted) return "Restricted";
	if (metric.value === null) return "Unavailable";
	const value = metric.unit === "%" ? metric.value.toFixed(1) : formatNumber(metric.value);
	return metric.unit === "credits" ? `${value} cr` : metric.unit === "%" ? `${value}%` : value;
}

export function ChangeBadge({ value, points = false }: { value: number | null; points?: boolean }) {
	if (value === null) return <span className="text-[11px] text-muted-foreground/60">new</span>;
	const Icon = value === 0 ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
	return (
		<span className={cn("inline-flex items-center gap-0.5 font-mono text-[11px] tabular-nums", value === 0 ? "text-muted-foreground" : value > 0 ? "text-success" : "text-destructive")}>
			<Icon className="h-3 w-3" />
			{Math.abs(value)}{points ? " pts" : "%"}
		</span>
	);
}

export function RangeSelector({ range, onChange }: { range: IntelligenceRange; onChange: (range: IntelligenceRange) => void }) {
	return (
		<div className="flex h-8 items-center rounded-md border border-border" role="radiogroup" aria-label="Time range">
			{RANGES.map((item) => (
				<button
					key={item.value}
					type="button"
					role="radio"
					aria-checked={range === item.value}
					onClick={() => onChange(item.value)}
					className={cn("h-full px-2.5 text-xs first:rounded-l-md last:rounded-r-md", range === item.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
				>
					{item.label}
				</button>
			))}
		</div>
	);
}

export function SourceHealth({ sources, generatedAt }: { sources: IntelligenceSource[]; generatedAt: string }) {
	return (
		<div className="w-full text-left text-[11px] leading-5 text-muted-foreground sm:w-auto sm:text-right">
			<p>Updated {new Date(generatedAt).toLocaleString()}</p>
			<p>{sources.map((source) => `${source.name} ${source.status === "fresh" ? "current" : source.status}`).join(" · ")}</p>
		</div>
	);
}

export function PartialDataNotice({ sources }: { sources: IntelligenceSource[] }) {
	const degraded = sources.filter((source) => source.status === "partial" || source.status === "unavailable");
	if (degraded.length === 0) return null;
	return (
		<div className="border-l-2 border-warning bg-warning/5 px-3 py-2 text-xs text-foreground">
			<span className="font-medium">Partial data.</span>{" "}
			{degraded.map((source) => source.message).filter(Boolean).join(" ")}
		</div>
	);
}

export function AgentLink({ qualified, label, className }: { qualified: string | null; label: string; className?: string }) {
	if (!qualified) return <span className={cn("text-muted-foreground", className)}>{label}</span>;
	const [namespace, slug] = qualified.split("/");
	return (
		<Link to="/agents/$namespace/$slug" params={{ namespace, slug }} className={cn("text-foreground underline-offset-4 hover:underline", className)}>
			{label}
		</Link>
	);
}
