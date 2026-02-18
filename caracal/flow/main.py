"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow - Entry Point.

This is the main entry point for the Caracal Flow interactive CLI.
"""

import sys
from typing import Optional

import click

from caracal._version import __version__


@click.command()
@click.option(
    "--reset",
    is_flag=True,
    help="Reset Flow state and restart onboarding",
)
@click.option(
    "--compact",
    is_flag=True,
    help="Use compact mode for small terminals",
)
@click.option(
    "--no-onboarding",
    is_flag=True,
    help="Skip onboarding even on first run",
)
@click.version_option(version=__version__, prog_name="caracal-flow")
def main(reset: bool, compact: bool, no_onboarding: bool) -> None:
    """
    Caracal Flow - Interactive CLI for Caracal.
    
    A guided, step-driven terminal experience for managing the Caracal
    authority enforcement system for AI agents.
    
    Features:
    - Interactive menus with arrow-key navigation
    - Auto-complete enabled prompts
    - Onboarding wizard for first-time setup
    - Rich visual feedback with color semantics
    
    Examples:
    
        # Start Caracal Flow
        caracal-flow
        
        # Reset state and restart onboarding
        caracal-flow --reset
        
        # Use compact mode for small terminals
        caracal-flow --compact
    """
    try:
        # Lazy imports to speed up --help
        from rich.console import Console
        
        from caracal.flow.app import FlowApp
        from caracal.flow.state import StatePersistence, FlowState
        from caracal.flow.theme import FLOW_THEME
        
        # Handle reset flag
        if reset:
            persistence = StatePersistence()
            persistence.reset()
            click.echo("Flow state reset. Onboarding will run on next start.")
        
        # Create console with theme
        console = Console(theme=FLOW_THEME)
        
        # Create and configure app
        app = FlowApp(console=console)
        
        # Apply flags
        if compact:
            app.state.preferences.compact_mode = True
        
        if no_onboarding:
            app.state.onboarding.completed = True
        
        # Run the app
        app.start()
        
    except KeyboardInterrupt:
        click.echo("\nGoodbye!")
        sys.exit(0)
    except ImportError as e:
        click.echo(f"Error: Missing dependency - {e}", err=True)
        click.echo("Please ensure rich and prompt_toolkit are installed:", err=True)
        click.echo("  pip install rich prompt_toolkit", err=True)
        sys.exit(1)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
