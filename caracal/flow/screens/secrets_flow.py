"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal Flow — Secrets Management Screen.

Provides the TUI interface for managing secrets in the tier-appropriate
vault backend:
  Starter  → CaracalVault (AES-256-GCM, built-in)
  Growth + → AWS Secrets Manager

Menu actions:
  - Vault status: current backend, key version, secret count
  - List secrets: enumerate refs for (org, env)
  - Rotate master key: CaracalVault key rotation (Starter only)
  - Migration: plan and execute CaracalVault → AWS SM
  - AWS cost estimate: show pricing breakdown before upgrade
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

_STARTER_TIERS = {"starter"}
_AWS_TIERS = {"growth", "scale", "enterprise"}


class SecretsFlow:
    """
    TUI secrets management screen.

    Instantiate with (tier, org_id, env_id) from the enterprise license
    context.
    """

    def __init__(
        self,
        tier: str = "starter",
        org_id: str = "",
        env_id: str = "default",
        console: Optional[Console] = None,
    ) -> None:
        self._tier = tier.lower()
        self._org_id = org_id
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
        is_starter = self._tier in _STARTER_TIERS
        backend_label = "CaracalVault (Starter)" if is_starter else f"AWS Secrets Manager ({self._tier.title()})"

        header = Panel(
            Text.assemble(
                ("  Secrets Vault\n", "bold cyan"),
                (f"  Backend : {backend_label}\n", "dim"),
                (f"  Org     : {self._org_id or 'not configured'}\n", "dim"),
                (f"  Env     : {self._env_id}\n", "dim"),
            ),
            border_style="cyan",
        )
        self.console.print(header)

        items = [
            MenuItem("status", "Vault Status", "Backend, key version, secret count", ""),
            MenuItem("list", "List Secrets", "Enumerate secret refs for this org/env", ""),
        ]

        if is_starter:
            items += [
                MenuItem("rotate", "Rotate Master Key", "Re-wrap DEKs under a new key version", ""),
                MenuItem("migrate", "Migrate to AWS SM", "Upgrade plan + cost estimate + wizard", ""),
                MenuItem("cost", "AWS Cost Estimate", "Show estimated AWS Secrets Manager pricing", ""),
            ]

        items.append(MenuItem("back", "Back", "Return to previous menu", Icons.ARROW_LEFT))

        menu = Menu(title="", items=items)
        result = menu.run()
        return result.key if result else "back"

    # ── Vault status ───────────────────────────────────────────────────

    def _show_vault_status(self) -> None:
        is_starter = self._tier in _STARTER_TIERS
        self.console.print("\n[bold cyan]Vault Status[/bold cyan]\n")

        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="dim", width=22)
        table.add_column(style="bold white")

        table.add_row("Tier", self._tier.title())

        if is_starter:
            try:
                from caracal.core.vault import get_vault, gateway_context
                vault = get_vault()
                with gateway_context():
                    names = vault.list_secrets(self._org_id, self._env_id)
                    version = vault._storage.current_key_version(self._org_id, self._env_id)
                table.add_row("Backend", "CaracalVault (built-in)")
                table.add_row("Encryption", "AES-256-GCM + envelope encryption")
                table.add_row("Key Version", str(version))
                table.add_row("Secret Count", str(len(names)))
                table.add_row("KMS-Wrapped", "Yes (HKDF-SHA256 from MEK)")
            except Exception as exc:
                table.add_row("Status", f"[red]Error: {exc}[/red]")
        else:
            try:
                from caracalEnterprise.services.gateway.secret_manager import AWSSecretsManagerBackend
                backend = AWSSecretsManagerBackend()
                refs = backend.list_refs(self._org_id, self._env_id)
                table.add_row("Backend", "AWS Secrets Manager")
                table.add_row("Region", backend._region)
                table.add_row("Encryption", "AWS managed KMS (SSE)")
                table.add_row("Secret Count", str(len(refs)))
            except Exception as exc:
                table.add_row("Status", f"[red]Error: {exc}[/red]")

        self.console.print(table)
        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    # ── List secrets ───────────────────────────────────────────────────

    def _show_secret_list(self) -> None:
        self.console.print("\n[bold cyan]Secret Refs[/bold cyan]\n")
        try:
            from caracal.sdk.secrets import SecretsAdapter
            adapter = SecretsAdapter(tier=self._tier, org_id=self._org_id, env_id=self._env_id)
            refs = adapter.list_refs()
        except Exception as exc:
            self.console.print(f"[red]Failed to list secrets: {exc}[/red]")
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        if not refs:
            self.console.print("[dim]No secrets found for this org/env.[/dim]")
        else:
            table = Table("Ref", "Backend", show_header=True, header_style="bold cyan")
            for ref in refs:
                table.add_row(ref, adapter.backend_name)
            self.console.print(table)
            self.console.print(f"\n[dim]Total: {len(refs)}[/dim]")

        Prompt.ask("\n[dim]Press Enter to continue[/dim]")

    # ── Rotate key ─────────────────────────────────────────────────────

    def _rotate_key(self) -> None:
        if self._tier not in _STARTER_TIERS:
            self.console.print(
                "[yellow]Key rotation is managed by AWS KMS for this tier.\n"
                "Use the AWS KMS console to rotate keys.[/yellow]"
            )
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        self.console.print(
            "\n[bold yellow]Master Key Rotation[/bold yellow]\n"
            "[dim]All DEKs will be re-wrapped under a new MEK version.\n"
            "No secret values are exposed during rotation.[/dim]\n"
        )
        if Prompt.ask("Confirm rotation?", choices=["y", "n"], default="n") != "y":
            self.console.print("[dim]Cancelled.[/dim]")
            return

        try:
            from caracal.core.vault import get_vault, gateway_context
            vault = get_vault()
            with gateway_context():
                result = vault.rotate_master_key(self._org_id, self._env_id, actor="tui")
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
        if self._tier not in _STARTER_TIERS:
            self.console.print(
                "[yellow]Already on AWS Secrets Manager backend.\n"
                "To downgrade, use the admin dashboard.[/yellow]"
            )
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        self.console.print("\n[bold cyan]Migration Wizard — CaracalVault → AWS Secrets Manager[/bold cyan]\n")
        target = Prompt.ask(
            "Target tier",
            choices=["growth", "scale", "enterprise"],
            default="growth",
        )
        rotate = Prompt.ask("Rotate credentials during migration?", choices=["y", "n"], default="n") == "y"

        try:
            from caracalEnterprise.services.gateway.vault_migration import MigrationOrchestrator
            orchestrator = MigrationOrchestrator()
            plan = orchestrator.plan_upgrade(
                org_id=self._org_id, env_id=self._env_id,
                source_tier=self._tier, target_tier=target,
                rotate_credentials=rotate,
            )
        except Exception as exc:
            self.console.print(f"[red]Failed to build plan: {exc}[/red]")
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        # Show plan
        self._show_migration_plan(plan)

        if Prompt.ask("\nProceed with migration?", choices=["y", "n"], default="n") != "y":
            self.console.print("[dim]Migration cancelled.[/dim]")
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        self.console.print("\n[cyan]Running migration…[/cyan]")
        try:
            result = orchestrator.execute_upgrade(plan, actor="tui")
            if result.status.value == "completed":
                self.console.print(
                    f"\n[green]Migration complete.[/green]\n"
                    f"  Migrated  : {result.secrets_migrated}/{result.secrets_total}\n"
                    f"  Duration  : {result.duration_seconds}s"
                )
                self._tier = target
            else:
                self.console.print(
                    f"[red]Migration failed: {result.error}[/red]\n"
                    f"  Migrated  : {result.secrets_migrated}/{result.secrets_total}\n"
                    f"  Failed    : {result.secrets_failed}"
                )
        except Exception as exc:
            self.console.print(f"[red]Migration execution failed: {exc}[/red]")

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
        self.console.print("\n[bold cyan]AWS Secrets Manager Cost Estimate[/bold cyan]\n")
        try:
            from caracalEnterprise.services.gateway.vault_migration import AWSCostEstimate, MigrationOrchestrator
            from caracal.core.vault import get_vault, gateway_context
            vault = get_vault()
            with gateway_context():
                names = vault.list_secrets(self._org_id, self._env_id)
            estimate = AWSCostEstimate.for_secrets(len(names))
        except Exception as exc:
            self.console.print(f"[red]Failed to calculate estimate: {exc}[/red]")
            Prompt.ask("\n[dim]Press Enter to continue[/dim]")
            return

        table = Table(show_header=False, box=None, padding=(0, 2))
        table.add_column(style="dim", width=30)
        table.add_column(style="bold white")
        table.add_row("Secret count", str(estimate.secret_count))
        table.add_row("Secret storage / month", f"${estimate.cost_per_month_usd:.4f} USD")
        table.add_row("API calls / month (est.)", f"{estimate.api_calls_per_month_estimated:,}")
        table.add_row("API call cost / month", f"${estimate.api_call_cost_per_month_usd:.4f} USD")
        table.add_row("Total / month", f"[bold green]${estimate.total_per_month_usd:.4f} USD[/bold green]")
        table.add_row("Total / year", f"[bold green]${estimate.total_per_year_usd:.4f} USD[/bold green]")
        table.add_row("", "")
        table.add_row("[dim]Pricing basis[/dim]", "[dim]$0.40/secret/month + $0.05/10k API calls[/dim]")
        self.console.print(table)
        Prompt.ask("\n[dim]Press Enter to continue[/dim]")
