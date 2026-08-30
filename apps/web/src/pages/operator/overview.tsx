// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Deployment intelligence: platform totals, 12-week creation growth, and
// 30-day tenant activity concentration for the team hosting this Caracal
// installation. Every number is measured; activity is marked unavailable
// rather than shown as zero when ClickHouse cannot answer. Tenant content
// never appears here.

import { Link } from "@tanstack/react-router";
import { useOperatorOverview } from "@/hooks/use-admin-api";
import { PageHeader } from "@/components/layouts/page-header";
import { Badge } from "@/components/ui/badge";
import {
	Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ErrorState } from "@/components/shared/error-state";
import { TableSkeleton } from "@/components/shared/skeleton-layouts";

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
	return (
		<div className="min-w-0 border-l border-border pl-4 first:border-l-0 first:pl-0">
			<p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
			<p className="mt-0.5 text-xl font-semibold tabular-nums tracking-tight">{value}</p>
			{detail && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>}
		</div>
	);
}

function formatWeek(weekStart: string) {
	try {
		return new Date(`${weekStart}T00:00:00Z`).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	} catch {
		return weekStart;
	}
}

export default function OperatorOverviewPage() {
	const overview = useOperatorOverview();
	const data = overview.data;
	const activity = data?.activity;
	// Newest week first: operators read the current state, then history.
	const weeks = data ? [...data.growth.weeks].reverse() : [];

	return (
		<>
			<PageHeader title="Deployment Overview" breadcrumbs={[{ label: "Operator" }, { label: "Overview" }]} />
			<div className="mx-auto w-full max-w-6xl space-y-6 p-6">
				<header>
					<h1 className="text-lg font-semibold tracking-tight">Deployment Overview</h1>
					<p className="mt-1 text-[13px] text-muted-foreground">
						Platform-wide state of this Caracal installation: tenants, accounts, growth, and
						activity concentration.
					</p>
				</header>

				{overview.isLoading && <TableSkeleton />}
				{overview.isError && (
					<ErrorState
						message="Failed to load the deployment overview."
						onRetry={() => overview.refetch()}
					/>
				)}
				{data && (
					<>
						<section className="grid grid-cols-2 gap-x-4 gap-y-5 rounded-md border p-4 sm:grid-cols-3 lg:grid-cols-6">
							<Stat
								label="Organizations"
								value={String(data.totals.organizations)}
								detail={
									data.totals.organizations_suspended > 0
										? `${data.totals.organizations_suspended} suspended`
										: "all active"
								}
							/>
							<Stat label="Projects" value={String(data.totals.projects)} />
							<Stat
								label="Accounts"
								value={String(data.totals.users.total)}
								detail={`${data.totals.users.operators} op / ${data.totals.users.reviewers} rev / ${data.totals.users.members} member`}
							/>
							<Stat label="Agents" value={String(data.totals.agents)} detail="published, non-deleted" />
							<Stat
								label="Sessions (30d)"
								value={activity?.available ? String(activity.sessions_30d) : "-"}
								detail={
									activity?.available
										? `${activity.events_30d} events ingested`
										: "telemetry unavailable"
								}
							/>
							<Stat
								label="Active orgs (30d)"
								value={activity?.available ? String(activity.orgs_active_30d) : "-"}
								detail={activity?.available ? `of ${data.totals.organizations} total` : "telemetry unavailable"}
							/>
						</section>

						<div className="grid gap-6 lg:grid-cols-2">
							<section className="space-y-2">
								<div className="flex items-baseline justify-between">
									<h2 className="text-[13px] font-semibold">Creation growth</h2>
									<span className="text-[11px] text-muted-foreground">last 12 weeks, newest first</span>
								</div>
								<div className="rounded-md border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead className="text-xs">Week of</TableHead>
												<TableHead className="text-right text-xs">Orgs</TableHead>
												<TableHead className="text-right text-xs">Users</TableHead>
												<TableHead className="text-right text-xs">Projects</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{weeks.map((week) => (
												<TableRow key={week.week_start}>
													<TableCell className="py-1.5 text-xs text-muted-foreground">
														{formatWeek(week.week_start)}
													</TableCell>
													<TableCell className="py-1.5 text-right text-[13px] tabular-nums">
														{week.organizations}
													</TableCell>
													<TableCell className="py-1.5 text-right text-[13px] tabular-nums">
														{week.users}
													</TableCell>
													<TableCell className="py-1.5 text-right text-[13px] tabular-nums">
														{week.projects}
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							</section>

							<section className="space-y-2">
								<div className="flex items-baseline justify-between">
									<h2 className="text-[13px] font-semibold">Most active organizations</h2>
									<span className="text-[11px] text-muted-foreground">sessions, last 30 days</span>
								</div>
								{!activity?.available && (
									<div className="rounded-md border p-4">
										<Badge variant="outline" className="text-[10px] text-muted-foreground">
											Session activity unavailable
										</Badge>
										<p className="mt-2 text-xs text-muted-foreground">
											ClickHouse did not answer; activity is never fabricated. Retry once
											telemetry is reachable.
										</p>
									</div>
								)}
								{activity?.available && activity.top_orgs.length === 0 && (
									<div className="rounded-md border p-4">
										<p className="text-xs text-muted-foreground">
											No organization recorded sessions in the last 30 days.
										</p>
									</div>
								)}
								{activity?.available && activity.top_orgs.length > 0 && (
									<div className="rounded-md border">
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead className="text-xs">Organization</TableHead>
													<TableHead className="text-right text-xs">Sessions (30d)</TableHead>
													<TableHead className="text-right text-xs">Share</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{activity.top_orgs.map((org) => (
													<TableRow key={org.id}>
														<TableCell className="py-1.5">
															<Link
																to="/operator/organizations"
																search={{ q: org.slug }}
																className="text-[13px] font-medium hover:underline"
															>
																{org.name}
															</Link>
															<span className="ml-2 font-mono text-[11px] text-muted-foreground">
																{org.slug}
															</span>
														</TableCell>
														<TableCell className="py-1.5 text-right text-[13px] tabular-nums">
															{org.sessions_30d}
														</TableCell>
														<TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">
															{activity.sessions_30d > 0
																? `${Math.round((org.sessions_30d / activity.sessions_30d) * 100)}%`
																: "-"}
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									</div>
								)}
							</section>
						</div>
					</>
				)}
			</div>
		</>
	);
}
