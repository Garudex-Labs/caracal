"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow — Enterprise Gateway Screen.

Provides the TUI interface for connecting and managing the enterprise
gateway.  Available when a valid enterprise license is connected.

Deployment types displayed:
  - Managed (Caracal platform): gateway endpoint auto-provisioned in SaaS.
  - On-Prem (customer): customer deploys the gateway in their own infra.

Menu structure:
  - Connection status (current gateway endpoint, enforcement mode)
  - Connect to gateway (endpoint + API key prompt)
  - View provider registry entries
  - Mandate revocation check (interactive)
  - Quota usage by dimension
  - Gateway logs (recent audit trail)
  - Revoke mandate via gateway
  - Disconnect / reconfigure
"""

from __future__ import annotations

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from caracal.core.gateway_features import (
    GatewayFeatureFlags,
    get_gateway_features,
    load_gateway_features,
    reset_gateway_features,
    DEPLOYMENT_MANAGED,
    DEPLOYMENT_ON_PREM,
)
from caracal.enterprise.license import load_enterprise_config, save_enterprise_config
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons
from caracal.logging_config import get_logger

logger = get_logger(__name__)


class GatewayFlow:
    """
    TUI gateway management screen for enterprise users.

    Embedded under the Enterprise menu.  Allows connecting to a managed
    or on-prem gateway, viewing enforcement status, checking provider
    registry, and managing mandate revocations via the network layer.
    """

    def __init__(self, console: Optional[Console] = None) -> None:
        self.console = console or Console()
        self._flags: Optional[GatewayFeatureFlags] = None

    # ── Menu loop ─────────────────────────────────────────────────────────────

    def run(self) -> None:
        while True:
            self._flags = get_gateway_features(reload=True)
            action = self._show_menu()
            if action in (None, "back"):
                break
            self._dispatch(action)

    def _show_menu(self) -> Optional[str]:
        self.console.clear()
        self._print_status_bar()

        items = [
            MenuItem(
                key="status",
                label="Gateway Status",
                description="View current enforcement mode and connection health",
                icon="",
            ),
            MenuItem(
                key="connect",
                label="Sync Gateway Configuration",
                description="Pull gateway config from Enterprise dashboard (auto-configures endpoint and keys)",
                icon="",
            ),
        ]

        if self._flags and self._flags.gateway_enabled:
            items += [
                MenuItem(
                    key="providers",
                    label="Provider Registry",
                    description="View registered upstream API providers",
                    icon="",
                ),
                MenuItem(
                    key="revocation",
                    label="Check Mandate Revocation",
                    description="Query the gateway for a mandate's revocation status",
                    icon="",
                ),
                MenuItem(
                    key="revoke",
                    label="Revoke Mandate via Gateway",
                    description="Push a revocation through the gateway (propagates to all nodes)",
                    icon="",
                ),
                MenuItem(
                    key="quota",
                    label="Quota Usage",
                    description="View per-tenant rate limit and quota counters",
                    icon="",
                ),
                MenuItem(
                    key="logs",
                    label="Gateway Audit Log",
                    description="View recent gateway enforcement events",
                    icon="",
                ),
                MenuItem(
                    key="disconnect",
                    label="Disconnect Gateway",
                    description="Remove gateway configuration from workspace",
                    icon="",
                ),
            ]

        items.append(
            MenuItem(
                key="back",
                label="Back to Enterprise Menu",
                description="Return to enterprise features",
                icon=Icons.ARROW_LEFT,
            )
        )

        menu = Menu(
            title="Enterprise Gateway",
            items=items,
            show_hints=True,
        )
        result = menu.run()
        return result.key if result else None

    def _dispatch(self, action: str) -> None:
        dispatch_map = {
            "status": self.show_status,
            "connect": self.connect_gateway,
            "providers": self.show_providers,
            "revocation": self.check_revocation,
            "revoke": self.revoke_mandate,
            "quota": self.show_quota,
            "logs": self.show_logs,
            "disconnect": self.disconnect_gateway,
        }
        handler = dispatch_map.get(action)
        if handler:
            handler()

    # ── Status bar ────────────────────────────────────────────────────────────

    def _print_status_bar(self) -> None:
        flags = self._flags
        if not flags or not flags.gateway_enabled:
            self.console.print(
                f"  [{Colors.WARNING}]⚠ Gateway not configured[/]  "
                f"[{Colors.DIM}]Run 'Sync from Enterprise' to auto-configure[/]"
            )
        else:
            mode_label = {
                DEPLOYMENT_MANAGED: "Managed (Caracal platform)",
                DEPLOYMENT_ON_PREM: "On-Prem (customer)",
            }.get(flags.deployment_type, flags.deployment_type)
            endpoint = flags.gateway_endpoint or "—"
            self.console.print(
                f"  [{Colors.SUCCESS}]● Gateway: {mode_label}[/]  "
                f"[{Colors.DIM}]{endpoint}[/]  "
                f"[{Colors.PRIMARY}]fail_closed={'yes' if flags.fail_closed else 'no'}[/]"
            )
        self.console.print()

    # ── Screens ───────────────────────────────────────────────────────────────

    def show_status(self) -> None:
        self.console.clear()
        flags = get_gateway_features(reload=True)
        cfg = load_enterprise_config()

        table = Table(
            title="Gateway Configuration",
            show_header=False,
            border_style=Colors.PRIMARY,
            padding=(0, 2),
        )
        table.add_column("Key", style=f"bold {Colors.DIM}")
        table.add_column("Value", style=Colors.TEXT)

        enabled_str = (
            f"[bold {Colors.SUCCESS}]Yes[/]"
            if flags.gateway_enabled
            else f"[{Colors.WARNING}]No (OSS broker mode)[/]"
        )
        table.add_row("Gateway Enabled", enabled_str)

        deploy = {
            DEPLOYMENT_MANAGED: f"[bold {Colors.PRIMARY}]Managed (Caracal platform)[/]",
            DEPLOYMENT_ON_PREM: f"[bold {Colors.PRIMARY}]On-Prem (customer)[/]",
        }.get(flags.deployment_type, flags.deployment_type)
        table.add_row("Deployment Type", deploy)
        table.add_row("Endpoint", flags.gateway_endpoint or f"[{Colors.DIM}]Not set[/]")
        table.add_row(
            "API Key",
            "●●●●●●●●" if flags.gateway_api_key else f"[{Colors.DIM}]Not set[/]",
        )
        table.add_row(
            "Fail-Closed",
            f"[bold {Colors.SUCCESS}]Yes[/]" if flags.fail_closed else f"[{Colors.WARNING}]No[/]",
        )
        table.add_row(
            "Provider Registry",
            "Enabled" if flags.use_provider_registry else f"[{Colors.DIM}]Disabled[/]",
        )
        table.add_row("Mandate Cache TTL", f"{flags.mandate_cache_ttl_seconds}s")
        table.add_row("Revocation Sync Interval", f"{flags.revocation_sync_interval_seconds}s")
        table.add_row("Config Source", getattr(flags, "_source", "defaults"))

        self.console.print(table)
        self.console.print()

        # Live connectivity check
        if flags.gateway_enabled and flags.gateway_endpoint:
            self._check_gateway_health(flags.gateway_endpoint)

        Prompt.ask("Press Enter to continue", default="")

    def connect_gateway(self) -> None:
        self.console.clear()

        self.console.print(Panel(
            "[bold]Connect Enterprise Gateway[/bold]\n\n"
            "The gateway configuration is automatically synced from your\n"
            "Enterprise dashboard.  No manual endpoint or key entry is needed.\n\n"
            "[bold]Managed (Caracal platform)[/bold] — gateway is hosted and operated by Caracal;\n"
            "endpoint and key are auto-provisioned when your workspace is created.\n\n"
            "[bold]On-Prem (customer)[/bold] — gateway runs in your infrastructure but\n"
            "configuration is still managed centrally via the Enterprise dashboard.",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        ))
        self.console.print()

        cfg = load_enterprise_config()
        if not cfg.get("enterprise_api_url") and not cfg.get("sync_api_key"):
            self.console.print(
                f"[{Colors.WARNING}]No enterprise license connected.[/]\n"
                f"[{Colors.DIM}]Connect your license first via Enterprise → Connect Enterprise License.[/]"
            )
            Prompt.ask("Press Enter to continue", default="")
            return

        self.console.print(f"[{Colors.DIM}]Syncing gateway configuration from Enterprise...[/]")

        try:
            from caracal.enterprise.sync import EnterpriseSyncClient
            client = EnterpriseSyncClient()
            result = client.pull_gateway_config()

            self.console.print()

            if result.get("success") and result.get("gateway_configured"):
                deploy_type = result.get("deployment_type", "managed")
                endpoint = result.get("gateway_endpoint", "—")
                mode_label = (
                    "Managed (Caracal platform)" if deploy_type == "managed"
                    else "On-Prem (customer)"
                )

                self.console.print(Panel(
                    f"[bold {Colors.SUCCESS}]✓ Gateway configuration synced successfully![/]\n\n"
                    f"[bold]Deployment:[/]  {mode_label}\n"
                    f"[bold]Endpoint:[/]   {endpoint}\n"
                    f"[bold]API Key:[/]    ●●●●●●●●\n"
                    f"[bold]Fail-Closed:[/] Yes\n"
                    f"[bold]Provider Registry:[/] Enabled\n\n"
                    f"[{Colors.DIM}]These settings are managed by your Enterprise dashboard.[/]\n"
                    f"[{Colors.DIM}]Changes made there will be picked up on the next sync.[/]",
                    border_style=Colors.SUCCESS,
                    padding=(1, 2),
                ))

                # Reload flags
                reset_gateway_features()
                self._flags = get_gateway_features(reload=True)

                # Verify connectivity
                if endpoint and endpoint != "—":
                    self._check_gateway_health(endpoint)
            elif result.get("success"):
                self.console.print(
                    f"[{Colors.WARNING}]Gateway not yet provisioned on your Enterprise workspace.[/]\n"
                    f"[{Colors.DIM}]{result.get('message', '')}[/]"
                )
            else:
                self.console.print(
                    f"[{Colors.ERROR}]Failed to sync gateway config: {result.get('message', 'Unknown error')}[/]"
                )
        except Exception as exc:
            self.console.print(f"[{Colors.ERROR}]Error syncing: {exc}[/]")

        self.console.print()
        Prompt.ask("Press Enter to continue", default="")

    def show_providers(self) -> None:
        self.console.clear()
        flags = get_gateway_features()
        if not flags.gateway_endpoint:
            self.console.print(f"[{Colors.WARNING}]No gateway endpoint configured.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        self.console.print(
            f"[{Colors.DIM}]Fetching provider registry from {flags.gateway_endpoint}...[/]"
        )
        providers = self._api_get(flags, "/admin/providers")

        if providers is None:
            self.console.print(f"[{Colors.ERROR}]Failed to fetch providers.[/]")
        elif not providers:
            self.console.print(f"[{Colors.WARNING}]No providers registered.[/]")
            self.console.print(
                f"\n[{Colors.DIM}]Register providers in the Enterprise dashboard under[/]\n"
                f"[bold]Gateway → Provider Registry[/bold]."
            )
        else:
            table = Table(
                title="Registered Providers",
                show_header=True,
                header_style=f"bold {Colors.PRIMARY}",
                border_style=Colors.BORDER,
            )
            table.add_column("ID")
            table.add_column("Name")
            table.add_column("Base URL")
            table.add_column("Status")
            table.add_column("TLS Pin")

            for p in providers:
                status_str = (
                    f"[{Colors.SUCCESS}]Enabled[/]"
                    if p.get("enabled")
                    else f"[{Colors.ERROR}]Disabled[/]"
                )
                table.add_row(
                    p.get("provider_id", "—"),
                    p.get("name", "—"),
                    p.get("base_url", "—"),
                    status_str,
                    "●" if p.get("tls_pin") else f"[{Colors.DIM}]none[/]",
                )
            self.console.print(table)

        self.console.print()
        Prompt.ask("Press Enter to continue", default="")

    def check_revocation(self) -> None:
        self.console.clear()
        flags = get_gateway_features()
        if not flags.gateway_endpoint:
            self.console.print(f"[{Colors.WARNING}]No gateway endpoint configured.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        mandate_id = Prompt.ask(
            f"[{Colors.PRIMARY}]Mandate ID to check[/]",
            default="",
        ).strip()

        if not mandate_id:
            self.console.print(f"[{Colors.DIM}]Cancelled.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        result = self._api_post(
            flags,
            "/admin/revocation/check",
            {"mandate_id": mandate_id},
        )
        self.console.print()
        if result is None:
            self.console.print(f"[{Colors.ERROR}]Gateway request failed.[/]")
        elif result.get("revoked"):
            self.console.print(
                f"[bold {Colors.ERROR}]⛔ Mandate {mandate_id} IS revoked.[/]\n"
                f"Reason: {result.get('reason', 'N/A')}\n"
                f"Revoked at: {result.get('revoked_at', 'unknown')}"
            )
        else:
            self.console.print(
                f"[bold {Colors.SUCCESS}]✓ Mandate {mandate_id} is NOT revoked.[/]"
            )

        Prompt.ask("Press Enter to continue", default="")

    def revoke_mandate(self) -> None:
        self.console.clear()
        flags = get_gateway_features()
        if not flags.gateway_endpoint:
            self.console.print(f"[{Colors.WARNING}]No gateway endpoint configured.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        mandate_id = Prompt.ask(
            f"[bold {Colors.WARNING}]Mandate ID to revoke[/]",
            default="",
        ).strip()
        if not mandate_id:
            Prompt.ask("Press Enter to continue", default="")
            return

        reason = Prompt.ask(
            f"[{Colors.PRIMARY}]Reason for revocation[/]",
            default="Revoked via TUI",
        )
        cascade_input = Prompt.ask(
            f"[{Colors.PRIMARY}]Cascade to delegated children?[/]",
            choices=["y", "n"],
            default="y",
        )

        confirm = Prompt.ask(
            f"\n[bold {Colors.WARNING}]Revoke mandate {mandate_id}?  This cannot be undone.[/]",
            choices=["y", "n"],
            default="n",
        )
        if confirm != "y":
            self.console.print(f"[{Colors.DIM}]Cancelled.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        result = self._api_post(
            flags,
            "/admin/mandates/revoke",
            {
                "mandate_id": mandate_id,
                "reason": reason,
                "cascade": cascade_input == "y",
            },
        )
        self.console.print()
        if result is None:
            self.console.print(f"[{Colors.ERROR}]Revocation request failed.[/]")
        elif result.get("success"):
            self.console.print(
                f"[bold {Colors.SUCCESS}]✓ Mandate {mandate_id} revoked successfully.[/]\n"
                f"Cascaded to: {result.get('cascaded_count', 0)} child mandates."
            )
        else:
            self.console.print(
                f"[{Colors.ERROR}]Revocation failed: {result.get('message', 'Unknown error')}[/]"
            )

        Prompt.ask("Press Enter to continue", default="")

    def show_quota(self) -> None:
        self.console.clear()
        flags = get_gateway_features()
        if not flags.gateway_endpoint:
            self.console.print(f"[{Colors.WARNING}]No gateway endpoint configured.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        result = self._api_get(flags, "/admin/quota/usage")
        self.console.print()
        if result is None:
            self.console.print(f"[{Colors.ERROR}]Failed to fetch quota data.[/]")
        else:
            table = Table(
                title="Quota Usage",
                show_header=True,
                header_style=f"bold {Colors.PRIMARY}",
                border_style=Colors.BORDER,
            )
            table.add_column("Dimension")
            table.add_column("Current", justify="right")
            table.add_column("Limit", justify="right")
            table.add_column("Used %", justify="right")

            for dim, data in result.items():
                current = data.get("current", 0)
                limit = data.get("limit", 1)
                pct = (current / limit * 100) if limit else 0
                pct_color = (
                    Colors.SUCCESS if pct < 70
                    else Colors.WARNING if pct < 90
                    else Colors.ERROR
                )
                table.add_row(
                    dim.replace("_", " ").title(),
                    str(current),
                    str(limit),
                    f"[{pct_color}]{pct:.1f}%[/]",
                )
            self.console.print(table)

        Prompt.ask("Press Enter to continue", default="")

    def show_logs(self) -> None:
        self.console.clear()
        flags = get_gateway_features()
        if not flags.gateway_endpoint:
            self.console.print(f"[{Colors.WARNING}]No gateway endpoint configured.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        result = self._api_get(flags, "/admin/logs?limit=20")
        self.console.print()

        if result is None:
            self.console.print(f"[{Colors.ERROR}]Failed to fetch logs.[/]")
        else:
            logs = result if isinstance(result, list) else result.get("logs", [])
            if not logs:
                self.console.print(f"[{Colors.DIM}]No log entries found.[/]")
            else:
                table = Table(
                    title="Gateway Audit Log (last 20)",
                    show_header=True,
                    header_style=f"bold {Colors.PRIMARY}",
                    border_style=Colors.BORDER,
                )
                table.add_column("Timestamp", max_width=22)
                table.add_column("Type", max_width=20)
                table.add_column("Agent", max_width=16)
                table.add_column("Resource", max_width=24)
                table.add_column("Status", max_width=10)
                table.add_column("Latency", justify="right")

                for entry in logs:
                    st = entry.get("status", "")
                    st_color = Colors.SUCCESS if st == "allowed" else Colors.ERROR
                    table.add_row(
                        (entry.get("timestamp") or "")[:19],
                        entry.get("event_type", "—"),
                        (entry.get("principal_id") or "—")[:16],
                        (entry.get("resource") or "—")[:24],
                        f"[{st_color}]{st}[/]",
                        f"{entry.get('latency_ms', '—')}ms" if entry.get("latency_ms") else "—",
                    )
                self.console.print(table)

        Prompt.ask("Press Enter to continue", default="")

    def disconnect_gateway(self) -> None:
        self.console.clear()
        confirm = Prompt.ask(
            f"[bold {Colors.WARNING}]Remove gateway configuration from this workspace?[/]",
            choices=["y", "n"],
            default="n",
        )
        if confirm != "y":
            self.console.print(f"[{Colors.DIM}]Cancelled.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return

        cfg = load_enterprise_config()
        cfg.pop("gateway", None)
        save_enterprise_config(cfg)
        reset_gateway_features()
        self._flags = None
        self.console.print(f"\n[{Colors.SUCCESS}]✓ Gateway configuration removed.[/]")
        Prompt.ask("Press Enter to continue", default="")

    # ── API helpers ───────────────────────────────────────────────────────────

    def _check_gateway_health(self, endpoint: str) -> None:
        try:
            import httpx
            resp = httpx.get(f"{endpoint}/health", timeout=5)
            if resp.status_code == 200:
                self.console.print(
                    f"[{Colors.SUCCESS}]✓ Gateway reachable: {endpoint}[/]"
                )
            else:
                self.console.print(
                    f"[{Colors.WARNING}]⚠ Gateway responded HTTP {resp.status_code}[/]"
                )
        except Exception as exc:
            self.console.print(
                f"[{Colors.ERROR}]✗ Gateway unreachable: {exc}[/]"
            )

    def _api_get(self, flags: GatewayFeatureFlags, path: str):
        return self._api_call(flags, "GET", path, None)

    def _api_post(self, flags: GatewayFeatureFlags, path: str, body: dict):
        return self._api_call(flags, "POST", path, body)

    def _api_call(self, flags: GatewayFeatureFlags, method: str, path: str, body):
        if not flags.gateway_endpoint:
            return None
        try:
            import httpx
            headers = {}
            if flags.gateway_api_key:
                headers["X-Gateway-Key"] = flags.gateway_api_key
            url = f"{flags.gateway_endpoint.rstrip('/')}{path}"
            if method == "GET":
                resp = httpx.get(url, headers=headers, timeout=10)
            else:
                resp = httpx.post(url, headers=headers, json=body, timeout=10)
            if resp.status_code < 400:
                return resp.json()
            logger.warning("Gateway API error %s %s: %s", method, path, resp.status_code)
            return None
        except Exception as exc:
            logger.error("Gateway API call failed: %s", exc)
            return None


def show_gateway_flow(console: Optional[Console] = None) -> None:
    """Convenience function to show the gateway management flow."""
    GatewayFlow(console).run()
