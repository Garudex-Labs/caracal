"""Idempotent bootstrap automation for the Caracal LangChain swarm demo."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from caracal.identity.attestation_nonce import AttestationNonceManager
from caracal.redis.client import RedisClient


@dataclass(frozen=True)
class PrincipalSpec:
    name: str
    principal_kind: str
    email: str


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    service_type: str
    base_url: str
    auth_scheme: str
    credential: Optional[str]
    resources: tuple[tuple[str, str], ...]
    actions: tuple[tuple[str, str, str, str], ...]


@dataclass(frozen=True)
class ToolSpec:
    tool_id: str
    provider_name: str
    resource_id: str
    action_id: str
    execution_mode: str = "mcp_forward"
    tool_type: str = "direct_api"
    handler_ref: Optional[str] = None
    allowed_downstream_scopes: tuple[str, ...] = ()


class BootstrapError(RuntimeError):
    """Raised when bootstrap requirements are not satisfied."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extract_json_payload(output_text: str) -> Any:
    decoder = json.JSONDecoder()
    for index, char in enumerate(output_text):
        if char not in "[{":
            continue
        candidate = output_text[index:].lstrip()
        try:
            parsed, _ = decoder.raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        return parsed
    raise BootstrapError("Could not parse JSON payload from command output")


