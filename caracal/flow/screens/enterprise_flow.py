"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Enterprise Features Screen.

Displays:
- Available enterprise features
- Upgrade information
- License connection interface
"""

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from caracal.enterprise import EnterpriseLicenseValidator
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons


class EnterpriseFlow:
    """
    Enterprise features screen in Caracal Flow TUI.
    
    Shows available enterprise features and upgrade information.
    Provides interface for connecting with enterprise license.
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
        
        # Define menu items
        items = [
            MenuItem(
                key="features",
                label="View Feature Details",
                description="See detailed information about each enterprise feature",
                icon=Icons.INFO,
            ),
            MenuItem(
                key="connect",
                label="Connect Enterprise License",
                description="Enter enterprise license token to activate features",
                icon="🔑",
            ),
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
        ]
        
        # Create menu
        menu = Menu(
            title="Caracal Enterprise",
            items=items,
            show_hints=True,
        )
        
        # Display feature panel before menu
        self.console.clear()
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
        Attempt to connect to enterprise service with license token.
        """
        self.console.clear()
        
        # Display connection information
        info_panel = Panel(
            f"[bold]Connect Enterprise License[/bold]\n\n"
            f"Enter your Caracal Enterprise license token to activate enterprise features.\n\n"
            f"License tokens are provided when you purchase Caracal Enterprise.\n"
            f"If you don't have a license token, visit [{Colors.LINK}]https://garudexlabs.com[/]\n"
            f"or contact [{Colors.LINK}]support@garudexlabs.com[/] for more information.",
            border_style=Colors.PRIMARY,
            padding=(1, 2),
        )
        self.console.print(info_panel)
        self.console.print()
        
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
        
        # Validate license
        self.console.print(f"\n[{Colors.DIM}]Validating license...[/]")
        result = self.validator.validate_license(
            license_token,
            password=license_password or None,
        )
        
        self.console.print()
        
        if result.valid:
            # This path is only reachable in actual enterprise edition
            success_panel = Panel(
                f"[bold {Colors.SUCCESS}]✓ Enterprise license validated successfully![/]\n\n"
                f"Features available: {', '.join(result.features_available)}\n"
                f"License expires: {result.expires_at.strftime('%Y-%m-%d') if result.expires_at else 'Never'}",
                border_style=Colors.SUCCESS,
                padding=(1, 2),
            )
            self.console.print(success_panel)
        else:
            # In open source, always shows this message
            error_panel = Panel(
                f"[bold {Colors.ERROR}]License Validation Failed[/]\n\n"
                f"{result.message}",
                border_style=Colors.ERROR,
                padding=(1, 2),
            )
            self.console.print(error_panel)
        
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
