// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "@tanstack/react-router";
import {
	Activity,
	Building2,
	Database,
	ExternalLink,
	LineChart,
	ScrollText,
	Server,
	ShieldAlert,
	Sparkles,
	Users,
	Wrench,
} from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarTrigger,
} from "@/components/ui/sidebar";
import { useDeploymentConfig } from "@/hooks/use-deployment-config";
import { useAdminSettings } from "@/hooks/use-admin-api";

const operatorNavGroups = [
	{
		label: "Deployment",
		items: [
			{ title: "Overview", href: "/operator", icon: LineChart },
			{ title: "Organizations", href: "/operator/organizations", icon: Building2 },
			{ title: "Users", href: "/operator/users", icon: Users },
		],
	},
	{
		label: "Operations",
		items: [
			{ title: "Service Health", href: "/operator/status", icon: Server },
			{ title: "Telemetry & Data", href: "/operator/telemetry", icon: Database },
			{ title: "AI Engine", href: "/operator/ai-engine", icon: Sparkles },
		],
	},
	{
		label: "Security",
		items: [
			{ title: "Audit Log", href: "/operator/audit-log", icon: ScrollText },
			{ title: "Security Events", href: "/operator/security-events", icon: ShieldAlert },
		],
	},
	{
		label: "System",
		items: [{ title: "Advanced", href: "/operator/advanced", icon: Wrench }],
	},
];

// settingValue reads one key from either settings wire shape.
function settingValue(
	settings: { key: string; value: string }[] | Record<string, string> | undefined,
	key: string,
): string {
	if (!settings) return "";
	if (Array.isArray(settings)) {
		return settings.find((s) => s.key === key)?.value ?? "";
	}
	return settings[key] ?? "";
}

// externalMonitoringLinks keeps only http(s) URLs so a mistyped setting
// can never inject a javascript: link into the sidebar.
function safeExternalUrl(value: string): string {
	const trimmed = value.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	return "";
}

export function OperatorSidebar() {
	const { pathname } = useLocation();
	const { brandingLogo, brandingAppName, brandingWordmark } = useDeploymentConfig();
	const { data: settings } = useAdminSettings();
	const grafanaUrl = safeExternalUrl(settingValue(settings, "observability.grafana_url"));
	const prometheusUrl = safeExternalUrl(settingValue(settings, "observability.prometheus_url"));

	function isActive(href: string) {
		if (href === "/operator") return pathname === "/operator";
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	return (
		<Sidebar collapsible="icon" className="border-r border-sidebar-border">
			<SidebarHeader className="h-12 shrink-0 justify-center border-b border-sidebar-border/70 px-2 py-0">
				<div className="flex items-center gap-1">
					<SidebarMenu className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
						<SidebarMenuItem>
							<SidebarMenuButton asChild>
								<Link to="/operator">
									<div className="flex size-8 shrink-0 items-center justify-center">
										{brandingLogo ? (
											<img src={brandingLogo} alt="" width={26} height={26} className="object-contain" />
										) : (
											<img src="/caracal_nobg_dark_mode.png" alt="" width={26} height={26} className="object-contain" />
										)}
									</div>
									<div className="flex min-w-0 flex-col gap-0.5 leading-none">
										{brandingWordmark ? (
											<img src={brandingWordmark} alt={brandingAppName || "Caracal"} width={140} height={20} className="h-5 max-w-35 object-contain object-left" />
										) : (
											<span className="max-w-35 truncate font-display text-base font-semibold tracking-tight">
												{brandingAppName || "Caracal"}
											</span>
										)}
										<span className="text-[11px] uppercase tracking-[0.12em] text-sidebar-foreground/55">
											Operator
										</span>
									</div>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<SidebarTrigger className="h-7 w-7 shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
				</div>
			</SidebarHeader>

			<SidebarContent className="px-2 py-3">
				{operatorNavGroups.map((group) => (
					<SidebarGroup key={group.label} className="py-1.5">
						<SidebarGroupLabel className="h-7 text-xs font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/55">
							{group.label}
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu className="gap-0.5">
								{group.items.map((item) => (
									<SidebarMenuItem key={item.href}>
										<SidebarMenuButton asChild isActive={isActive(item.href)} tooltip={item.title}>
											<Link to={item.href}>
												<item.icon className="h-4 w-4" />
												<span>{item.title}</span>
											</Link>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				))}
				{(grafanaUrl || prometheusUrl) && (
					<SidebarGroup className="py-1.5">
						<SidebarGroupLabel className="h-7 text-xs font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/55">
							Monitoring
						</SidebarGroupLabel>
						<SidebarGroupContent>
							<SidebarMenu className="gap-0.5">
								{grafanaUrl && (
									<SidebarMenuItem>
										<SidebarMenuButton asChild tooltip="Grafana (external)">
											<a href={grafanaUrl} target="_blank" rel="noopener noreferrer">
												<ExternalLink className="h-4 w-4" />
												<span>Grafana</span>
											</a>
										</SidebarMenuButton>
									</SidebarMenuItem>
								)}
								{prometheusUrl && (
									<SidebarMenuItem>
										<SidebarMenuButton asChild tooltip="Prometheus (external)">
											<a href={prometheusUrl} target="_blank" rel="noopener noreferrer">
												<ExternalLink className="h-4 w-4" />
												<span>Prometheus</span>
											</a>
										</SidebarMenuButton>
									</SidebarMenuItem>
								)}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				)}
			</SidebarContent>

			<SidebarFooter className="border-t border-sidebar-border/70 p-2">
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton asChild tooltip="Application">
							<Link to="/">
								<Activity className="h-4 w-4" />
								<span>Application</span>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
