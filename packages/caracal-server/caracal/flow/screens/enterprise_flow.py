"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Enterprise Features Screen.

Displays:
- Available enterprise features
- Upgrade information
- License connection interface
- Enterprise sync controls
- Connection status & API key display
"""

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from caracal.deployment.enterprise_license import EnterpriseLicenseValidator
from caracal.deployment.enterprise_runtime import (
    _resolve_api_url,
    load_enterprise_config,
)
from caracal.deployment.exceptions import MigrationError
from caracal.logging_config import get_logger
from caracal.core.gateway_features import get_gateway_features
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons

logger = get_logger(__name__)


class EnterpriseFlow:
    """
    Enterprise features screen in Caracal Flow TUI.
    
    Shows available enterprise features and upgrade information.
    Provides interface for connecting with enterprise license,
    syncing local data to Enterprise dashboard, and managing
    the sync API key.
    """
    
    def __init__(self, console: Optional[Console] = None):
        """
        Initialize enterprise flow.
        
        Args:
            console: Rich console instance (creates new if not provided)
        """
        self.console = console or Console()
        self.validator = EnterpriseLicenseValidator()
    
    def show_enterprise_menu(self) -> Optional[str]:
        """
        Display enterprise features menu.
        
        Returns:
            Selected action key or None
        """
        # Create feature information panel
        feature_info = self._create_feature_panel()
        
        # Build menu items dynamically based on connection state
        items = [
            MenuItem(
                key="features",
                label="View Feature Details",
                description="See detailed information about each enterprise feature",
                icon="",
            ),
        ]
        
        if self.validator.is_connected():
            items.extend([
                MenuItem(
                    key="gateway",
                    label="API Gateway",
                    description="Connect and manage enterprise gateway enforcement",
                    icon="",
                ),
                MenuItem(
                    key="secrets",
                    label="Secret Vault",
                    description="Manage CaracalVault-backed secret refs",
                    icon="",
                ),
                MenuItem(
                    key="status",
                    label="Connection Status",
                    description="View license details and sync API key",
                    icon="",
                ),
                MenuItem(
                    key="disconnect",
                    label="Disconnect License",
                    description="Remove enterprise license from this workspace",
                    icon="",
                ),
            ])
        else:
            items.append(
                MenuItem(
                    key="connect",
                    label="Connect Enterprise License",
                    description="Enter enterprise license token to activate features and enable sync",
                    icon="",
                ),
            )
        
        items.extend([
            MenuItem(
                key="contact",
                label="Contact Sales",
                description="Get information about purchasing Caracal Enterprise",
                icon="",
            ),
            MenuItem(
                key="back",
                label="Back to Main Menu",
                description="Return to main menu",
                icon=Icons.ARROW_LEFT,
            ),
        ])
        
        # Create menu
        menu = Menu(
            title="Caracal Enterprise",
            items=items,
            show_hints=True,
        )
        
        # Display feature panel before menu
        self.console.clear()
        
        # Show connection status bar if connected
        if self.validator.is_connected():
            info = self.validator.get_license_info()
            flags = get_gateway_features(reload=True)
            if flags.gateway_enabled:
                mode_label = (
                    "Managed" if flags.deployment_type == "managed"
                    else "On-Prem" if flags.deployment_type == "on_prem"
                    else flags.deployment_type
                )
                gateway_status = f"[bold {Colors.SUCCESS}]● Gateway: {mode_label}[/]"
            else:
                gateway_status = f"[{Colors.DIM}]○ Gateway: not synced[/]"
            tier = (info.get("tier") or "unknown").upper()
            self.console.print(
                f"[bold {Colors.SUCCESS}]● Connected[/] — "
                f"[{Colors.PRIMARY}]{tier}[/] tier  |  "
                f"Features: [{Colors.PRIMARY}]{', '.join(info.get('features_available', [])) or 'none'}[/]  |  "
                f"{gateway_status}"
            )
            self.console.print()
        
        self.console.print(feature_info)
        self.console.print()
        
        # Run menu
        result = menu.run()
        
        if result:
            return result.key
        
        return None
    
    def _create_feature_panel(self) -> Panel:
        """
        Create panel with enterprise feature information.
        
        Returns:
            Rich Panel with feature information
        """
        content = Text()
        content.append("The following features are available with ", style=Colors.TEXT)
        content.append("Caracal Enterprise", style=f"bold {Colors.PRIMARY}")
        content.append(":\n\n", style=Colors.TEXT)
        
        features = [
            (
                "Centralized Authority Control",
                "Manage principals, policies, mandates, and revocations from one dashboard",
            ),
            (
                "Enterprise Sync + Gateway Enforcement",
                "Sync local workspaces to Enterprise and enforce decisions through the gateway",
            ),
            (
                "Identity and Access Controls",
                "Enterprise SSO and role-based access for operators and reviewers",
            ),
            (
                "Compliance and Audit Readiness",
                "Immutable authority trails and compliance-focused reporting workflows",
            ),
            (
                "Workspace Isolation",
                "Strong tenant/workspace boundaries for multi-team operations",
            ),
            (
                "Operational Insights",
                "Authority usage trends, anomaly signals, and policy health visibility",
            ),
        ]
        
        for i, (name, description) in enumerate(features, 1):
            content.append(f"  {i}. ", style=Colors.DIM)
            content.append(f"{name}\n", style=f"bold {Colors.PRIMARY}")
            content.append(f"     {description}\n", style=Colors.DIM)
            if i < len(features):
                content.append("\n")
        
        content.append("\n")
        content.append("Learn More: ", style="bold")
        content.append("https://docs.garudexlabs.com/caracalEnterprise\n", style=Colors.LINK)
        content.append("Enterprise Sales: ", style="bold")
        content.append("https://cal.com/rawx18/caracal-enterprise-sales", style=Colors.LINK)
        
        return Panel(
            content,
            title="[bold]Enterprise Edition[/bold]",
            border_style=Colors.WARNING,
            padding=(1, 2),
        )
    
    def show_feature_details(self) -> None:
        """
        Display detailed information about enterprise features.
        """
        self.console.clear()
        
        # Create table with feature details
        table = Table(
            title="Enterprise Features",
            show_header=True,
            header_style=f"bold {Colors.PRIMARY}",
            border_style=Colors.BORDER,
        )
        
        table.add_column("Feature", style=f"bold {Colors.PRIMARY}")
        table.add_column("Description", style=Colors.TEXT)
        table.add_column("Documentation", style=Colors.LINK)
        
        features = [
            (
                "Centralized Authority Control",
                "Operate principals, authority policies, mandate lifecycle, and revocations from a unified Enterprise control plane.",
                "docs.garudexlabs.com/caracalEnterprise/features",
            ),
            (
                "Enterprise Sync + Gateway Enforcement",
                "Connect local Caracal workspaces to Enterprise and enforce provider traffic through gateway-managed authority checks.",
                "docs.garudexlabs.com/caracalEnterprise/guides/gatewayDeployment",
            ),
            (
                "Identity and Access Controls",
                "Enable SSO and role-oriented access patterns so admins, operators, and auditors get scoped permissions.",
                "docs.garudexlabs.com/caracalEnterprise/guides/usage",
            ),
            (
                "Compliance and Audit Readiness",
                "Maintain tamper-evident authority records and generate reporting artifacts for internal and external compliance workflows.",
                "docs.garudexlabs.com/caracalEnterprise/features",
            ),
            (
                "Workspace Isolation",
                "Run multi-team and multi-workspace deployments with explicit boundaries for policy scope, data visibility, and operational ownership.",
                "docs.garudexlabs.com/caracalEnterprise/architecture",
            ),
            (
                "Operational Insights",
                "Track authority activity, policy effectiveness, and anomaly signals to improve reliability and governance.",
                "docs.garudexlabs.com/caracalEnterprise/features",
            ),
        ]
        
        for name, description, docs in features:
            table.add_row(name, description, docs)
        
        self.console.print(table)
        self.console.print()
        
        # Show upgrade information
        upgrade_panel = Panel(
            f"[bold]Ready to upgrade?[/bold]\n\n"
            f"Visit [{Colors.LINK}]https://docs.garudexlabs.com/caracalEnterprise[/] for details\n"
            f"or book a call at [{Colors.LINK}]https://cal.com/rawx18/caracal-enterprise-sales[/].",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(upgrade_panel)
        self.console.print()
        
        Prompt.ask("Press Enter to continue", default="")
    
    def connect_enterprise(self) -> None:
        """
        Connect to enterprise service with license token.
        
        Validates the license against the Enterprise API, persists
        the license key and sync API key to the workspace, and
        enables explicit enterprise management actions.
        """
        self.console.clear()
        
        # Display connection information
        info_panel = Panel(
            f"[bold]Connect Enterprise License[/bold]\n\n"
            f"Enter your Caracal Enterprise license token to activate enterprise features\n"
            f"and unlock explicit Enterprise sync and gateway management actions.\n\n"
            f"License tokens are found in your Enterprise dashboard under\n"
            f"[bold]Settings → Plan & Billing → Enterprise License Token[/bold].\n\n"
            f"If you don't have a license token, visit [{Colors.LINK}]https://garudexlabs.com[/]\n"
            f"or contact [{Colors.LINK}]support@garudexlabs.com[/] for more information.",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(info_panel)
        self.console.print()
        
        enterprise_url = _resolve_api_url()
        
        # Prompt for license token
        license_token = Prompt.ask(
            f"[{Colors.PRIMARY}]Enter enterprise license token[/]",
            default="",
        )
        
        if not license_token:
            self.console.print(f"[{Colors.WARNING}]No license token provided.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return
        
        # Validate license via Enterprise API
        self.console.print(f"\n[{Colors.DIM}]Connecting to Enterprise API at {enterprise_url}...[/]")
        
        # Update the validator's API URL
        self.validator = EnterpriseLicenseValidator(enterprise_api_url=enterprise_url)
        
        result = self.validator.validate_license(license_token)
        
        self.console.print()
        
        if result.valid:
            # Build success message with details
            features_str = ", ".join(result.features_available) if result.features_available else "None"
            expires_str = result.expires_at.strftime("%Y-%m-%d") if result.expires_at else "Never"
            tier_str = (result.tier or "unknown").upper()
            
            success_lines = [
                f"[bold {Colors.SUCCESS}]✓ Enterprise license validated successfully![/]\n",
                f"[bold]Tier:[/]     {tier_str}",
                f"[bold]Features:[/] {features_str}",
                f"[bold]Expires:[/]  {expires_str}",
            ]
            
            if result.sync_api_key:
                # Mask the API key for display
                key = result.sync_api_key
                masked = key[:8] + "..." + key[-4:] if len(key) > 12 else key
                success_lines.append(f"\n[bold]Sync API Key:[/] {masked}")
                success_lines.append(
                    f"[{Colors.DIM}]This key is stored in your workspace and used for[/]"
                )
                success_lines.append(
                    f"[{Colors.DIM}]explicit Enterprise sync and gateway management actions.[/]"
                )
            
            success_panel = Panel(
                "\n".join(success_lines),
                title="[bold]License Connected[/bold]",
                border_style=Colors.SUCCESS,
                padding=(1, 2),
            )
            self.console.print(success_panel)

            self.console.print(
                f"\n[{Colors.DIM}]Gateway configuration is not pulled automatically in hard-cut mode.[/]"
            )
            self.console.print(
                f"[{Colors.DIM}]Use Enterprise → API Gateway when you want to sync gateway settings explicitly.[/]"
            )
        else:
            # Show detailed error with troubleshooting
            error_lines = [
                f"[bold {Colors.ERROR}]License Validation Failed[/]\n",
                f"{result.message}\n",
            ]
            
            # Add troubleshooting tips based on the error
            if "unreachable" in result.message.lower() or "cannot reach" in result.message.lower():
                error_lines.append(f"[bold]Troubleshooting:[/]")
                error_lines.append(f"  • Ensure the Enterprise API is running at {enterprise_url}")
                error_lines.append(f"  • Check your network connection")
                error_lines.append(f"  • Try: curl {enterprise_url}/health")
                error_lines.append(
                    "  • If running `caracal flow` in container mode, localhost points to the container. "
                    "Start Enterprise API with `--host 0.0.0.0` so it is reachable from the runtime container"
                )
            elif "not found" in result.message.lower():
                error_lines.append(f"[bold]Troubleshooting:[/]")
                error_lines.append(f"  • Verify the license token in Enterprise dashboard → Settings")
                error_lines.append(f"  • Ensure the Enterprise API URL is correct")
                error_lines.append(f"  • Copy the exact token from the dashboard (including the 'ent-' prefix)")
            elif "expired" in result.message.lower():
                error_lines.append(f"[bold]Troubleshooting:[/]")
                error_lines.append(f"  • Your license has expired")
                error_lines.append(f"  • Visit https://garudexlabs.com to renew")
            
            error_panel = Panel(
                "\n".join(error_lines),
                title="[bold]Connection Failed[/bold]",
                border_style=Colors.ERROR,
                padding=(1, 2),
            )
            self.console.print(error_panel)
        
        self.console.print()
        Prompt.ask("Press Enter to continue", default="")
    
    def show_connection_status(self) -> None:
        """Show current license details, sync API key, and sync status."""
        self.console.clear()
        
        info = self.validator.get_license_info()
        cfg = load_enterprise_config()
        
        if not info.get("license_active"):
            self.console.print(Panel(
                f"[{Colors.WARNING}]No enterprise license connected.[/]\n\n"
                f"Use 'Connect Enterprise License' to get started.",
                border_style=Colors.WARNING,
                padding=(1, 2),
            ))
            Prompt.ask("Press Enter to continue", default="")
            return
        
        # License info table
        table = Table(
            title="Enterprise License",
            show_header=False,
            border_style=Colors.PRIMARY,
            padding=(0, 2),
        )
        table.add_column("Key", style=f"bold {Colors.DIM}")
        table.add_column("Value", style=Colors.TEXT)
        
        tier = (info.get("tier") or "unknown").upper()
        table.add_row("Tier", f"[bold {Colors.PRIMARY}]{tier}[/]")
        table.add_row("License Key", info.get("license_key", "N/A"))
        table.add_row("Features", ", ".join(info.get("features_available", [])) or "None")
        table.add_row("Expires", info.get("expires_at", "Never"))
        table.add_row("API URL", info.get("enterprise_api_url", "N/A"))

        self.console.print(table)
        self.console.print()

        # Check Enterprise API reachability
        api_url = info.get("enterprise_api_url")
        if api_url:
            try:
                import requests as _req
                resp = _req.get(f"{api_url.rstrip('/')}/health", timeout=5)
                if resp.ok:
                    self.console.print(f"[{Colors.SUCCESS}]✓ Enterprise API reachable[/]")
                else:
                    self.console.print(f"[{Colors.WARNING}]⚠ Enterprise API not reachable[/]")
            except Exception as exc:
                logger.debug("Could not check Enterprise API connectivity", exc_info=True)
                self.console.print(f"[{Colors.DIM}]Could not check API connectivity[/]")
        
        self.console.print()
        Prompt.ask("Press Enter to continue", default="")
    
    def disconnect_license(self) -> None:
        """Disconnect enterprise license from this workspace."""
        self.console.clear()
        
        info = self.validator.get_license_info()
        
        warning_panel = Panel(
            f"[bold {Colors.WARNING}]Disconnect Enterprise License[/]\n\n"
            f"This will remove the enterprise license and switch this workspace to Open Source mode.\n\n"
            f"[bold]Current license:[/]\n"
            f"  Key: {info.get('license_key', 'N/A')}\n"
            f"  Tier: {(info.get('tier') or 'unknown').upper()}\n\n"
            f"[bold]Security policy:[/]\n"
            f"  Fresh start in Open Source mode (no local secret migration by default).\n\n"
            f"[{Colors.DIM}]You can reconnect at any time using the same license token.[/]\n"
            f"[{Colors.DIM}]Your Enterprise dashboard data will not be affected.[/]",
            border_style=Colors.WARNING,
            padding=(1, 2),
        )
        self.console.print(warning_panel)
        self.console.print()
        
        confirm = Prompt.ask(
            f"[{Colors.WARNING}]Are you sure you want to disconnect?[/]",
            choices=["y", "n"],
            default="n",
        )
        
        if confirm == "y":
            try:
                from caracal.deployment.edition import Edition
                from caracal.deployment.migration import MigrationManager

                try:
                    MigrationManager().migrate_edition(
                        Edition.OPENSOURCE,
                        migrate_api_keys=False,
                    )
                except MigrationError as exc:
                    # Already on target edition: safe to proceed with license clear.
                    if "Already running" not in str(exc):
                        raise

                self.validator.disconnect()
                self.console.print(f"\n[{Colors.SUCCESS}]Enterprise license disconnected.[/]")
                self.console.print(f"[{Colors.INFO}]Edition is now Open Source (fresh start policy).[/]")
            except Exception as exc:
                self.console.print(f"\n[{Colors.ERROR}]Failed to disconnect enterprise cleanly: {exc}[/]")
        else:
            self.console.print(f"\n[{Colors.DIM}]Cancelled.[/]")
        
        self.console.print()
        Prompt.ask("Press Enter to continue", default="")
    
    def show_contact_info(self) -> None:
        """
        Display contact information for enterprise sales.
        """
        self.console.clear()
        
        contact_panel = Panel(
            f"[bold]Contact Caracal Enterprise Sales[/bold]\n\n"
            f"[bold]Website:[/] [{Colors.LINK}]https://garudexlabs.com[/]\n"
            f"[bold]Email:[/] [{Colors.LINK}]support@garudexlabs.com[/]\n\n"
            f"[bold]What to expect:[/]\n"
            f"  • Schedule a personalized demo\n"
            f"  • Discuss your organization's needs\n"
            f"  • Get custom pricing information\n"
            f"  • Learn about deployment options\n"
            f"  • Understand support and SLA options\n\n"
            f"[bold]Typical response time:[/] Within 1 business day",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(contact_panel)
        self.console.print()
        
        Prompt.ask("Press Enter to continue", default="")
    
    def run(self) -> None:
        """
        Run the enterprise flow.
        
        Main loop for enterprise features screen.
        """
        while True:
            action = self.show_enterprise_menu()
            
            if action == "features":
                self.show_feature_details()
            elif action == "gateway":
                from caracal.flow.screens.gateway_flow import show_gateway_flow
                show_gateway_flow(self.console)
            elif action == "secrets":
                from caracal.flow.screens.secrets_flow import SecretsFlow
                # Derive tier/org from enterprise config if available (never raises; returns {} on failure).
                cfg = load_enterprise_config()
                tier = str(cfg.get("tier") or "starter")
                workspace_id = str(cfg.get("workspace_id") or "")
                SecretsFlow(tier=tier, workspace_id=workspace_id, console=self.console).show()
            elif action == "connect":
                self.connect_enterprise()
            elif action == "status":
                self.show_connection_status()
            elif action == "disconnect":
                self.disconnect_license()
            elif action == "contact":
                self.show_contact_info()
            elif action == "back" or action is None:
                break


def show_enterprise_flow(console: Optional[Console] = None) -> None:
    """
    Show enterprise features flow.
    
    Convenience function for displaying the enterprise flow.
    
    Args:
        console: Rich console instance (creates new if not provided)
    """
    flow = EnterpriseFlow(console)
    flow.run()
