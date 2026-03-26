"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Deployment Help Screen.

Provides help and documentation:
- Command reference with CLI equivalents
- Quick start guide
- Troubleshooting tips
- Architecture overview
"""

from typing import Optional
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.markdown import Markdown

from caracal.flow.theme import Colors, Icons
from caracal.flow.state import FlowState
from caracal.flow.components.menu import Menu, MenuItem


def show_deployment_help(console: Console, state: FlowState) -> None:
    """
    Display deployment help interface.
    
    Shows CLI equivalents for all TUI operations.
    """
    while True:
        console.clear()
        
        # Show header
        console.print(Panel(
            f"[{Colors.PRIMARY}]Deployment Help[/]",
            subtitle=f"[{Colors.HINT}]Command reference and guides[/]",
            border_style=Colors.INFO,
        ))
        console.print()
        
        # Build menu
        items = [
            MenuItem("commands", "Command Reference", "TUI to CLI mapping", Icons.INFO),
            MenuItem("quickstart", "Quick Start Guide", "Getting started", Icons.GUIDE),
            MenuItem("troubleshoot", "Troubleshooting", "Common issues", Icons.WARNING),
            MenuItem("architecture", "Architecture Overview", "System design", Icons.ARCHITECTURE),
            MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
        ]
        
        menu = Menu("Help Topics", items=items)
        result = menu.run()
        
        if not result or result.key == "back":
            break
        
        # Handle selection
        if result.key == "commands":
            _show_command_reference(console)
        elif result.key == "quickstart":
            _show_quickstart(console)
        elif result.key == "troubleshoot":
            _show_troubleshooting(console)
        elif result.key == "architecture":
            _show_architecture(console)


def _show_command_reference(console: Console) -> None:
    """Show command reference with CLI equivalents."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Command Reference[/]",
        subtitle=f"[{Colors.HINT}]TUI operations and their CLI equivalents[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    # Workspace commands
    console.print(f"  [{Colors.INFO}]Workspace Management:[/]")
    console.print()
    
    workspace_table = Table(show_header=True, header_style=f"bold {Colors.INFO}", box=None)
    workspace_table.add_column("TUI Operation", style=Colors.PRIMARY)
    workspace_table.add_column("CLI Equivalent", style=Colors.DIM)
    
    workspace_table.add_row("List Workspaces", "caracal workspace list")
    workspace_table.add_row("Create Workspace", "caracal workspace create <name>")
    workspace_table.add_row("Switch Workspace", "caracal workspace switch <name>")
    workspace_table.add_row("Delete Workspace", "caracal workspace delete <name>")
    workspace_table.add_row("Export Workspace", "caracal workspace export <name> <path>")
    workspace_table.add_row("Import Workspace", "caracal workspace import <path>")
    
    console.print(workspace_table)
    console.print()
    
    # Sync commands
    console.print(f"  [{Colors.INFO}]Sync Management:[/]")
    console.print()
    
    sync_table = Table(show_header=True, header_style=f"bold {Colors.INFO}", box=None)
    sync_table.add_column("TUI Operation", style=Colors.PRIMARY)
    sync_table.add_column("CLI Equivalent", style=Colors.DIM)
    
    sync_table.add_row("View Sync Status", "caracal sync status")
    sync_table.add_row("Connect Sync", "caracal sync connect <url> <token>")
    sync_table.add_row("Disconnect Sync", "caracal sync disconnect")
    sync_table.add_row("Sync Now", "caracal sync now")
    sync_table.add_row("View Conflicts", "caracal sync conflicts")
    sync_table.add_row("Enable Auto-Sync", "caracal sync auto-enable --interval=<seconds>")
    sync_table.add_row("Disable Auto-Sync", "caracal sync auto-disable")
    
    console.print(sync_table)
    console.print()
    
    # Configuration commands
    console.print(f"  [{Colors.INFO}]Configuration:[/]")
    console.print()
    
    config_table = Table(show_header=True, header_style=f"bold {Colors.INFO}", box=None)
    config_table.add_column("TUI Operation", style=Colors.PRIMARY)
    config_table.add_column("CLI Equivalent", style=Colors.DIM)
    
    config_table.add_row("View Configuration", "caracal config list")
    config_table.add_row("Set Mode", "caracal config mode [dev|user]")
    config_table.add_row("Edition (Auto)", "caracal config edition")
    config_table.add_row("Set Config Value", "caracal config set <key> <value>")
    config_table.add_row("Get Config Value", "caracal config get <key>")
    
    console.print(config_table)
    console.print()
    
    # Provider commands
    console.print(f"  [{Colors.INFO}]Provider Management:[/]")
    console.print()
    
    provider_table = Table(show_header=True, header_style=f"bold {Colors.INFO}", box=None)
    provider_table.add_column("TUI Operation", style=Colors.PRIMARY)
    provider_table.add_column("CLI Equivalent", style=Colors.DIM)
    
    provider_table.add_row("List Providers", "caracal provider list")
    provider_table.add_row("Add Provider", "caracal provider add <name> --api-key=<key>")
    provider_table.add_row("Test Provider", "caracal provider test <name>")
    provider_table.add_row("Remove Provider", "caracal provider remove <name>")
    
    console.print(provider_table)
    console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _show_quickstart(console: Console) -> None:
    """Show quick start guide."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Quick Start Guide[/]",
        subtitle=f"[{Colors.HINT}]Getting started with Caracal deployment[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    guide = """
