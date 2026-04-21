"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow — Secrets Management Screen.

Provides the TUI interface for managing secrets through the hard-cut
vault backend.

Menu actions:
  - Vault status: current backend, key version, secret count
  - List secrets: enumerate refs for (workspace, env)
  - Rotate master key: request CaracalVault key rotation
"""

from __future__ import annotations

from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt
from rich.table import Table
from rich.text import Text

from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.theme import Colors, Icons
from caracal.logging_config import get_logger

logger = get_logger(__name__)

class SecretsFlow:
    """
    TUI secrets management screen.

    Instantiate with (tier, workspace_id, env_id) from the enterprise license
    context.
    """

    def __init__(
        self,
        tier: str = "starter",
        workspace_id: str = "",
        env_id: str = "default",
        console: Optional[Console] = None,
    ) -> None:
        self._tier = tier.lower()
        self._workspace_id = workspace_id
        self._env_id = env_id
        self.console = console or Console()

    # ── Main entry point ───────────────────────────────────────────────

    def show(self) -> None:
        """Display the secrets management menu loop."""
        while True:
            action = self._show_menu()
            if action == "status":
                self._show_vault_status()
            elif action == "list":
                self._show_secret_list()
            elif action == "rotate":
                self._rotate_key()
            elif action == "migrate":
                self._run_migration_wizard()
            elif action == "cost":
                self._show_aws_cost_estimate()
            elif action == "back":
                break

    # ── Menu ───────────────────────────────────────────────────────────

    def _show_menu(self) -> str:
        header = Panel(
            Text.assemble(
                ("  Secrets Vault\n", "bold cyan"),
                ("  Backend : CaracalVault\n", "dim"),
                (f"  Workspace: {self._workspace_id or 'not configured'}\n", "dim"),
                (f"  Env     : {self._env_id}\n", "dim"),
            ),
            border_style="cyan",
        )
        self.console.print(header)

        items = [
            MenuItem("status", "Vault Status", "Backend, key version, secret count", ""),
            MenuItem("list", "List Secrets", "Enumerate secret refs for this workspace/env", ""),
            MenuItem("rotate", "Rotate Master Key", "Request a new vault key version", ""),
        ]

        items.append(MenuItem("back", "Back", "Return to previous menu", Icons.ARROW_LEFT))

        menu = Menu(title="", items=items)
        result = menu.run()
        return result.key if result else "back"

    # ── Vault status ───────────────────────────────────────────────────

    def _show_vault_status(self) -> None:
        self.console.print("\n[bold cyan]Vault Status[/bold cyan]\n")

        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="dim", width=22)
        table.add_column(style="bold white")

        table.add_row("Tier", self._tier.title())

        try:
            from caracal.core.vault import get_vault, vault_access_context

            vault = get_vault()
            with vault_access_context():
                names = vault.list_secrets(self._workspace_id, self._env_id)
            table.add_row("Backend", "CaracalVault")
            table.add_row("Storage", "Vault-managed secret refs")
            table.add_row("Secret Count", str(len(names)))
        except Exception as exc:
            table.add_row("Status", f"[red]Error: {exc}[/red]")

        self.console.print(table)
        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    # ── List secrets ───────────────────────────────────────────────────

    def _show_secret_list(self) -> None:
        self.console.print("\n[bold cyan]Secret Refs[/bold cyan]\n")
        try:
            from caracal.core.vault import get_vault, vault_access_context

            with vault_access_context():
                names = get_vault().list_secrets(self._workspace_id, self._env_id)
            refs = [f"vault://{self._workspace_id or 'default'}/{self._env_id}/{name}" for name in names]
            backend_name = "caracal_vault"
        except Exception as exc:
            self.console.print(f"[red]Failed to list secrets: {exc}[/red]")
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        if not refs:
            self.console.print("[dim]No secrets found for this workspace/env.[/dim]")
        else:
            table = Table("Ref", "Backend", show_header=True, header_style="bold cyan")
            for ref in refs:
                table.add_row(ref, backend_name)
            self.console.print(table)
            self.console.print(f"\n[dim]Total: {len(refs)}[/dim]")

        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    # ── Rotate key ─────────────────────────────────────────────────────

    def _rotate_key(self) -> None:
        self.console.print(
            "\n[bold yellow]Master Key Rotation[/bold yellow]\n"
            "[dim]Request a new vault-managed key version for this workspace/env.\n"
            "No secret values are exposed during rotation.[/dim]\n"
        )
        if Prompt.ask("Confirm rotation?", choices=["y", "n"], default="n") != "y":
            self.console.print("[dim]Cancelled.[/dim]")
            return

        try:
            from caracal.core.vault import get_vault, vault_access_context
            vault = get_vault()
            with vault_access_context():
                result = vault.rotate_master_key(self._workspace_id, self._env_id, actor="tui")
            self.console.print(
                f"\n[green]Rotation complete.[/green]\n"
                f"  Secrets rotated : {result.secrets_rotated}\n"
                f"  New key version : {result.new_key_version}\n"
                f"  Duration        : {result.duration_seconds}s"
            )
            if result.secrets_failed > 0:
                self.console.print(f"  [red]Failed        : {result.secrets_failed}[/red]")
        except Exception as exc:
            self.console.print(f"[red]Rotation failed: {exc}[/red]")

        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    # ── Migration wizard ───────────────────────────────────────────────

    def _run_migration_wizard(self) -> None:
        self.console.print(
            "[yellow]Secret backend migration is not available in hard-cut mode.[/yellow]"
        )
        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    def _show_migration_plan(self, plan) -> None:
        self.console.print(f"\n[bold]Migration Plan[/bold]  [dim]{plan.plan_id}[/dim]")
        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="dim", width=28)
        table.add_column(style="bold white")
        table.add_row("Direction", f"{plan.source_tier} → {plan.target_tier}")
        table.add_row("Secrets to migrate", str(plan.total_secrets))
        table.add_row("Rotate credentials", "yes" if plan.rotate_credentials else "no")
        if plan.cost_estimate:
            e = plan.cost_estimate
            table.add_row("AWS cost / month", f"${e.total_per_month_usd:.4f} USD")
            table.add_row("AWS cost / year", f"${e.total_per_year_usd:.4f} USD")
        for k, v in plan.impact_summary.items():
            if k not in ("aws_region",):
                table.add_row(k.replace("_", " ").title(), str(v))
        self.console.print(table)

    # ── Cost estimate ──────────────────────────────────────────────────

    def _show_aws_cost_estimate(self) -> None:
        self.console.print(
            "[yellow]External secret-backend pricing estimates are not applicable in hard-cut mode.[/yellow]"
        )
        Prompt.ask("\n[dim]Press Enter to continue[/dim]")
