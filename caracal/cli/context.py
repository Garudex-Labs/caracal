"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI context for Caracal Core.

Provides shared context object and decorators for CLI commands.
"""

import click
from typing import Optional
from pathlib import Path


# Global context object to share configuration across commands
class CLIContext:
    """Context object for CLI commands."""
    
    def __init__(self):
        self.config = None
        self.config_path = None
        self.verbose = False


pass_context = click.make_pass_decorator(CLIContext, ensure=True)
