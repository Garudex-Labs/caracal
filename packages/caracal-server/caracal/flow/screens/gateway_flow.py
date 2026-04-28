"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow Enterprise gateway handoff screen.
"""

from __future__ import annotations

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt

from caracal.deployment.enterprise_runtime import load_enterprise_config
from caracal.flow.theme import Colors


class GatewayFlow:
    """Show the Enterprise dashboard handoff for gateway operations."""

    def __init__(self, console: Optional[Console] = None) -> None:
        self.console = console or Console()

    def run(self) -> None:
        runtime = load_enterprise_config()
        api_url = str(runtime.get("api_url") or runtime.get("enterprise_url") or "").strip()
        dashboard_display = (api_url.rstrip("/") if api_url else "") or "the Caracal Enterprise dashboard"
        panel = Panel(
            "Gateway clusters, provider routing, revocation, quotas, and logs are managed in "
            f"[{Colors.PRIMARY}]{dashboard_display}[/].\n\n"
            "OSS Flow does not load Enterprise gateway runtime flags.",
            title="Enterprise Gateway",
            border_style=Colors.PRIMARY,
        )

        self.console.clear()
        self.console.print(panel)
        Prompt.ask("Press Enter to return", default="")


def show_gateway_flow(console: Optional[Console] = None) -> None:
    GatewayFlow(console).run()
