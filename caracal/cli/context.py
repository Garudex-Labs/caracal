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
        self.workspace = None
        
    def __getitem__(self, key):
        """Allow dict-like access for backward compatibility."""
        return getattr(self, key)
        
    def __setitem__(self, key, value):
        """Allow dict-like assignment."""
        setattr(self, key, value)
        
    def get(self, key, default=None):
        """Dict-like get method."""
        return getattr(self, key, default)


pass_context = click.make_pass_decorator(CLIContext, ensure=True)
