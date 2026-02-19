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

from caracal.enterprise import EnterpriseLicenseValidator
from caracal.enterprise.license import load_enterprise_config
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons


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
                icon=Icons.INFO,
            ),
        ]
        
        if self.validator.is_connected():
            items.extend([
                MenuItem(
                    key="status",
                    label="Connection Status",
                    description="View license details, sync API key, and sync status",
                    icon="🔗",
                ),
                MenuItem(
                    key="sync",
                    label="Sync to Enterprise",
                    description="Push local data (principals, policies, mandates) to Enterprise dashboard",
                    icon="🔄",
                ),
                MenuItem(
                    key="disconnect",
                    label="Disconnect License",
                    description="Remove enterprise license from this workspace",
                    icon="🔓",
                ),
            ])
        else:
            items.append(
                MenuItem(
                    key="connect",
                    label="Connect Enterprise License",
                    description="Enter enterprise license token to activate features and enable sync",
                    icon="🔑",
                ),
            )
        
        items.extend([
            MenuItem(
                key="contact",
                label="Contact Sales",
                description="Get information about purchasing Caracal Enterprise",
                icon="📧",
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
            tier = (info.get("tier") or "unknown").upper()
            self.console.print(
                f"[bold {Colors.SUCCESS}]● Connected[/] — "
                f"[{Colors.PRIMARY}]{tier}[/] tier  |  "
                f"Features: [{Colors.PRIMARY}]{', '.join(info.get('features_available', [])) or 'none'}[/]"
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
            ("SSO Integration", "SAML, OIDC, Okta, Azure AD, Google Workspace"),
            ("Advanced Analytics", "Real-time dashboard, anomaly detection, usage patterns"),
            ("Workflow Automation", "Event-driven automation, custom workflows"),
            ("Compliance Reporting", "SOC 2, ISO 27001, GDPR, HIPAA reports"),
            ("Multi-Tenancy", "Tenant isolation, per-tenant configuration"),
            ("Priority Support", "24/7 support, dedicated engineer, SLA guarantees"),
        ]
        
        for i, (name, description) in enumerate(features, 1):
            content.append(f"  {i}. ", style=Colors.DIM)
            content.append(f"{name}\n", style=f"bold {Colors.PRIMARY}")
            content.append(f"     {description}\n", style=Colors.DIM)
            if i < len(features):
                content.append("\n")
        
        content.append("\n")
        content.append("Learn More: ", style="bold")
        content.append("https://garudexlabs.com\n", style=Colors.LINK)
        content.append("Contact Sales: ", style="bold")
        content.append("support@garudexlabs.com", style=Colors.LINK)
        
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
                "SSO Integration",
                "Single Sign-On with SAML 2.0, OIDC/OAuth 2.0, Okta, Azure AD, Google Workspace",
                "docs.garudexlabs.com/enterprise/sso",
            ),
            (
                "Advanced Analytics",
                "Real-time analytics dashboard, anomaly detection, usage pattern analysis, predictive insights",
                "docs.garudexlabs.com/enterprise/analytics",
            ),
            (
                "Workflow Automation",
                "Event-driven automation, custom workflow definitions, scheduled tasks, external integrations",
                "docs.garudexlabs.com/enterprise/workflows",
            ),
            (
                "Compliance Reporting",
                "SOC 2, ISO 27001, GDPR, HIPAA compliance reports, automated compliance checks",
                "docs.garudexlabs.com/enterprise/compliance",
            ),
            (
                "Multi-Tenancy",
                "Tenant isolation, per-tenant configuration, cross-tenant analytics, tenant management API",
                "docs.garudexlabs.com/enterprise/multi-tenancy",
            ),
            (
                "Priority Support",
                "24/7 support access, dedicated support engineer, SLA guarantees, direct escalation",
                "docs.garudexlabs.com/enterprise/support",
            ),
        ]
        
        for name, description, docs in features:
            table.add_row(name, description, docs)
        
        self.console.print(table)
        self.console.print()
        
        # Show upgrade information
        upgrade_panel = Panel(
            f"[bold]Ready to upgrade?[/bold]\n\n"
            f"Visit [{Colors.LINK}]https://garudexlabs.com[/] to learn more\n"
            f"or contact [{Colors.LINK}]support@garudexlabs.com[/] for a demo.",
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
        enables automatic sync.
        """
        self.console.clear()
        
        # Display connection information
        info_panel = Panel(
            f"[bold]Connect Enterprise License[/bold]\n\n"
            f"Enter your Caracal Enterprise license token to activate enterprise features\n"
            f"and enable automatic sync between your local CLI and the Enterprise dashboard.\n\n"
            f"License tokens are found in your Enterprise dashboard under\n"
            f"[bold]Settings → Plan & Billing → Enterprise License Token[/bold].\n\n"
            f"If you don't have a license token, visit [{Colors.LINK}]https://garudexlabs.com[/]\n"
            f"or contact [{Colors.LINK}]support@garudexlabs.com[/] for more information.",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(info_panel)
        self.console.print()
        
        # Prompt for Enterprise API URL (with default)
        enterprise_url = Prompt.ask(
            f"[{Colors.PRIMARY}]Enterprise API URL[/]",
            default="http://localhost:8000",
        )
        
        # Prompt for license token
        license_token = Prompt.ask(
            f"[{Colors.PRIMARY}]Enter enterprise license token[/]",
            default="",
        )
        
        if not license_token:
            self.console.print(f"[{Colors.WARNING}]No license token provided.[/]")
            Prompt.ask("Press Enter to continue", default="")
            return
        
        # Prompt for license password (optional)
        license_password = Prompt.ask(
            f"[{Colors.PRIMARY}]Enter license password (leave blank if none)[/]",
            default="",
            password=True,
        )
        
        # Validate license via Enterprise API
        self.console.print(f"\n[{Colors.DIM}]Connecting to Enterprise API at {enterprise_url}...[/]")
        
        # Update the validator's API URL
        self.validator = EnterpriseLicenseValidator(enterprise_api_url=enterprise_url)
        
        result = self.validator.validate_license(
            license_token,
            password=license_password or None,
        )
        
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
                    f"[{Colors.DIM}]This key is stored in your workspace and will be used[/]"
                )
                success_lines.append(
                    f"[{Colors.DIM}]for automatic sync between CLI and Enterprise dashboard.[/]"
                )
            
            success_panel = Panel(
                "\n".join(success_lines),
                title="[bold]License Connected[/bold]",
                border_style=Colors.SUCCESS,
                padding=(1, 2),
            )
            self.console.print(success_panel)
            
            # Offer to sync now
            self.console.print()
            do_sync = Prompt.ask(
                f"[{Colors.PRIMARY}]Sync local data to Enterprise now?[/]",
                choices=["y", "n"],
                default="y",
            )
            
            if do_sync == "y":
                self._do_sync()
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
            elif "password" in result.message.lower():
                error_lines.append(f"[bold]Troubleshooting:[/]")
                error_lines.append(f"  • This license requires a password")
                error_lines.append(f"  • Set the password in Enterprise dashboard → Settings → Plan & Billing")
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
        
        # Sync API key
        api_key = info.get("sync_api_key")
        if api_key:
            masked = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else api_key
            table.add_row("Sync API Key", masked)
        else:
            table.add_row("Sync API Key", f"[{Colors.WARNING}]Not generated[/]")
        
        # Last sync info
        last_sync = cfg.get("last_sync")
        if last_sync:
            table.add_row("Last Sync", last_sync.get("timestamp", "Unknown"))
            counts = last_sync.get("counts", {})
            counts_str = ", ".join(f"{k}: {v}" for k, v in counts.items() if v)
            table.add_row("Last Sync Counts", counts_str or "No data synced")
        else:
            table.add_row("Last Sync", f"[{Colors.DIM}]Never[/]")
        
        self.console.print(table)
        self.console.print()
        
        # Try to get remote sync status
        try:
            from caracal.enterprise.sync import EnterpriseSyncClient
            client = EnterpriseSyncClient()
            if client.test_connection():
                self.console.print(f"[{Colors.SUCCESS}]✓ Enterprise API reachable[/]")
            else:
                self.console.print(f"[{Colors.WARNING}]⚠ Enterprise API not reachable[/]")
        except Exception:
            self.console.print(f"[{Colors.DIM}]Could not check API connectivity[/]")
        
        self.console.print()
        Prompt.ask("Press Enter to continue", default="")
    
    def sync_to_enterprise(self) -> None:
        """Push local data to Enterprise dashboard."""
        self.console.clear()
        
        sync_panel = Panel(
            f"[bold]Sync to Enterprise[/bold]\n\n"
            f"This will push your local principals, policies, mandates, and ledger\n"
            f"entries to the Enterprise dashboard for visualization and management.\n\n"
            f"[{Colors.DIM}]Existing data on the Enterprise side will not be overwritten.[/]",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(sync_panel)
        self.console.print()
        
        confirm = Prompt.ask(
            f"[{Colors.PRIMARY}]Proceed with sync?[/]",
            choices=["y", "n"],
            default="y",
        )
        
        if confirm == "y":
            self._do_sync()
        
        self.console.print()
        Prompt.ask("Press Enter to continue", default="")
    
    def _do_sync(self) -> None:
        """Internal: run the actual sync and display results."""
        self.console.print(f"\n[{Colors.DIM}]Syncing local data to Enterprise...[/]")
        
        try:
            from caracal.enterprise.sync import EnterpriseSyncClient
            client = EnterpriseSyncClient()
            result = client.sync()
            
            self.console.print()
            
            if result.success:
                counts = result.synced_counts
                counts_lines = []
                for entity, count in counts.items():
                    label = entity.replace("_", " ").title()
                    counts_lines.append(f"  {label}: {count}")
                
                success_panel = Panel(
                    f"[bold {Colors.SUCCESS}]✓ Sync completed successfully![/]\n\n"
                    + "\n".join(counts_lines) + "\n\n"
                    + f"[{Colors.DIM}]{result.message}[/]",
                    border_style=Colors.SUCCESS,
                    padding=(1, 2),
                )
                self.console.print(success_panel)
                
                if result.errors:
                    self.console.print(f"\n[{Colors.WARNING}]Warnings ({len(result.errors)}):[/]")
                    for err in result.errors[:5]:
                        self.console.print(f"  [{Colors.WARNING}]• {err}[/]")
                    if len(result.errors) > 5:
                        self.console.print(f"  [{Colors.DIM}]... and {len(result.errors) - 5} more[/]")
            else:
                error_panel = Panel(
                    f"[bold {Colors.ERROR}]Sync Failed[/]\n\n{result.message}",
                    border_style=Colors.ERROR,
                    padding=(1, 2),
                )
                self.console.print(error_panel)
                
        except Exception as exc:
            self.console.print(f"\n[{Colors.ERROR}]Sync error: {exc}[/]")
    
    def disconnect_license(self) -> None:
        """Disconnect enterprise license from this workspace."""
        self.console.clear()
        
        info = self.validator.get_license_info()
        
        warning_panel = Panel(
            f"[bold {Colors.WARNING}]Disconnect Enterprise License[/bold]\n\n"
            f"This will remove the enterprise license from this workspace.\n\n"
            f"[bold]Current license:[/]\n"
            f"  Key: {info.get('license_key', 'N/A')}\n"
            f"  Tier: {(info.get('tier') or 'unknown').upper()}\n\n"
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
            self.validator.disconnect()
            self.console.print(f"\n[{Colors.SUCCESS}]Enterprise license disconnected.[/]")
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
            elif action == "connect":
                self.connect_enterprise()
            elif action == "status":
                self.show_connection_status()
            elif action == "sync":
                self.sync_to_enterprise()
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
