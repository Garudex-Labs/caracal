"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Provider Manager Screen.

Provides provider management:
- List providers
- Add provider
- Test provider
- Remove provider
- View provider metrics
"""

from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.prompt import Prompt, Confirm

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.components.menu import Menu, MenuItem


def show_provider_manager(console: Console, state: FlowState) -> None:
    """
    Display provider manager interface.
    
    CLI Equivalent: caracal provider [command]
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Provider Manager[/]",
            subtitle=f"[{Colors.HINT}]CLI: caracal provider[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Build menu
        items = [
            MenuItem("list", "List Providers", "View configured providers", Icons.LIST),
            MenuItem("add", "Add Provider", "Configure new provider", Icons.ADD),
            MenuItem("test", "Test Provider", "Check provider connectivity", Icons.TEST),
            MenuItem("metrics", "View Metrics", "Provider usage statistics", Icons.CHART),
            MenuItem("remove", "Remove Provider", "Delete provider configuration", Icons.DELETE),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Provider Operations", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "list":
            _list_providers(console, state)
        elif result.key == "add":
            _add_provider(console, state)
        elif result.key == "test":
            _test_provider(console, state)
        elif result.key == "metrics":
            _view_metrics(console, state)
        elif result.key == "remove":
            _remove_provider(console, state)


def _list_providers(console: Console, state: FlowState) -> None:
    """List all configured providers."""
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.broker import Broker
    from caracal.deployment.gateway_client import GatewayClient
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Configured Providers[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal provider list[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        
        if edition.is_enterprise:
            # Use gateway client
            gateway_client = GatewayClient()
            providers = gateway_client.get_available_providers()
            
            console.print(f"  [{Colors.INFO}]Edition: Enterprise (providers managed by gateway)[/]")
        else:
            # Use broker
            broker = Broker()
            providers = broker.list_providers()
            
            console.print(f"  [{Colors.INFO}]Edition: Open Source (direct provider access)[/]")
        
        console.print()
        
        if not providers:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured[/]")
        else:
            table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
            table.add_column("Name", style=Colors.PRIMARY)
            table.add_column("Type", style=Colors.INFO)
            table.add_column("Status", style=Colors.NEUTRAL)
            table.add_column("Endpoint", style=Colors.DIM)
            
            for provider in providers:
                status_icon = Icons.SUCCESS if provider.status == "healthy" else Icons.ERROR
                status_color = Colors.SUCCESS if provider.status == "healthy" else Colors.ERROR
                status_text = f"[{status_color}]{status_icon} {provider.status}[/]"
                
                table.add_row(
                    provider.name,
                    provider.provider_type,
                    status_text,
                    provider.base_url or "Default"
                )
            
            console.print(table)
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _add_provider(console: Console, state: FlowState) -> None:
    """Add a new provider."""
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.broker import Broker, ProviderConfig
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Add Provider[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal provider add <name> --api-key=<key>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        
        if edition.is_enterprise:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Providers are managed by the gateway in Enterprise edition[/]")
            console.print(f"  [{Colors.HINT}]Contact your administrator to add providers[/]")
            input()
            return
        
        # Prompt for provider details
        name = Prompt.ask(f"[{Colors.INFO}]Provider name[/]")
        
        console.print()
        console.print(f"  [{Colors.INFO}]Select provider type:[/]")
        console.print(f"    1. OpenAI")
        console.print(f"    2. Anthropic")
        console.print(f"    3. Custom")
        console.print()
        
        type_choice = Prompt.ask(
            f"[{Colors.INFO}]Type[/]",
            choices=["1", "2", "3"],
            default="1"
        )
        
        type_map = {
            "1": "openai",
            "2": "anthropic",
            "3": "custom",
        }
        provider_type = type_map.get(type_choice, "openai")
        
        api_key = Prompt.ask(f"[{Colors.INFO}]API Key[/]", password=True)
        
        base_url = None
        if provider_type == "custom":
            base_url = Prompt.ask(f"[{Colors.INFO}]Base URL[/]")
        
        # Create provider config
        config = ProviderConfig(
            name=name,
            provider_type=provider_type,
            api_key_ref="",  # Will be encrypted
            base_url=base_url,
            timeout_seconds=30,
            max_retries=3,
            rate_limit=None,
            metadata={}
        )
        
        # Configure provider
        broker = Broker()
        broker.configure_provider(name, config, api_key=api_key)
        
        console.print()
        console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{name}' added successfully[/]")
        
        state.add_recent_action(RecentAction.create(
            "provider_add",
            f"Added provider: {name}",
            success=True
        ))
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        state.add_recent_action(RecentAction.create(
            "provider_add",
            "Failed to add provider",
            success=False
        ))
    
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _test_provider(console: Console, state: FlowState) -> None:
    """Test provider connectivity."""
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.broker import Broker
    from caracal.deployment.gateway_client import GatewayClient
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Test Provider[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal provider test <name>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        
        # Get list of providers
        if edition.is_enterprise:
            gateway_client = GatewayClient()
            providers = gateway_client.get_available_providers()
        else:
            broker = Broker()
            providers = broker.list_providers()
        
        if not providers:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured[/]")
            input()
            return
        
        # Build menu of providers
        items = []
        for provider in providers:
            items.append(MenuItem(
                provider.name,
                provider.name,
                f"Type: {provider.provider_type}",
                Icons.PROVIDER
            ))
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Provider to Test", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            console.print()
            console.print(f"  [{Colors.INFO}]Testing provider: {result.key}...[/]")
            
            # Test provider
            if edition.is_enterprise:
                health = gateway_client.check_connection()
                success = health.status == "healthy"
            else:
                health = broker.test_provider(result.key)
                success = health.status == "pass"
            
            console.print()
            if success:
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider is healthy[/]")
                console.print(f"    Status: {health.status}")
                console.print(f"    Message: {health.message}")
            else:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Provider test failed[/]")
                console.print(f"    Status: {health.status}")
                console.print(f"    Message: {health.message}")
            
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        input()


def _view_metrics(console: Console, state: FlowState) -> None:
    """View provider metrics."""
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.broker import Broker
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Provider Metrics[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal provider metrics[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        
        if edition.is_enterprise:
            console.print(f"  [{Colors.INFO}]Metrics are available in the gateway dashboard[/]")
            input()
            return
        
        broker = Broker()
        providers = broker.list_providers()
        
        if not providers:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured[/]")
            input()
            return
        
        # Show metrics for each provider
        for provider in providers:
            try:
                metrics = broker.get_provider_metrics(provider.name)
                
                console.print(f"  [{Colors.PRIMARY}]{provider.name}[/]")
                console.print(f"    Requests: {metrics.request_count}")
                console.print(f"    Errors: {metrics.error_count}")
                console.print(f"    Avg Latency: {metrics.avg_latency_ms:.2f}ms")
                console.print(f"    Success Rate: {metrics.success_rate:.1%}")
                console.print()
            except Exception as e:
                console.print(f"  [{Colors.ERROR}]{provider.name}: Error - {e}[/]")
                console.print()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _remove_provider(console: Console, state: FlowState) -> None:
    """Remove a provider."""
    from caracal.deployment.edition import EditionManager
    from caracal.deployment.broker import Broker
    
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Remove Provider[/]",
        subtitle=f"[{Colors.HINT}]CLI: caracal provider remove <name>[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    try:
        edition_mgr = EditionManager()
        edition = edition_mgr.get_edition()
        
        if edition.is_enterprise:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Providers are managed by the gateway in Enterprise edition[/]")
            console.print(f"  [{Colors.HINT}]Contact your administrator to remove providers[/]")
            input()
            return
        
        broker = Broker()
        providers = broker.list_providers()
        
        if not providers:
            console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured[/]")
            input()
            return
        
        # Build menu of providers
        items = []
        for provider in providers:
            items.append(MenuItem(
                provider.name,
                provider.name,
                f"Type: {provider.provider_type}",
                Icons.PROVIDER
            ))
        items.append(MenuItem("back", "Cancel", "", Icons.ARROW_LEFT))
        
        menu = Menu("Select Provider to Remove", items=items)
        result = menu.run()
        
        if result and result.key != "back":
            # Confirm removal
            console.print()
            if Confirm.ask(f"[{Colors.WARNING}]Remove provider '{result.key}'?[/]"):
                broker.remove_provider(result.key)
                
                console.print()
                console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{result.key}' removed[/]")
                
                state.add_recent_action(RecentAction.create(
                    "provider_remove",
                    f"Removed provider: {result.key}",
                    success=True
                ))
            else:
                console.print(f"  [{Colors.DIM}]Cancelled[/]")
            
            console.print()
            console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
            input()
        
    except Exception as e:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Error: {e}[/]")
        input()
