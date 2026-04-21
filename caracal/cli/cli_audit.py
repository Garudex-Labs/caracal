"""
CLI command audits and workflow validation helpers.

Provides structural checks to ensure the CLI surface stays coherent,
discoverable, and aligned with expected operational flows.
"""

import json
import sys
import tempfile
from pathlib import Path
from typing import Dict, List, Tuple

import click
from click.testing import CliRunner


def _command_short_help(command: click.Command) -> str:
    """Return a compact help summary for a command."""
    if command.short_help:
        return command.short_help
    if command.help:
        return command.help.strip().splitlines()[0]
    return "(no help text)"


def _collect_command_surface(root_command: click.Group) -> Dict[str, Dict[str, object]]:
    """Collect top-level command names and subcommand metadata."""
    surface: Dict[str, Dict[str, object]] = {}

    for command_name in sorted(root_command.commands.keys()):
        command = root_command.commands[command_name]
        subcommands: List[str] = []

        if isinstance(command, click.Group):
            subcommands = sorted(command.commands.keys())

        surface[command_name] = {
            "help": _command_short_help(command),
            "is_group": isinstance(command, click.Group),
            "subcommands": subcommands,
        }

    return surface


def _lint_command_surface(surface: Dict[str, Dict[str, object]]) -> List[str]:
    """Return structural lint findings for command naming/help quality."""
    findings: List[str] = []

    for command_name, metadata in surface.items():
        if "_" in command_name:
            findings.append(
                f"Top-level command '{command_name}' should use kebab-case (no underscore)."
            )

        if metadata["help"] == "(no help text)":
            findings.append(f"Top-level command '{command_name}' is missing help text.")

        for subcommand in metadata["subcommands"]:
            if "_" in subcommand:
                findings.append(
                    f"Subcommand '{command_name} {subcommand}' should use kebab-case (no underscore)."
                )

    return findings


def _required_workflow_commands() -> List[Tuple[str, str]]:
    """Required command chain for the core CLI workflow."""
    return [
        ("workspace", "create"),
        ("system", "db"),
        ("principal", "register"),
        ("principal", "list"),
        ("policy", "create"),
        ("policy", "list"),
        ("delegation", "generate"),
        ("delegation", "list"),
        ("authority", "mandate"),
        ("authority", "enforce"),
        ("authority", "list"),
        ("audit", "export"),
    ]


def _workflow_gaps(root_command: click.Group) -> List[str]:
    """Find missing commands/subcommands required by the canonical workflow."""
    gaps: List[str] = []

    for top_level, subcommand in _required_workflow_commands():
        source = root_command.commands.get(top_level)
        if source is None:
            gaps.append(f"Missing top-level command: {top_level}")
            continue

        if not subcommand:
            continue

        if not isinstance(source, click.Group) or subcommand not in source.commands:
            gaps.append(f"Missing workflow subcommand: {top_level} {subcommand}")

    return gaps


def _all_help_invocations(root_command: click.Group) -> List[List[str]]:
    """Return CLI argument vectors for safe help-only smoke checks."""
    invocations: List[List[str]] = []

    for command_name in sorted(root_command.commands.keys()):
        command = root_command.commands[command_name]
        invocations.append([command_name, "--help"])

        if isinstance(command, click.Group):
            for subcommand in sorted(command.commands.keys()):
                invocations.append([command_name, subcommand, "--help"])

    return invocations


def _run_help_smoke(root_command: click.Group) -> Dict[str, object]:
    """Execute help-only smoke checks for all commands/subcommands."""
    runner = CliRunner()
    checks = _all_help_invocations(root_command)
    failures: List[Dict[str, str]] = []

    for args in checks:
        result = runner.invoke(root_command, args)
        if result.exit_code != 0:
            failures.append(
                {
                    "command": " ".join(args),
                    "exit_code": str(result.exit_code),
                    "error": (result.output or "").strip()[:500],
                }
            )

    return {
        "total": len(checks),
        "failed": len(failures),
        "failures": failures,
    }


def _extract_principal_id(output: str) -> str:
    """Extract principal ID line from `principal register` output."""
    for line in output.splitlines():
        if "Principal ID:" in line:
            return line.split("Principal ID:", 1)[1].strip()
    return ""


