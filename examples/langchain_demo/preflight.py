"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Workspace readiness preflight for the demo environment.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    cli_fix: Optional[str] = None
    tui_screen: Optional[str] = None


class WorkspacePreflight:
    """Inspect live workspace state and report readiness for the demo."""

    REQUIRED_PRINCIPAL_KINDS = {"human", "orchestrator", "service"}
    WORKER_MIN = 2
    DEMO_PROVIDER_NAME = "ops-api"
    DEMO_TOOL_IDS = [
        "demo:ops:incidents:read",
        "demo:ops:deployments:read",
        "demo:ops:logs:read",
        "demo:ops:recommendation:write",
    ]

    def __init__(self, db_session: Session, workspace_name: str) -> None:
        self._session = db_session
        self._workspace = workspace_name

    def run(self) -> list[CheckResult]:
        results: list[CheckResult] = []
        results.append(self._check_workspace())
        results.extend(self._check_principals())
        results.append(self._check_worker_readiness())
        results.append(self._check_provider())
        results.extend(self._check_tools())
        results.append(self._check_tools_mapping_drift())
        results.append(self._check_policies())
        results.append(self._check_mandates())
        results.append(self._check_delegation())
        return results

    def passed(self) -> bool:
        return all(r.passed for r in self.run())

    def summary(self) -> dict:
        results = self.run()
        return {
            "workspace": self._workspace,
            "passed": all(r.passed for r in results),
            "checks": [
                {
                    "name": r.name,
                    "passed": r.passed,
                    "detail": r.detail,
                    "cli_fix": r.cli_fix,
                    "tui_screen": r.tui_screen,
                }
                for r in results
            ],
        }

    def _check_workspace(self) -> CheckResult:
        from caracal.deployment.config_manager import ConfigManager

        try:
            mgr = ConfigManager()
            name = mgr.get_default_workspace_name()
            if name:
                return CheckResult(
                    name="workspace_active",
                    passed=True,
                    detail=f"Active workspace: {name}",
                )
            return CheckResult(
                name="workspace_active",
                passed=False,
                detail="No active workspace found.",
                cli_fix="caracal workspace create <name> && caracal workspace switch <name>",
                tui_screen="Flow TUI → Workspace Manager",
            )
        except Exception as exc:
            return CheckResult(
                name="workspace_active",
                passed=False,
                detail=f"Workspace check failed: {exc}",
                cli_fix="caracal workspace create <name>",
                tui_screen="Flow TUI → Workspace Manager",
            )

    def _check_principals(self) -> list[CheckResult]:
        from caracal.db.models import Principal, PrincipalLifecycleStatus

        results: list[CheckResult] = []
        try:
            rows = self._session.query(Principal).all()
            found_kinds = {str(r.principal_kind) for r in rows if str(r.lifecycle_status) == PrincipalLifecycleStatus.ACTIVE.value}
            for kind in sorted(self.REQUIRED_PRINCIPAL_KINDS):
                if kind in found_kinds:
                    results.append(CheckResult(
                        name=f"principal_{kind}",
                        passed=True,
                        detail=f"Active {kind} principal found.",
                    ))
                else:
                    results.append(CheckResult(
                        name=f"principal_{kind}",
                        passed=False,
                        detail=f"No active {kind} principal. Register one first.",
                        cli_fix=f"caracal principal register --kind {kind} --name demo-{kind}",
                        tui_screen="Flow TUI → Principal Hub",
                    ))
        except Exception as exc:
            results.append(CheckResult(
                name="principals",
                passed=False,
                detail=f"Principal check failed: {exc}",
                cli_fix="caracal principal list",
            ))
        return results

    def _check_worker_readiness(self) -> CheckResult:
        from caracal.db.models import Principal, PrincipalLifecycleStatus

        try:
            rows = self._session.query(Principal).filter_by(principal_kind="worker").all()
            active_count = sum(
                1 for r in rows
                if str(r.lifecycle_status) == PrincipalLifecycleStatus.ACTIVE.value
            )
            total = len(rows)
            if total >= self.WORKER_MIN:
                return CheckResult(
                    name="principal_workers",
                    passed=True,
                    detail=(
                        f"{active_count} of {total} worker principal(s) active. "
                        f"Minimum {self.WORKER_MIN} registered — satisfied."
                    ),
                )
            return CheckResult(
                name="principal_workers",
                passed=False,
                detail=(
                    f"At least {self.WORKER_MIN} worker principals must be registered, "
                    f"found {total}. Workers are also spawned dynamically per run."
                ),
                cli_fix=(
                    "caracal principal register --kind worker --name demo-worker-1 && "
                    "caracal principal activate demo-worker-1 && "
                    "caracal principal register --kind worker --name demo-worker-2 && "
                    "caracal principal activate demo-worker-2"
                ),
                tui_screen="Flow TUI → Principal Hub",
            )
        except Exception as exc:
            return CheckResult(
                name="principal_workers",
                passed=False,
                detail=f"Worker readiness check failed: {exc}",
                cli_fix="caracal principal list",
            )

    def _check_provider(self) -> CheckResult:
        from caracal.db.models import GatewayProvider
        from caracal.provider.catalog import GATEWAY_ONLY_AUTH

        try:
            row = (
                self._session.query(GatewayProvider)
                .filter_by(provider_id=self.DEMO_PROVIDER_NAME)
                .first()
            )
            if row is None:
                return CheckResult(
                    name="provider_ops_api",
                    passed=False,
                    detail=f"Provider '{self.DEMO_PROVIDER_NAME}' not registered.",
                    cli_fix=f"caracal provider add --name {self.DEMO_PROVIDER_NAME} --definition-file ops-api.json",
                    tui_screen="Flow TUI → Provider Manager",
                )
            if not bool(getattr(row, "enabled", True)):
                return CheckResult(
                    name="provider_ops_api",
                    passed=False,
                    detail=f"Provider '{self.DEMO_PROVIDER_NAME}' is disabled.",
                    cli_fix=f"caracal provider update --name {self.DEMO_PROVIDER_NAME} --enabled",
                    tui_screen="Flow TUI → Provider Manager",
                )
            resources = getattr(row, "resources", None) or []
            actions = getattr(row, "actions", None) or []
            if not resources or not actions:
                return CheckResult(
                    name="provider_ops_api",
                    passed=False,
                    detail=(
                        f"Provider '{self.DEMO_PROVIDER_NAME}' is missing resource/action contracts "
                        f"(resources={bool(resources)}, actions={bool(actions)}). "
                        f"Update the provider definition to include scope contracts."
                    ),
                    cli_fix=f"caracal provider update --name {self.DEMO_PROVIDER_NAME} --definition-file ops-api.json",
                    tui_screen="Flow TUI → Provider Manager",
                )
            auth_scheme = str(getattr(row, "auth_scheme", "none") or "none")
            credential_ref = getattr(row, "credential_ref", None)
            if auth_scheme in GATEWAY_ONLY_AUTH and not credential_ref:
                return CheckResult(
                    name="provider_ops_api",
                    passed=False,
                    detail=(
                        f"Provider '{self.DEMO_PROVIDER_NAME}' uses auth_scheme='{auth_scheme}' "
                        f"but has no credential_ref. Store a credential and link it."
                    ),
                    cli_fix=f"caracal provider credential set --name {self.DEMO_PROVIDER_NAME} --secret <value>",
                    tui_screen="Flow TUI → Provider Manager → Credentials",
                )
            definition = getattr(row, "provider_definition", "custom") or "custom"
            return CheckResult(
                name="provider_ops_api",
                passed=True,
                detail=(
                    f"Provider '{self.DEMO_PROVIDER_NAME}' active. "
                    f"definition={definition}, auth={auth_scheme}, "
                    f"resources={len(resources)}, actions={len(actions)}."
                ),
            )
        except Exception as exc:
            return CheckResult(
                name="provider_ops_api",
                passed=False,
                detail=f"Provider check failed: {exc}",
                cli_fix=f"caracal provider add --name {self.DEMO_PROVIDER_NAME}",
            )

    def _check_tools(self) -> list[CheckResult]:
        from caracal.db.models import RegisteredTool

        results: list[CheckResult] = []
        try:
            for tool_id in self.DEMO_TOOL_IDS:
                row = (
                    self._session.query(RegisteredTool)
                    .filter_by(tool_id=tool_id)
                    .first()
                )
                if row is None:
                    results.append(CheckResult(
                        name=f"tool_{tool_id}",
                        passed=False,
                        detail=f"Tool '{tool_id}' not registered.",
                        cli_fix=f"caracal tool register --tool-id {tool_id} --provider {self.DEMO_PROVIDER_NAME}",
                        tui_screen="Flow TUI → Tool Registry",
                    ))
                elif not bool(getattr(row, "active", True)):
                    results.append(CheckResult(
                        name=f"tool_{tool_id}",
                        passed=False,
                        detail=f"Tool '{tool_id}' is inactive.",
                        cli_fix=f"caracal tool reactivate --tool-id {tool_id}",
                        tui_screen="Flow TUI → Tool Registry",
                    ))
                else:
                    provider = getattr(row, "provider_name", "") or ""
                    res_scope = getattr(row, "resource_scope", "") or ""
                    act_scope = getattr(row, "action_scope", "") or ""
                    exec_mode = getattr(row, "execution_mode", "") or ""
                    tool_type = getattr(row, "tool_type", "") or ""
                    results.append(CheckResult(
                        name=f"tool_{tool_id}",
                        passed=True,
                        detail=(
                            f"Tool '{tool_id}' active. "
                            f"provider={provider}, type={tool_type}, "
                            f"mode={exec_mode}, "
                            f"resource={res_scope}, action={act_scope}"
                        ),
                    ))
        except Exception as exc:
            results.append(CheckResult(
                name="tools",
                passed=False,
                detail=f"Tool check failed: {exc}",
                cli_fix="caracal tool list",
            ))
        return results

    def _check_tools_mapping_drift(self) -> CheckResult:
        from caracal.exceptions import CaracalError
        from caracal.mcp.tool_registry_contract import resolve_issue_scopes_from_tool_ids

        try:
            contract = resolve_issue_scopes_from_tool_ids(
                db_session=self._session,
                tool_ids=self.DEMO_TOOL_IDS,
            )
            providers = ", ".join(contract.get("providers", []))
            return CheckResult(
                name="tool_mapping_drift",
                passed=True,
                detail=f"All demo tools resolve without drift. Providers: {providers}.",
            )
        except CaracalError as exc:
            return CheckResult(
                name="tool_mapping_drift",
                passed=False,
                detail=str(exc),
                cli_fix="caracal tool register --workspace <name> ...",
                tui_screen="Flow TUI → Tool Registry",
            )
        except Exception as exc:
            return CheckResult(
                name="tool_mapping_drift",
                passed=False,
                detail=f"Tool registry contract check failed: {exc}",
                cli_fix="caracal tool list --workspace <name>",
            )

    def _check_policies(self) -> CheckResult:
        from caracal.db.models import AuthorityPolicy

        try:
            count = self._session.query(AuthorityPolicy).filter_by(active=True).count()
            if count == 0:
                return CheckResult(
                    name="policies",
                    passed=False,
                    detail="No active policies found.",
                    cli_fix="caracal policy create --resource-scope ... --action-scope ...",
                    tui_screen="Flow TUI → Authority Policy",
                )
            return CheckResult(
                name="policies",
                passed=True,
                detail=f"{count} active policy/policies found.",
            )
        except Exception as exc:
            return CheckResult(
                name="policies",
                passed=False,
                detail=f"Policy check failed: {exc}",
                cli_fix="caracal policy list",
            )

    def _check_mandates(self) -> CheckResult:
        from caracal.db.models import ExecutionMandate

        try:
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            count = (
                self._session.query(ExecutionMandate)
                .filter(ExecutionMandate.revoked.is_(False))
                .filter(
                    (ExecutionMandate.valid_until == None)  # noqa: E711
                    | (ExecutionMandate.valid_until > now)
                )
                .count()
            )
            if count == 0:
                return CheckResult(
                    name="mandates",
                    passed=False,
                    detail="No active mandates found.",
                    cli_fix="caracal authority mandate --issuer <human-id> --subject <orchestrator-id> --resource-scope ...",
                    tui_screen="Flow TUI → Mandate Manager",
                )
            return CheckResult(
                name="mandates",
                passed=True,
                detail=f"{count} active mandate(s) found.",
            )
        except Exception as exc:
            return CheckResult(
                name="mandates",
                passed=False,
                detail=f"Mandate check failed: {exc}",
                cli_fix="caracal authority list",
            )

    def _check_delegation(self) -> CheckResult:
        from caracal.db.models import DelegationEdgeModel

        try:
            count = self._session.query(DelegationEdgeModel).count()
            if count == 0:
                return CheckResult(
                    name="delegation",
                    passed=False,
                    detail="No delegation edges found. Issue a delegated mandate from orchestrator to at least one worker.",
                    cli_fix="caracal authority mandate --issuer <orchestrator-id> --subject <worker-id> --delegate",
                    tui_screen="Flow TUI → Mandate Delegation",
                )
            return CheckResult(
                name="delegation",
                passed=True,
                detail=f"{count} delegation edge(s) found.",
            )
        except Exception as exc:
            return CheckResult(
                name="delegation",
                passed=False,
                detail=f"Delegation check failed: {exc}",
                cli_fix="caracal authority list",
            )