class BootstrapRunner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.workspace = args.workspace
        self.apply = bool(args.apply)
        self.repo_root = Path(__file__).resolve().parents[3]
        self.artifact_path = Path(args.artifact_path).resolve()
        self.env_output_path = Path(args.env_output).resolve()
        self.runtime_base_url = args.runtime_base_url.rstrip("/")
        self.token_url = args.token_url.rstrip("/") if args.token_url else f"{self.runtime_base_url}/v1/ais/token"

        self.local_cli_prefix = [
            sys.executable,
            "-m",
            "caracal.cli.main",
            "--workspace",
            self.workspace,
        ]

        self.runtime_cli_prefix = [args.runtime_cmd]

        openai_credential = args.openai_api_key or os.environ.get("OPENAI_API_KEY") or "demo-openai-placeholder"
        gemini_credential = args.google_api_key or os.environ.get("GOOGLE_API_KEY") or "demo-gemini-placeholder"

        self.provider_specs: tuple[ProviderSpec, ...] = (
            ProviderSpec(
                name="swarm-openai",
                service_type="ai",
                base_url="https://api.openai.com",
                auth_scheme="api-key",
                credential=openai_credential,
                resources=(("chat.completions", "OpenAI Chat Completions"),),
                actions=(("chat.completions", "invoke", "POST", "/v1/chat/completions"),),
            ),
            ProviderSpec(
                name="swarm-gemini",
                service_type="ai",
                base_url="https://generativelanguage.googleapis.com",
                auth_scheme="api-key",
                credential=gemini_credential,
                resources=(("generateContent", "Gemini Generate Content"),),
                actions=(("generateContent", "invoke", "POST", "/v1beta/models"),),
            ),
            ProviderSpec(
                name="swarm-internal",
                service_type="internal",
                base_url="https://internal.demo.local",
                auth_scheme="none",
                credential=None,
                resources=(
                    ("finance", "Internal Finance Signals"),
                    ("ops", "Internal Ops Signals"),
                    ("orchestrator", "Internal Orchestrator Control Plane"),
                ),
                actions=(
                    ("finance", "read", "GET", "/finance"),
                    ("ops", "read", "GET", "/ops"),
                    ("orchestrator", "summarize", "POST", "/orchestrator/summarize"),
                ),
            ),
        )

        self.tool_specs: tuple[ToolSpec, ...] = (
            ToolSpec(
                tool_id="demo:swarm:openai:chat:invoke",
                provider_name="swarm-openai",
                resource_id="chat.completions",
                action_id="invoke",
            ),
            ToolSpec(
                tool_id="demo:swarm:gemini:generate:invoke",
                provider_name="swarm-gemini",
                resource_id="generateContent",
                action_id="invoke",
            ),
            ToolSpec(
                tool_id="demo:swarm:internal:finance:read",
                provider_name="swarm-internal",
                resource_id="finance",
                action_id="read",
            ),
            ToolSpec(
                tool_id="demo:swarm:internal:ops:read",
                provider_name="swarm-internal",
                resource_id="ops",
                action_id="read",
            ),
            ToolSpec(
                tool_id="demo:swarm:logic:finance:analyze",
                provider_name="swarm-internal",
                resource_id="finance",
                action_id="read",
                execution_mode="local",
                tool_type="logic",
                handler_ref="examples.caracal_langchain_swarm_demo.caracal.runtime_bridge:finance_governed_handler",
                allowed_downstream_scopes=(
                    "provider:swarm-openai:resource:chat.completions",
                    "provider:swarm-openai:action:invoke",
                    "provider:swarm-internal:resource:finance",
                    "provider:swarm-internal:action:read",
                ),
            ),
            ToolSpec(
                tool_id="demo:swarm:logic:ops:analyze",
                provider_name="swarm-internal",
                resource_id="ops",
                action_id="read",
                execution_mode="local",
                tool_type="logic",
                handler_ref="examples.caracal_langchain_swarm_demo.caracal.runtime_bridge:ops_governed_handler",
                allowed_downstream_scopes=(
                    "provider:swarm-gemini:resource:generateContent",
                    "provider:swarm-gemini:action:invoke",
                    "provider:swarm-internal:resource:ops",
                    "provider:swarm-internal:action:read",
                ),
            ),
            ToolSpec(
                tool_id="demo:swarm:logic:orchestrator:summarize",
                provider_name="swarm-internal",
                resource_id="orchestrator",
                action_id="summarize",
                execution_mode="local",
                tool_type="logic",
                handler_ref="examples.caracal_langchain_swarm_demo.caracal.runtime_bridge:orchestrator_governed_handler",
                allowed_downstream_scopes=(
                    "provider:swarm-internal:resource:finance",
                    "provider:swarm-internal:resource:ops",
                    "provider:swarm-internal:action:read",
                ),
            ),
        )

        self.principal_specs: tuple[PrincipalSpec, ...] = (
            PrincipalSpec(name="swarm-issuer", principal_kind="human", email="swarm.issuer@example.com"),
            PrincipalSpec(
                name="swarm-orchestrator",
                principal_kind="orchestrator",
                email="swarm.orchestrator@example.com",
            ),
            PrincipalSpec(name="swarm-finance", principal_kind="worker", email="swarm.finance@example.com"),
            PrincipalSpec(name="swarm-ops", principal_kind="worker", email="swarm.ops@example.com"),
        )

    def run(self) -> dict[str, Any]:
        artifacts: dict[str, Any] = {
            "timestamp_utc": _now_iso(),
            "workspace": self.workspace,
            "mode": "apply" if self.apply else "dry-run",
            "principals": {},
            "providers": [provider.name for provider in self.provider_specs],
            "tool_ids": [tool.tool_id for tool in self.tool_specs],
            "policy_id": None,
            "mandates": {},
            "runtime": {
                "base_url": self.runtime_base_url,
                "started": False,
                "health_ok": False,
            },
            "binding_contract": {
                "validated": False,
                "issues": [],
            },
            "attestation": {
                "nonce": None,
                "principal_id": None,
                "expires_at": None,
                "env_file": str(self.env_output_path),
            },
            "token": {
                "issued": False,
                "url": self.token_url,
                "expires_at": None,
                "session_id": None,
                "error": None,
            },
        }

        self._validate_tool_binding_contracts()
        artifacts["binding_contract"]["validated"] = True

        if not self.apply:
            self._dry_run_preview(artifacts)
            self._persist_artifacts(artifacts)
            return artifacts

        self._validate_runtime_prerequisites()

        if not self.args.skip_runtime_start:
            self._start_runtime(artifacts)

        self._ensure_workspace()

        principal_ids = self._ensure_principals()
        artifacts["principals"] = principal_ids

        self._ensure_providers()
        self._ensure_tools(actor_principal_id=principal_ids["swarm-issuer"])
        self._run_tool_preflight()

        policy_id = self._ensure_issuer_policy(principal_ids["swarm-issuer"])
        artifacts["policy_id"] = policy_id

        mandate_map = self._ensure_mandates(principal_ids)
        artifacts["mandates"] = mandate_map

        nonce_payload = self._issue_attestation_nonce(principal_ids["swarm-orchestrator"])
        artifacts["attestation"].update(nonce_payload)
        self._write_runtime_env_file(nonce_payload)

        if self.args.restart_runtime_for_attestation and not self.args.skip_runtime_start:
            self._restart_runtime_with_attestation(nonce_payload)

        health_ok = self._wait_for_runtime_health()
        artifacts["runtime"]["health_ok"] = health_ok

        token_payload = self._issue_ais_token(
            principal_id=principal_ids["swarm-orchestrator"],
            attestation_nonce=nonce_payload.get("nonce"),
        )
        artifacts["token"].update(token_payload)

        if self.args.require_token and not artifacts["token"]["issued"]:
            raise BootstrapError("AIS token issuance failed while --require-token is enabled")

        self._persist_artifacts(artifacts)
        return artifacts

    def _dry_run_preview(self, artifacts: dict[str, Any]) -> None:
        preview_principals = {
            principal.name: f"dryrun-{principal.name}"
            for principal in self.principal_specs
        }
        artifacts["principals"] = preview_principals
        artifacts["policy_id"] = "dryrun-policy"
        artifacts["mandates"] = {
            "orchestrator": "dryrun-mandate-orchestrator",
            "finance": "dryrun-mandate-finance",
            "ops": "dryrun-mandate-ops",
        }
        artifacts["attestation"]["nonce"] = "dryrun-attestation-nonce"
        artifacts["attestation"]["principal_id"] = preview_principals["swarm-orchestrator"]
        artifacts["attestation"]["expires_at"] = _now_iso()

    def _validate_runtime_prerequisites(self) -> None:
        if shutil.which(sys.executable) is None:
            raise BootstrapError("Python executable not found")

        if shutil.which(self.args.runtime_cmd) is None:
            raise BootstrapError(f"Runtime command '{self.args.runtime_cmd}' not found in PATH")

        if shutil.which("docker") is None:
            raise BootstrapError("Docker is required for runtime bootstrap")

    def _run_command(
        self,
        args: list[str],
        *,
        extra_env: Optional[dict[str, str]] = None,
        expect_json: bool = False,
        allow_failure: bool = False,
    ) -> Any:
        env = dict(os.environ)
        if extra_env:
            env.update(extra_env)

        result = subprocess.run(
            args,
            cwd=self.repo_root,
            check=False,
            text=True,
            capture_output=True,
            env=env,
        )

        if result.returncode != 0 and not allow_failure:
            stderr = (result.stderr or "").strip()
            stdout = (result.stdout or "").strip()
            detail = stderr or stdout or "command failed"
            raise BootstrapError(f"Command failed ({' '.join(args)}): {detail}")

        if expect_json:
            return _extract_json_payload(result.stdout or "")

        return result

    def _run_local_cli(self, cli_args: list[str], *, expect_json: bool = False) -> Any:
        command = [*self.local_cli_prefix, *cli_args]
        return self._run_command(command, expect_json=expect_json)

    def _run_runtime_cli(self, runtime_args: list[str], *, extra_env: Optional[dict[str, str]] = None) -> None:
        command = [*self.runtime_cli_prefix, *runtime_args]
        self._run_command(command, extra_env=extra_env)

    def _ensure_workspace(self) -> None:
        workspaces = self._run_local_cli(["workspace", "list", "--format", "json"], expect_json=True)
        workspace_names = {item["name"] for item in workspaces}

        if self.workspace not in workspace_names:
            self._run_local_cli(["workspace", "create", self.workspace])

        self._run_local_cli(["workspace", "use", self.workspace])

    def _ensure_principals(self) -> dict[str, str]:
        principals = self._run_local_cli(["principal", "list", "--format", "json"], expect_json=True)
        by_name = {entry["name"]: entry for entry in principals}

        resolved: dict[str, str] = {}
        for spec in self.principal_specs:
            existing = by_name.get(spec.name)
            if existing:
                resolved[spec.name] = existing["principal_id"]
                continue

            self._run_local_cli(
                [
                    "principal",
                    "register",
                    "--type",
                    spec.principal_kind,
                    "--name",
                    spec.name,
                    "--email",
                    spec.email,
                ]
            )

            principals = self._run_local_cli(["principal", "list", "--format", "json"], expect_json=True)
            by_name = {entry["name"]: entry for entry in principals}
            created = by_name.get(spec.name)
            if not created:
                raise BootstrapError(f"Principal '{spec.name}' was not found after registration")
            resolved[spec.name] = created["principal_id"]

        return resolved

    def _ensure_providers(self) -> None:
        listed = self._run_local_cli(
            ["provider", "list", "--workspace", self.workspace, "--format", "json"],
            expect_json=True,
        )
        existing_names = {entry["name"] for entry in listed.get("providers", [])}

        for provider in self.provider_specs:
            if provider.name in existing_names:
                continue

            command = [
                "provider",
                "add",
                provider.name,
                "--mode",
                "scoped",
                "--service-type",
                provider.service_type,
                "--base-url",
                provider.base_url,
                "--auth-scheme",
                provider.auth_scheme,
                "--workspace",
                self.workspace,
            ]

            if provider.credential:
                command.extend(["--credential", provider.credential])

            for resource_id, description in provider.resources:
                command.extend(["--resource", f"{resource_id}={description}"])

            for resource_id, action_id, method, path_prefix in provider.actions:
                command.extend(["--action", f"{resource_id}:{action_id}:{method}:{path_prefix}"])

            self._run_local_cli(command)

    def _ensure_tools(self, *, actor_principal_id: str) -> None:
        for tool in self.tool_specs:
            command = [
                "tool",
                "register",
                "--tool-id",
                tool.tool_id,
                "--workspace",
                self.workspace,
                "--provider-name",
                tool.provider_name,
                "--resource-id",
                tool.resource_id,
                "--action-id",
                tool.action_id,
                "--execution-mode",
                tool.execution_mode,
                "--tool-type",
                tool.tool_type,
                "--actor-principal-id",
                actor_principal_id,
            ]

            if tool.handler_ref:
                command.extend(["--handler-ref", tool.handler_ref])

            for scope in tool.allowed_downstream_scopes:
                command.extend(["--allowed-downstream-scope", scope])

            self._run_local_cli(command)

    def _run_tool_preflight(self) -> None:
        self._run_local_cli(["tool", "preflight"])

    def _validate_tool_binding_contracts(self) -> None:
        providers = {provider.name: provider for provider in self.provider_specs}
        seen_tool_ids: set[str] = set()

        for tool in self.tool_specs:
            if tool.tool_id in seen_tool_ids:
                raise BootstrapError(f"Duplicate tool_id in demo bootstrap spec: {tool.tool_id}")
            seen_tool_ids.add(tool.tool_id)

            provider = providers.get(tool.provider_name)
            if provider is None:
                raise BootstrapError(
                    f"Tool '{tool.tool_id}' references unknown provider '{tool.provider_name}'"
                )

            provider_resources = {resource_id for resource_id, _ in provider.resources}
            if tool.resource_id not in provider_resources:
                raise BootstrapError(
                    f"Tool '{tool.tool_id}' references unknown resource '{tool.resource_id}' "
                    f"for provider '{tool.provider_name}'"
                )

            provider_actions = {
                (resource_id, action_id)
                for resource_id, action_id, _, _ in provider.actions
            }
            if (tool.resource_id, tool.action_id) not in provider_actions:
                raise BootstrapError(
                    f"Tool '{tool.tool_id}' references unknown action '{tool.action_id}' "
                    f"for resource '{tool.resource_id}' on provider '{tool.provider_name}'"
                )

            if tool.tool_type == "logic":
                if tool.execution_mode != "local":
                    raise BootstrapError(
                        f"Logic tool '{tool.tool_id}' must use execution_mode=local"
                    )
                if not tool.handler_ref:
                    raise BootstrapError(
                        f"Logic tool '{tool.tool_id}' must define handler_ref"
                    )
                self._validate_handler_ref(tool.handler_ref)
                if not tool.allowed_downstream_scopes:
                    raise BootstrapError(
                        f"Logic tool '{tool.tool_id}' must declare allowed_downstream_scopes"
                    )
                continue

            if tool.execution_mode != "mcp_forward":
                raise BootstrapError(
                    f"Direct API tool '{tool.tool_id}' must use execution_mode=mcp_forward"
                )
            if tool.handler_ref:
                raise BootstrapError(
                    f"Direct API tool '{tool.tool_id}' cannot define handler_ref"
                )

    @staticmethod
    def _validate_handler_ref(handler_ref: str) -> None:
        module_name, separator, function_name = str(handler_ref or "").partition(":")
        if not separator or not module_name or not function_name:
            raise BootstrapError(
                f"Invalid handler_ref '{handler_ref}'. Expected format module:function"
            )

        try:
            module = importlib.import_module(module_name)
        except Exception as exc:
            raise BootstrapError(
                f"Failed to import handler module '{module_name}' for '{handler_ref}': {exc}"
            ) from exc

        handler = getattr(module, function_name, None)
        if not callable(handler):
            raise BootstrapError(f"Handler '{handler_ref}' is not callable")

    def _scopes_for_tools(self, tool_ids: list[str]) -> tuple[list[str], list[str]]:
        lookup = {tool.tool_id: tool for tool in self.tool_specs}
        resources: list[str] = []
        actions: list[str] = []
        for tool_id in tool_ids:
            tool = lookup[tool_id]
            resources.append(f"provider:{tool.provider_name}:resource:{tool.resource_id}")
            actions.append(f"provider:{tool.provider_name}:action:{tool.action_id}")
        return resources, actions

    def _ensure_issuer_policy(self, issuer_principal_id: str) -> str:
        policies = self._run_local_cli(["policy", "list", "--active-only", "--format", "json"], expect_json=True)
        for policy in policies:
            if policy.get("principal_id") == issuer_principal_id:
                return str(policy["policy_id"])

        resources: list[str] = []
        actions: list[str] = []
        providers: set[str] = set()
        for tool in self.tool_specs:
            resources.append(f"provider:{tool.provider_name}:resource:{tool.resource_id}")
            actions.append(f"provider:{tool.provider_name}:action:{tool.action_id}")
            providers.add(tool.provider_name)

        command = [
            "policy",
            "create",
            "--principal-id",
            issuer_principal_id,
            "--max-validity-seconds",
            str(self.args.policy_validity_seconds),
            "--allow-delegation",
            "--max-delegation-network-distance",
            str(self.args.max_delegation_network_distance),
            "--format",
            "json",
        ]

        for provider in sorted(providers):
            command.extend(["--provider", provider])
        for resource in resources:
            command.extend(["--resource-pattern", resource])
        for action in actions:
            command.extend(["--action", action])

        payload = self._run_local_cli(command, expect_json=True)
        return str(payload["policy_id"])

    def _ensure_mandates(self, principal_ids: dict[str, str]) -> dict[str, str]:
        role_tool_ids = {
            "orchestrator": [
                "demo:swarm:logic:orchestrator:summarize",
                "demo:swarm:logic:finance:analyze",
                "demo:swarm:logic:ops:analyze",
                "demo:swarm:internal:finance:read",
                "demo:swarm:internal:ops:read",
            ],
            "finance": [
                "demo:swarm:logic:finance:analyze",
                "demo:swarm:openai:chat:invoke",
                "demo:swarm:internal:finance:read",
            ],
            "ops": [
                "demo:swarm:logic:ops:analyze",
                "demo:swarm:gemini:generate:invoke",
                "demo:swarm:internal:ops:read",
            ],
        }

        subject_lookup = {
            "orchestrator": principal_ids["swarm-orchestrator"],
            "finance": principal_ids["swarm-finance"],
            "ops": principal_ids["swarm-ops"],
        }

        mandates = self._run_local_cli(
            ["authority", "list", "--active-only", "--format", "json"],
            expect_json=True,
        )

        resolved: dict[str, str] = {}
        issuer_id = principal_ids["swarm-issuer"]

        for role, subject_id in subject_lookup.items():
            required_resources, required_actions = self._scopes_for_tools(role_tool_ids[role])
            existing = self._find_matching_mandate(
                mandates,
                issuer_id=issuer_id,
                subject_id=subject_id,
                required_resources=required_resources,
                required_actions=required_actions,
            )
            if existing:
                resolved[role] = existing
                continue

            command = [
                "authority",
                "mandate",
                "--issuer-id",
                issuer_id,
                "--subject-id",
                subject_id,
                "--validity-seconds",
                str(self.args.mandate_validity_seconds),
                "--format",
                "json",
            ]
            for tool_id in role_tool_ids[role]:
                command.extend(["--tool-id", tool_id])

            payload = self._run_local_cli(command, expect_json=True)
            mandate_id = str(payload["mandate_id"])
            resolved[role] = mandate_id

            mandates = self._run_local_cli(
                ["authority", "list", "--active-only", "--format", "json"],
                expect_json=True,
            )

        return resolved

    @staticmethod
    def _find_matching_mandate(
        mandates: list[dict[str, Any]],
        *,
        issuer_id: str,
        subject_id: str,
        required_resources: list[str],
        required_actions: list[str],
    ) -> Optional[str]:
        required_resource_set = set(required_resources)
        required_action_set = set(required_actions)

        for mandate in mandates:
            if mandate.get("issuer_id") != issuer_id or mandate.get("subject_id") != subject_id:
                continue

            mandate_resources = set(mandate.get("resource_scope") or [])
            mandate_actions = set(mandate.get("action_scope") or [])

            if required_resource_set.issubset(mandate_resources) and required_action_set.issubset(mandate_actions):
                return str(mandate["mandate_id"])

        return None

    def _start_runtime(self, artifacts: dict[str, Any]) -> None:
        runtime_args = ["up"]
        if self.args.no_pull:
            runtime_args.append("--no-pull")
        self._run_runtime_cli(runtime_args)
        artifacts["runtime"]["started"] = True

    def _restart_runtime_with_attestation(self, nonce_payload: dict[str, Optional[str]]) -> None:
        self._run_runtime_cli(["down"])

        runtime_env = {
            "CARACAL_AIS_ATTESTATION_NONCE": nonce_payload["nonce"] or "",
            "CARACAL_AIS_ATTESTATION_PRINCIPAL_ID": nonce_payload["principal_id"] or "",
            "CARACAL_AIS_PRINCIPAL_ID": nonce_payload["principal_id"] or "",
            "CARACAL_AIS_ORGANIZATION_ID": self.args.organization_id,
            "CARACAL_AIS_TENANT_ID": self.args.tenant_id,
        }
        runtime_args = ["up"]
        if self.args.no_pull:
            runtime_args.append("--no-pull")
        self._run_runtime_cli(runtime_args, extra_env=runtime_env)

    def _issue_attestation_nonce(self, principal_id: str) -> dict[str, Optional[str]]:
        redis_client = RedisClient(
            host=self.args.redis_host,
            port=self.args.redis_port,
            password=self.args.redis_password or None,
        )
        manager = AttestationNonceManager(redis_client, ttl_seconds=self.args.attestation_ttl_seconds)
        issued = manager.issue_nonce(principal_id)
        return {
            "nonce": issued.nonce,
            "principal_id": issued.principal_id,
            "expires_at": issued.expires_at.astimezone(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
        }

    def _write_runtime_env_file(self, nonce_payload: dict[str, Optional[str]]) -> None:
        self.env_output_path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            f"CARACAL_AIS_ATTESTATION_NONCE={nonce_payload.get('nonce') or ''}",
            f"CARACAL_AIS_ATTESTATION_PRINCIPAL_ID={nonce_payload.get('principal_id') or ''}",
            f"CARACAL_AIS_PRINCIPAL_ID={nonce_payload.get('principal_id') or ''}",
            f"CARACAL_AIS_ORGANIZATION_ID={self.args.organization_id}",
            f"CARACAL_AIS_TENANT_ID={self.args.tenant_id}",
        ]
        self.env_output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def _wait_for_runtime_health(self) -> bool:
        health_url = f"{self.runtime_base_url}/health"
        deadline = datetime.now(timezone.utc).timestamp() + max(self.args.health_timeout_seconds, 1)

        while datetime.now(timezone.utc).timestamp() < deadline:
            try:
                with urllib.request.urlopen(health_url, timeout=self.args.health_probe_timeout_seconds) as response:
                    if int(getattr(response, "status", 0)) == 200:
                        return True
            except Exception:
                pass
        return False

    def _issue_ais_token(self, *, principal_id: str, attestation_nonce: Optional[str]) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "principal_id": principal_id,
            "organization_id": self.args.organization_id,
            "tenant_id": self.args.tenant_id,
            "session_kind": self.args.session_kind,
            "include_refresh": True,
        }
        if attestation_nonce:
            payload["attestation_nonce"] = attestation_nonce

        headers = {"Content-Type": "application/json"}
        caller_token = self.args.ais_caller_token or os.environ.get("CARACAL_AIS_CALLER_TOKEN")
        if caller_token:
            headers["Authorization"] = f"Bearer {caller_token}"

        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.token_url, data=body, headers=headers, method="POST")

        try:
            with urllib.request.urlopen(request, timeout=self.args.token_timeout_seconds) as response:
                raw = response.read().decode("utf-8")
                parsed = json.loads(raw)
                return {
                    "issued": True,
                    "expires_at": parsed.get("expires_at"),
                    "session_id": parsed.get("session_id"),
                    "error": None,
                }
        except urllib.error.HTTPError as exc:
            error_text = exc.read().decode("utf-8", errors="ignore")
            return {
                "issued": False,
                "expires_at": None,
                "session_id": None,
                "error": f"HTTP {exc.code}: {error_text}",
            }
        except Exception as exc:
            return {
                "issued": False,
                "expires_at": None,
                "session_id": None,
                "error": str(exc),
            }

    def _persist_artifacts(self, artifacts: dict[str, Any]) -> None:
        self.artifact_path.parent.mkdir(parents=True, exist_ok=True)
        self.artifact_path.write_text(json.dumps(artifacts, indent=2) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap Caracal LangChain swarm demo resources")

    parser.add_argument("--apply", action="store_true", help="Apply mutations; default is dry-run preview")
    parser.add_argument(
        "--workspace",
        default="caracal-langchain-swarm-demo",
        help="Workspace name for provisioning",
    )

    parser.add_argument(
        "--artifact-path",
        default=str(Path(__file__).resolve().parent / "artifacts" / "bootstrap_artifacts.json"),
        help="JSON path for bootstrap output artifacts",
    )
    parser.add_argument(
        "--env-output",
        default=str(Path(__file__).resolve().parent / "artifacts" / "runtime_startup.env"),
        help="Environment file path for startup attestation values",
    )

    parser.add_argument("--runtime-cmd", default="caracal", help="Runtime command for up/down orchestration")
    parser.add_argument("--skip-runtime-start", action="store_true", help="Skip runtime startup orchestration")
    parser.add_argument("--restart-runtime-for-attestation", action="store_true", help="Restart runtime using attestation env values")
    parser.add_argument("--no-pull", action="store_true", help="Pass --no-pull when starting runtime")

    parser.add_argument("--runtime-base-url", default="http://127.0.0.1:8000", help="Runtime base URL for health probe")
    parser.add_argument("--token-url", default=None, help="Override AIS token endpoint URL")
    parser.add_argument("--health-timeout-seconds", type=int, default=30)
    parser.add_argument("--health-probe-timeout-seconds", type=int, default=3)
    parser.add_argument("--token-timeout-seconds", type=int, default=8)
    parser.add_argument("--require-token", action="store_true", help="Fail bootstrap if token issuance fails")

    parser.add_argument("--organization-id", default="demo-org")
    parser.add_argument("--tenant-id", default="demo-tenant")
    parser.add_argument("--session-kind", default="automation")
    parser.add_argument("--ais-caller-token", default=None)

    parser.add_argument("--openai-api-key", default=None)
    parser.add_argument("--google-api-key", default=None)

    parser.add_argument("--redis-host", default="127.0.0.1")
    parser.add_argument("--redis-port", type=int, default=6379)
    parser.add_argument("--redis-password", default=None)
    parser.add_argument("--attestation-ttl-seconds", type=int, default=300)

    parser.add_argument("--policy-validity-seconds", type=int, default=7200)
    parser.add_argument("--mandate-validity-seconds", type=int, default=3600)
    parser.add_argument("--max-delegation-network-distance", type=int, default=2)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        artifacts = BootstrapRunner(args).run()
        print(f"Bootstrap completed in {artifacts['mode']} mode")
        print(f"Artifacts: {Path(args.artifact_path).resolve()}")
        print(f"Startup env: {Path(args.env_output).resolve()}")
        return 0
    except BootstrapError as exc:
        print(f"Bootstrap failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