def _run_workflow_execution_probe(root_command: click.Group) -> Dict[str, object]:
    """Run executable workflow checks in an isolated temporary workspace."""
    runner = CliRunner()
    steps: List[Dict[str, object]] = []

    with tempfile.TemporaryDirectory() as temp_dir:
        command_steps = [
            {
                "name": "workspace-create",
                "args": ["workspace", "create", "audit-workspace"],
                "expected_success": True,
            },
            {
                "name": "db-init",
                "args": ["system", "db", "init"],
                "expected_success": True,
            },
            {
                "name": "principal-register",
                "args": [
                    "principal",
                    "register",
                    "--name",
                    "workflow-worker",
                    "--email",
                    "ops@example.com",
                ],
                "expected_success": True,
            },
            {
                "name": "principal-list",
                "args": ["principal", "list"],
                "expected_success": True,
            },
        ]

        principal_id = ""

        for step in command_steps:
            result = runner.invoke(root_command, step["args"])
            ok = result.exit_code == 0
            if step["name"] == "principal-register" and ok:
                principal_id = _extract_principal_id(result.output)

            steps.append(
                {
                    "step": step["name"],
                    "command": "caracal " + " ".join(step["args"]),
                    "expected_success": step["expected_success"],
                    "success": ok,
                    "exit_code": result.exit_code,
                    "output": (result.output or "").strip()[:500],
                }
            )

        if not principal_id:
            return {
                "all_passed": False,
                "steps": steps,
                "summary": "Workflow probe stopped early because principal registration did not yield a principal ID.",
            }

        followup_steps = [
            {
                "name": "policy-create",
                "args": [
                    "policy",
                    "create",
                    "--principal-id",
                    principal_id,
                    "--max-validity-seconds",
                    "3600",
                    "--resource-pattern",
                    "api:*",
                    "--action",
                    "api_call",
                ],
            },
            {
                "name": "delegation-list",
                "args": ["delegation", "list"],
            },
            {
                "name": "authority-list",
                "args": ["authority", "list"],
            },
            {
                "name": "audit-export-help",
                "args": ["audit", "export", "--help"],
            },
        ]

        for step in followup_steps:
            result = runner.invoke(root_command, step["args"])
            steps.append(
                {
                    "step": step["name"],
                    "command": "caracal " + " ".join(step["args"]),
                    "expected_success": True,
                    "success": result.exit_code == 0,
                    "exit_code": result.exit_code,
                    "output": (result.output or "").strip()[:500],
                }
            )

    failed_steps = [s for s in steps if not s["success"]]
    insights: List[str] = []

    for step in failed_steps:
        output = str(step.get("output", ""))
        step_name = str(step.get("step", ""))

        if step_name == "db-init":
            insights.append(
                "Database initialization failed. Ensure PostgreSQL is running and CARACAL_DB_* settings are configured before authority workflows."
            )

        if step_name == "policy-create" and "Principal not found" in output:
            insights.append(
                "Policy creation failed because there is no principal onboarding command in the current CLI workflow."
            )
        if step_name in {"delegation-list", "authority-list"} and (
            "connect" in output.lower() or "database" in output.lower()
        ):
            insights.append(
                "Authority/delegation runtime commands require a reachable PostgreSQL setup beyond simple workspace creation."
            )

    # Keep insight messages unique while preserving order.
    unique_insights: List[str] = []
    for insight in insights:
        if insight not in unique_insights:
            unique_insights.append(insight)

    return {
        "all_passed": len(failed_steps) == 0,
        "failed_count": len(failed_steps),
        "steps": steps,
        "insights": unique_insights,
        "summary": (
            "All workflow probe steps passed."
            if not failed_steps
            else "Workflow probe found commands that require additional setup or failed execution."
        ),
    }


@click.command("commands")
@click.option(
    "--format",
    "output_format",
    type=click.Choice(["table", "json"], case_sensitive=False),
    default="table",
    show_default=True,
    help="Output format.",
)
@click.option(
    "--strict",
    is_flag=True,
    help="Exit non-zero if structural findings are detected.",
)
@click.option(
    "--smoke",
    is_flag=True,
    help="Execute help-only smoke checks for every command and subcommand.",
)
@click.pass_context
def audit_commands(ctx: click.Context, output_format: str, strict: bool, smoke: bool):
    """Audit CLI command structure, naming consistency, and help coverage."""
    root = ctx.find_root().command
    if not isinstance(root, click.Group):
        click.echo("Error: Root command is not a Click group.", err=True)
        sys.exit(1)

    surface = _collect_command_surface(root)
    findings = _lint_command_surface(surface)
    smoke_results = _run_help_smoke(root) if smoke else None

    if output_format.lower() == "json":
        click.echo(
            json.dumps(
                {
                    "top_level_command_count": len(surface),
                    "commands": surface,
                    "findings": findings,
                    "smoke": smoke_results,
                },
                indent=2,
            )
        )
    else:
        click.echo("CLI Command Audit")
        click.echo("=" * 70)
        click.echo(f"Top-level commands: {len(surface)}")
        click.echo()

        for command_name, metadata in surface.items():
            subcommands = metadata["subcommands"]
            subcommands_text = ", ".join(subcommands) if subcommands else "-"
            click.echo(f"- {command_name:<16} | {metadata['help']}")
            click.echo(f"  subcommands: {subcommands_text}")

        click.echo()
        if findings:
            click.echo(f"Findings ({len(findings)}):")
            for finding in findings:
                click.echo(f"- {finding}")
        else:
            click.echo("Findings: none")

        if smoke_results is not None:
            click.echo()
            click.echo(
                f"Smoke checks: {smoke_results['total'] - smoke_results['failed']}/{smoke_results['total']} passed"
            )
            if smoke_results["failed"]:
                click.echo("Smoke failures:")
                for failure in smoke_results["failures"]:
                    click.echo(
                        f"- {failure['command']} (exit {failure['exit_code']})"
                    )

    if strict and (findings or (smoke_results and smoke_results["failed"])):
        sys.exit(1)