# Quick Start Guide

## 1. Installation

Install Caracal using pip:

```bash
pip install caracal
```

## 2. Initial Setup

Set your installation mode:

```bash
# For production use
caracal config mode user

# For development
caracal config mode dev
```

## 3. Create a Workspace

Create your first workspace:

```bash
caracal workspace create my-workspace
```

Or use the TUI:
- Navigate to Workspace Manager
- Select "Create Workspace"
- Follow the prompts

## 4. Configure PostgreSQL

Caracal requires PostgreSQL for data storage:

```bash
caracal config set postgres.host localhost
caracal config set postgres.port 5432
caracal config set postgres.database caracal
caracal config set postgres.user caracal
```

## 5. Edition Is Automatic

Edition is inferred from connectivity and cannot be manually set.

### Open Source Edition (Default)
Direct provider access with local API key storage:

```bash
caracal provider add openai --api-key=<your-key>
```

### Enterprise Edition
Gateway-based access with centralized management:

```bash
caracal sync connect <gateway-url> <token>
```

Return to Open Source mode:

```bash
caracal sync disconnect
```

## 6. Verify Setup

Check system health:

```bash
caracal doctor
```

## Next Steps

- Configure additional providers
- Set up sync for enterprise deployments
- Explore the TUI with `caracal-flow`
- Read the full documentation at https://docs.garudexlabs.com
"""
    
    console.print(Markdown(guide))
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _show_troubleshooting(console: Console) -> None:
    """Show troubleshooting guide."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Troubleshooting[/]",
        subtitle=f"[{Colors.HINT}]Common issues and solutions[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    issues = [
        {
            "issue": "Sync fails with connection error",
            "solution": "Check network connectivity and verify gateway URL. Run: caracal sync status"
        },
        {
            "issue": "Provider test fails",
            "solution": "Verify API key is correct. Check provider status at their website."
        },
        {
            "issue": "PostgreSQL connection error",
            "solution": "Ensure PostgreSQL is running. Verify connection details: caracal config list"
        },
        {
            "issue": "Workspace not found",
            "solution": "List available workspaces: caracal workspace list. Create if needed."
        },
        {
            "issue": "Permission denied on .caracal directory",
            "solution": "Check directory permissions: chmod 700 ~/.caracal"
        },
        {
            "issue": "Sync conflicts not resolving",
            "solution": "View conflicts: caracal sync conflicts. Manually resolve if needed."
        },
        {
            "issue": "Mode changes not taking effect",
            "solution": "Restart the application after changing mode."
        },
        {
            "issue": "Edition switch fails",
            "solution": "Ensure all pending syncs complete before switching editions."
        },
    ]
    
    for i, item in enumerate(issues, 1):
        console.print(f"  [{Colors.PRIMARY}]{i}. {item['issue']}[/]")
        console.print(f"     [{Colors.DIM}]Solution: {item['solution']}[/]")
        console.print()
    
    console.print(f"  [{Colors.INFO}]For more help:[/]")
    console.print(f"    - Run: caracal doctor")
    console.print(f"    - Check logs: ~/.caracal/logs/")
    console.print(f"    - Documentation: https://docs.garudexlabs.com")
    console.print()
    
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()


def _show_architecture(console: Console) -> None:
    """Show architecture overview."""
    console.clear()
    console.print(Panel(
        f"[{Colors.PRIMARY}]Architecture Overview[/]",
        subtitle=f"[{Colors.HINT}]Understanding Caracal deployment architecture[/]",
        border_style=Colors.INFO,
    ))
    console.print()
    
    architecture = """
# Caracal Deployment Architecture

## Modes

### Development Mode
- Code loaded from local repository
- Hot-reloading enabled
- Debug logging active
- For contributors and developers

### User Mode
- Code loaded from installed package
- Production optimizations
- Standard logging
- For end users

## Editions

### Open Source Edition
- Direct provider API access
- Local API key storage (encrypted)
- Broker architecture
- Self-hosted deployment

### Enterprise Edition
- Gateway-based provider access
- Centralized API key management
- Workspace synchronization
- Multi-user support

## Components

### Configuration Manager
- System-level configuration (~/.caracal/)
- Encrypted credential storage
- Workspace management
- PostgreSQL connection management

### Sync Engine
- Bidirectional synchronization
- Conflict resolution (Operational Transform)
- Offline operation queuing
- Network resilience

### Broker (Open Source)
- Direct provider communication
- Circuit breaker pattern
- Rate limiting
- Health checks

### Gateway Client (Enterprise)
- Proxy through gateway
- JWT authentication
- Quota monitoring
- Request queuing

## Data Storage

All persistent data stored in PostgreSQL:
- Sync state and operation queues
- Audit logs (append-only)
- Metrics and analytics
- Conflict history

## Security

- Age encryption for secrets
- System keyring integration
- PBKDF2 key derivation fallback
- File permissions (0700/0600)
- PostgreSQL SSL support
"""
    
    console.print(Markdown(architecture))
    console.print()
    console.print(f"  [{Colors.HINT}]Press Enter to continue...[/]")
    input()