@click.command("workflow")
@click.option(
    "--strict",
    is_flag=True,
    help="Exit non-zero when required workflow commands are missing.",
)
@click.option(
    "--format",
    "output_format",
    type=click.Choice(["table", "json"], case_sensitive=False),
    default="table",
    show_default=True,
    help="Output format.",
)
@click.option(
    "--execute",
    is_flag=True,
    help="Execute workflow probe commands in a temporary workspace.",
)
@click.pass_context
def audit_workflow(ctx: click.Context, strict: bool, output_format: str, execute: bool):
    """Validate that the end-to-end CLI workflow can be executed from commands alone."""
    root = ctx.find_root().command
    if not isinstance(root, click.Group):
        click.echo("Error: Root command is not a Click group.", err=True)
        sys.exit(1)

    gaps = _workflow_gaps(root)
    execution_probe = _run_workflow_execution_probe(root) if execute else None

    workflow_steps = [
        "caracal workspace create \"pied piper\"",
        "caracal workspace use hooli",
        "caracal workspace create \"raviga capital\"",
        "caracal system db init",
        "caracal principal register --type human --name \"Richard Hendricks\" --email richard.hendricks@piedpiper.com",
        "caracal principal register --type orchestrator --name \"Jared Dunn ai\" --email jared.dunn.ai@hooli.com",
        "caracal principal register --type worker --name Fiona --email fiona@ravigacapital.com",
        "caracal principal register --type service --name Endframe --email endframe@hooli.com",
        "caracal policy create --principal-id <principal-uuid> --max-validity-seconds 3600 --resource-pattern 'api:*' --action 'api_call'",
        "caracal delegation generate --source-id <source-uuid> --target-id <target-uuid> --expiration 3600",
        "caracal authority mandate --issuer-id <issuer-uuid> --subject-id <subject-uuid> --resource-scope 'api:*' --action-scope 'api_call' --validity-seconds 3600",
        "caracal authority enforce --mandate-id <mandate-uuid> --action api_call --resource api:openai:gpt-4",
        "caracal audit export",
    ]

    if output_format.lower() == "json":
        click.echo(
            json.dumps(
                {
                    "workflow_ok": not gaps,
                    "missing": gaps,
                    "reference_workflow": workflow_steps,
                    "execution_probe": execution_probe,
                },
                indent=2,
            )
        )
    else:
        click.echo("CLI Workflow Validation")
        click.echo("=" * 70)
        click.echo("Required flow: setup -> org -> auth -> principal -> policy -> delegation -> run -> audit")
        click.echo()

        if gaps:
            click.echo(f"Missing workflow commands ({len(gaps)}):")
            for gap in gaps:
                click.echo(f"- {gap}")
        else:
            click.echo("Workflow commands: complete")

        click.echo()
        click.echo("Reference command sequence:")
        for step in workflow_steps:
            click.echo(f"- {step}")

        if execution_probe is not None:
            click.echo()
            click.echo("Execution probe:")
            click.echo(f"- {execution_probe['summary']}")
            for step in execution_probe["steps"]:
                status = "PASS" if step["success"] else "FAIL"
                click.echo(f"- [{status}] {step['step']}: exit {step['exit_code']}")
            if execution_probe.get("insights"):
                click.echo("Execution insights:")
                for insight in execution_probe["insights"]:
                    click.echo(f"- {insight}")

    has_execution_failures = execution_probe is not None and not execution_probe["all_passed"]
    if strict and (gaps or has_execution_failures):
        sys.exit(1)
