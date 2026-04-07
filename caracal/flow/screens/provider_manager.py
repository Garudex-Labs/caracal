"""
Provider Manager screen.

Provider configuration is workspace-local in open-source mode and
provider-definition-driven across all flows.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re
from typing import Optional
from urllib.parse import urlparse

from prompt_toolkit import prompt as pt_prompt
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.key_binding import KeyBindings
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table

from caracal.deployment import ConfigManager, get_deployment_edition_adapter
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.flow.components.menu import Menu, MenuItem
from caracal.flow.components.prompt import FlowPrompt, FlowValidator
from caracal.flow.screens._workspace_helpers import get_active_workspace_name
from caracal.flow.state import FlowState, RecentAction
from caracal.flow.theme import Colors, Icons
from caracal.provider.catalog import (
    AUTH_SCHEME_GUIDANCE as SHARED_AUTH_SCHEME_GUIDANCE,
    GATEWAY_ONLY_AUTH as SHARED_GATEWAY_ONLY_AUTH,
    PROVIDER_PATTERNS as SHARED_PROVIDER_PATTERNS,
    SERVICE_TYPE_GUIDANCE as SHARED_SERVICE_TYPE_GUIDANCE,
    build_provider_record,
    build_resources_from_pattern as shared_build_resources_from_pattern,
)
from caracal.provider.definitions import (
    build_action_scope,
    build_resource_scope,
    resolve_provider_definition_id,
)
from caracal.provider.credential_store import (
    delete_workspace_provider_credential,
    store_workspace_provider_credential,
)
from caracal.provider.workspace import (
    load_workspace_provider_registry,
    save_workspace_provider_registry,
)


_IDENTIFIER_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
_GATEWAY_ONLY_AUTH = {"oauth2_client_credentials", "service_account"}

_SERVICE_TYPE_GUIDANCE = {
    "application": {
        "purpose": "Business APIs, SaaS backends, and general REST/HTTP services.",
        "examples": "tickets, users, orders, webhooks",
        "caracal_use": "Groups external app capabilities into provider-scoped resources and actions.",
    },
    "ai": {
        "purpose": "Model inference, embeddings, assistants, and evaluation APIs.",
        "examples": "chat.completions, embeddings, models, responses",
        "caracal_use": "Defines the AI operations mandates, delegation, and execution can authorize.",
    },
    "data": {
        "purpose": "Databases, warehouses, query engines, and vector/search services.",
        "examples": "queries, tables, indexes, vectors",
        "caracal_use": "Separates read/query surfaces from write, ingest, or migration actions.",
    },
    "identity": {
        "purpose": "Identity providers, directories, access control, and SCIM/OIDC admin APIs.",
        "examples": "users, groups, clients, sessions",
        "caracal_use": "Makes it clear when a provider can read identities versus mutate access state.",
    },
    "messaging": {
        "purpose": "Email, chat, SMS, event delivery, and webhook relay providers.",
        "examples": "messages, templates, events, deliveries",
        "caracal_use": "Lets policies distinguish send, publish, receive, and delivery-management actions.",
    },
    "storage": {
        "purpose": "Object storage, file APIs, and document repositories.",
        "examples": "objects, buckets, files, documents",
        "caracal_use": "Scopes read, upload, delete, and lifecycle operations on stored content.",
    },
    "payments": {
        "purpose": "Payment processors, billing systems, subscriptions, and invoicing APIs.",
        "examples": "charges, customers, invoices, refunds",
        "caracal_use": "Separates sensitive billing actions such as charge, refund, and payout.",
    },
    "developer-tools": {
        "purpose": "SCM, CI/CD, issue trackers, artifact registries, and engineering platforms.",
        "examples": "repos, pull_requests, builds, issues",
        "caracal_use": "Defines developer workflow operations that agents may observe or mutate.",
    },
    "observability": {
        "purpose": "Logs, metrics, traces, alerts, incidents, and monitoring control planes.",
        "examples": "logs, dashboards, alerts, incidents",
        "caracal_use": "Separates read/observe capabilities from alerting, silencing, or incident actions.",
    },
    "infrastructure": {
        "purpose": "Cloud, cluster, deployment, and runtime control planes.",
        "examples": "deployments, jobs, clusters",
        "caracal_use": "Lets policies distinguish observe, deploy, restart, and mutate operations.",
    },
    "internal": {
        "purpose": "Internal services, adapters, and webhooks.",
        "examples": "events, tasks, approvals",
        "caracal_use": "Captures internal actions that still require explicit authority.",
    },
}

_AUTH_SCHEME_GUIDANCE = {
    "none": {
        "expects": "No credential input.",
        "caracal_use": "Calls the provider without injecting auth material.",
        "example": "Public health endpoint or trusted internal service.",
    },
    "api_key": {
        "expects": "Single API key or token string.",
        "caracal_use": "Injects the credential as X-API-Key for direct OSS execution.",
        "example": "sk_live_abc123",
    },
    "bearer": {
        "expects": "Token value only, without the 'Bearer ' prefix.",
        "caracal_use": "Builds Authorization: Bearer <token> for requests.",
        "example": "eyJhbGciOi...",
    },
    "basic": {
        "expects": "username:password in one block.",
        "caracal_use": "Base64-encodes the pair into the Authorization header.",
        "example": "service-user:super-secret-password",
    },
    "header": {
        "expects": "Any credential string plus an explicit header name.",
        "caracal_use": "Sends the exact header/value pair you define.",
        "example": "Header name X-Provider-Key with value tenant-123|secret-456",
    },
    "oauth2_client_credentials": {
        "expects": "Client secret material, token exchange config, or provider-specific bundle.",
        "caracal_use": "Stores the secret block exactly as entered for gateway-mediated auth exchange.",
        "example": "client_id/client_secret JSON or multiline credential block.",
    },
    "service_account": {
        "expects": "JSON key, PEM, signed header block, or other multiline service credential.",
        "caracal_use": "Stores the exact block for gateway-mediated runtime authentication.",
        "example": "JSON credentials, PEM text, or quoted multiline secret.",
    },
}


@dataclass(frozen=True)
class ActionStarter:
    action_id: str
    description: str
    method: str
    path_prefix: str


@dataclass(frozen=True)
class ResourceStarter:
    resource_id: str
    description: str
    actions: tuple[ActionStarter, ...]


@dataclass(frozen=True)
class ProviderStarterPattern:
    key: str
    label: str
    description: str
    service_type: str
    recommended_auth_scheme: str
    base_url_example: str
    resources: tuple[ResourceStarter, ...]


_PROVIDER_PATTERNS = {
    "ai": (
        ProviderStarterPattern(
            key="ai_chat_platform",
            label="Chat + embeddings API",
            description="Common AI provider surface with inference, embeddings, and model listing.",
            service_type="ai",
            recommended_auth_scheme="bearer",
            base_url_example="https://api.example-llm.com",
            resources=(
                ResourceStarter(
                    resource_id="responses",
                    description="Primary text and multimodal generation endpoint",
                    actions=(
                        ActionStarter("create", "Create a model response", "POST", "/v1/responses"),
                    ),
                ),
                ResourceStarter(
                    resource_id="embeddings",
                    description="Embedding generation endpoint",
                    actions=(
                        ActionStarter("embed", "Generate vector embeddings", "POST", "/v1/embeddings"),
                    ),
                ),
                ResourceStarter(
                    resource_id="models",
                    description="Model catalog endpoint",
                    actions=(
                        ActionStarter("list", "List available models", "GET", "/v1/models"),
                    ),
                ),
            ),
        ),
        ProviderStarterPattern(
            key="ai_assistant_runtime",
            label="Assistant / agent runtime",
            description="Assistant, thread, run, and tool-driven AI execution surface.",
            service_type="ai",
            recommended_auth_scheme="bearer",
            base_url_example="https://assistants.example-ai.com",
            resources=(
                ResourceStarter(
                    resource_id="assistants",
                    description="Assistant configuration and execution surface",
                    actions=(
                        ActionStarter("create", "Create or update an assistant", "POST", "/v1/assistants"),
                        ActionStarter("list", "List assistants", "GET", "/v1/assistants"),
                    ),
                ),
                ResourceStarter(
                    resource_id="runs",
                    description="Thread and run execution surface",
                    actions=(
                        ActionStarter("create", "Start an assistant run", "POST", "/v1/threads/runs"),
                        ActionStarter("read", "Inspect a run", "GET", "/v1/threads/runs"),
                    ),
                ),
            ),
        ),
    ),
    "application": (
        ProviderStarterPattern(
            key="saas_crud_api",
            label="SaaS CRUD API",
            description="A standard business API with list/create/update/delete routes.",
            service_type="application",
            recommended_auth_scheme="api_key",
            base_url_example="https://api.example.com",
            resources=(
                ResourceStarter(
                    resource_id="records",
                    description="Primary business objects exposed by the API",
                    actions=(
                        ActionStarter("list", "List records", "GET", "/v1/records"),
                        ActionStarter("create", "Create a record", "POST", "/v1/records"),
                        ActionStarter("update", "Update a record", "PATCH", "/v1/records"),
                        ActionStarter("delete", "Delete a record", "DELETE", "/v1/records"),
                    ),
                ),
            ),
        ),
        ProviderStarterPattern(
            key="workflow_ticketing_api",
            label="Workflow / ticketing API",
            description="Approval, ticketing, or workflow system with human-review and state transitions.",
            service_type="application",
            recommended_auth_scheme="bearer",
            base_url_example="https://workflow.example.com",
            resources=(
                ResourceStarter(
                    resource_id="tickets",
                    description="Ticket and case management surface",
                    actions=(
                        ActionStarter("list", "List tickets", "GET", "/v1/tickets"),
                        ActionStarter("create", "Create a ticket", "POST", "/v1/tickets"),
                        ActionStarter("update", "Update a ticket", "PATCH", "/v1/tickets"),
                    ),
                ),
                ResourceStarter(
                    resource_id="approvals",
                    description="Approval workflow surface",
                    actions=(
                        ActionStarter("request", "Request approval", "POST", "/v1/approvals"),
                        ActionStarter("resolve", "Resolve approval", "POST", "/v1/approvals/resolve"),
                    ),
                ),
            ),
        ),
    ),
    "data": (
        ProviderStarterPattern(
            key="sql_gateway",
            label="SQL / warehouse gateway",
            description="Read/write query execution through an HTTP database facade.",
            service_type="data",
            recommended_auth_scheme="basic",
            base_url_example="https://db.example.com",
            resources=(
                ResourceStarter(
                    resource_id="queries",
                    description="Ad hoc query execution",
                    actions=(
                        ActionStarter("read", "Run a read-only query", "POST", "/query/read"),
                        ActionStarter("write", "Run a mutating query", "POST", "/query/write"),
                    ),
                ),
                ResourceStarter(
                    resource_id="schemas",
                    description="Schema inspection and migration operations",
                    actions=(
                        ActionStarter("inspect", "Inspect schema metadata", "GET", "/schema"),
                        ActionStarter("migrate", "Apply schema changes", "POST", "/schema/migrate"),
                    ),
                ),
            ),
        ),
        ProviderStarterPattern(
            key="vector_search_api",
            label="Vector / search API",
            description="Embedding index and retrieval service for semantic lookup workloads.",
            service_type="data",
            recommended_auth_scheme="api_key",
            base_url_example="https://search.example.com",
            resources=(
                ResourceStarter(
                    resource_id="indexes",
                    description="Vector index management surface",
                    actions=(
                        ActionStarter("list", "List indexes", "GET", "/v1/indexes"),
                        ActionStarter("upsert", "Create or update vectors", "POST", "/v1/indexes"),
                    ),
                ),
                ResourceStarter(
                    resource_id="search",
                    description="Semantic search query surface",
                    actions=(
                        ActionStarter("query", "Run a vector search", "POST", "/v1/query"),
                    ),
                ),
            ),
        ),
    ),
    "identity": (
        ProviderStarterPattern(
            key="directory_admin_api",
            label="Directory / SCIM admin API",
            description="Identity directory, SCIM, and user/group lifecycle management.",
            service_type="identity",
            recommended_auth_scheme="bearer",
            base_url_example="https://id.example.com",
            resources=(
                ResourceStarter(
                    resource_id="users",
                    description="User lifecycle management surface",
                    actions=(
                        ActionStarter("list", "List users", "GET", "/scim/v2/Users"),
                        ActionStarter("create", "Create a user", "POST", "/scim/v2/Users"),
                        ActionStarter("update", "Update a user", "PATCH", "/scim/v2/Users"),
                    ),
                ),
                ResourceStarter(
                    resource_id="groups",
                    description="Group and membership management surface",
                    actions=(
                        ActionStarter("list", "List groups", "GET", "/scim/v2/Groups"),
                        ActionStarter("update", "Update group membership", "PATCH", "/scim/v2/Groups"),
                    ),
                ),
            ),
        ),
    ),
    "messaging": (
        ProviderStarterPattern(
            key="notification_platform",
            label="Notifications / messaging API",
            description="Email, SMS, or chat provider with outbound delivery and template management.",
            service_type="messaging",
            recommended_auth_scheme="bearer",
            base_url_example="https://notify.example.com",
            resources=(
                ResourceStarter(
                    resource_id="messages",
                    description="Outbound message delivery surface",
                    actions=(
                        ActionStarter("send", "Send a message", "POST", "/v1/messages"),
                        ActionStarter("status", "Check delivery status", "GET", "/v1/messages"),
                    ),
                ),
                ResourceStarter(
                    resource_id="templates",
                    description="Reusable message template surface",
                    actions=(
                        ActionStarter("list", "List templates", "GET", "/v1/templates"),
                        ActionStarter("render", "Render a template", "POST", "/v1/templates/render"),
                    ),
                ),
            ),
        ),
        ProviderStarterPattern(
            key="event_gateway",
            label="Webhook / event gateway",
            description="Inbound event receiver or outbound event publisher with signature validation.",
            service_type="messaging",
            recommended_auth_scheme="header",
            base_url_example="https://events.example.com",
            resources=(
                ResourceStarter(
                    resource_id="events",
                    description="Event publish and validation surface",
                    actions=(
                        ActionStarter("publish", "Publish an event", "POST", "/v1/events"),
                        ActionStarter("validate", "Validate an event signature", "POST", "/v1/events/validate"),
                    ),
                ),
            ),
        ),
    ),
    "storage": (
        ProviderStarterPattern(
            key="object_storage_api",
            label="Object / file storage API",
            description="Bucket or file-oriented storage service with upload, read, and delete operations.",
            service_type="storage",
            recommended_auth_scheme="header",
            base_url_example="https://storage.example.com",
            resources=(
                ResourceStarter(
                    resource_id="objects",
                    description="Object read and write surface",
                    actions=(
                        ActionStarter("list", "List objects", "GET", "/v1/objects"),
                        ActionStarter("upload", "Upload an object", "POST", "/v1/objects"),
                        ActionStarter("delete", "Delete an object", "DELETE", "/v1/objects"),
                    ),
                ),
                ResourceStarter(
                    resource_id="buckets",
                    description="Bucket configuration surface",
                    actions=(
                        ActionStarter("list", "List buckets", "GET", "/v1/buckets"),
                    ),
                ),
            ),
        ),
    ),
    "payments": (
        ProviderStarterPattern(
            key="billing_api",
            label="Payments / billing API",
            description="Charges, refunds, customers, and invoice workflows.",
            service_type="payments",
            recommended_auth_scheme="bearer",
            base_url_example="https://payments.example.com",
            resources=(
                ResourceStarter(
                    resource_id="charges",
                    description="Charge creation and inspection surface",
                    actions=(
                        ActionStarter("create", "Create a charge", "POST", "/v1/charges"),
                        ActionStarter("read", "Inspect a charge", "GET", "/v1/charges"),
                        ActionStarter("refund", "Refund a charge", "POST", "/v1/refunds"),
                    ),
                ),
                ResourceStarter(
                    resource_id="customers",
                    description="Customer billing profile surface",
                    actions=(
                        ActionStarter("list", "List customers", "GET", "/v1/customers"),
                        ActionStarter("update", "Update customer billing details", "PATCH", "/v1/customers"),
                    ),
                ),
            ),
        ),
    ),
    "developer-tools": (
        ProviderStarterPattern(
            key="scm_ci_platform",
            label="SCM / CI platform",
            description="Source control, pull request, and build automation APIs.",
            service_type="developer-tools",
            recommended_auth_scheme="bearer",
            base_url_example="https://dev.example.com",
            resources=(
                ResourceStarter(
                    resource_id="repositories",
                    description="Repository metadata and content surface",
                    actions=(
                        ActionStarter("list", "List repositories", "GET", "/v1/repos"),
                        ActionStarter("read", "Read repository metadata", "GET", "/v1/repos"),
                    ),
                ),
                ResourceStarter(
                    resource_id="pull_requests",
                    description="Pull request review and merge surface",
                    actions=(
                        ActionStarter("list", "List pull requests", "GET", "/v1/pull-requests"),
                        ActionStarter("merge", "Merge a pull request", "POST", "/v1/pull-requests/merge"),
                    ),
                ),
                ResourceStarter(
                    resource_id="builds",
                    description="Build and pipeline execution surface",
                    actions=(
                        ActionStarter("run", "Start a build or pipeline", "POST", "/v1/builds"),
                        ActionStarter("cancel", "Cancel a build or pipeline", "POST", "/v1/builds/cancel"),
                    ),
                ),
            ),
        ),
    ),
    "observability": (
        ProviderStarterPattern(
            key="monitoring_platform",
            label="Monitoring / incident platform",
            description="Logs, alerts, metrics, and incident-response control surface.",
            service_type="observability",
            recommended_auth_scheme="bearer",
            base_url_example="https://observability.example.com",
            resources=(
                ResourceStarter(
                    resource_id="alerts",
                    description="Alert management surface",
                    actions=(
                        ActionStarter("list", "List alerts", "GET", "/v1/alerts"),
                        ActionStarter("silence", "Silence an alert", "POST", "/v1/alerts/silence"),
                    ),
                ),
                ResourceStarter(
                    resource_id="incidents",
                    description="Incident workflow surface",
                    actions=(
                        ActionStarter("create", "Create an incident", "POST", "/v1/incidents"),
                        ActionStarter("resolve", "Resolve an incident", "POST", "/v1/incidents/resolve"),
                    ),
                ),
                ResourceStarter(
                    resource_id="logs",
                    description="Log query surface",
                    actions=(
                        ActionStarter("query", "Query logs", "POST", "/v1/logs/query"),
                    ),
                ),
            ),
        ),
    ),
    "infrastructure": (
        ProviderStarterPattern(
            key="deployment_control",
            label="Deployment control plane",
            description="Release, observe, and operate environments or jobs.",
            service_type="infrastructure",
            recommended_auth_scheme="bearer",
            base_url_example="https://control.example.com",
            resources=(
                ResourceStarter(
                    resource_id="deployments",
                    description="Deployment operations",
                    actions=(
                        ActionStarter("list", "List deployments", "GET", "/v1/deployments"),
                        ActionStarter("deploy", "Start a deployment", "POST", "/v1/deployments"),
                        ActionStarter("rollback", "Rollback a deployment", "POST", "/v1/deployments/rollback"),
                    ),
                ),
                ResourceStarter(
                    resource_id="jobs",
                    description="Background job control",
                    actions=(
                        ActionStarter("run", "Run a job", "POST", "/v1/jobs"),
                        ActionStarter("cancel", "Cancel a running job", "POST", "/v1/jobs/cancel"),
                    ),
                ),
                ResourceStarter(
                    resource_id="clusters",
                    description="Cluster and runtime management surface",
                    actions=(
                        ActionStarter("read", "Read cluster state", "GET", "/v1/clusters"),
                        ActionStarter("restart", "Restart a workload", "POST", "/v1/clusters/restart"),
                    ),
                ),
            ),
        ),
    ),
    "internal": (
        ProviderStarterPattern(
            key="internal_service",
            label="Internal service endpoint",
            description="Trusted service-to-service calls with simple task surfaces.",
            service_type="internal",
            recommended_auth_scheme="none",
            base_url_example="https://internal.example.local",
            resources=(
                ResourceStarter(
                    resource_id="tasks",
                    description="Internal task execution surface",
                    actions=(
                        ActionStarter("dispatch", "Dispatch a task", "POST", "/tasks/dispatch"),
                        ActionStarter("status", "Read task status", "GET", "/tasks"),
                    ),
                ),
                ResourceStarter(
                    resource_id="approvals",
                    description="Human-in-the-loop approval surface",
                    actions=(
                        ActionStarter("request", "Request approval", "POST", "/approvals"),
                        ActionStarter("resolve", "Resolve approval", "POST", "/approvals/resolve"),
                    ),
                ),
            ),
        ),
    ),
}

# Shared provider contract source of truth. The local literals above remain for
# test/import stability, but all runtime flows use the shared catalog so CLI,
# TUI, and enterprise APIs stay aligned.
_SERVICE_TYPE_GUIDANCE = SHARED_SERVICE_TYPE_GUIDANCE
_AUTH_SCHEME_GUIDANCE = SHARED_AUTH_SCHEME_GUIDANCE
_PROVIDER_PATTERNS = SHARED_PROVIDER_PATTERNS
_GATEWAY_ONLY_AUTH = SHARED_GATEWAY_ONLY_AUTH


def _available_patterns(service_type: str) -> tuple[ProviderStarterPattern, ...]:
    return tuple(
        pattern
        for pattern in _PROVIDER_PATTERNS.get(service_type, ())
        if pattern.recommended_auth_scheme not in _GATEWAY_ONLY_AUTH
    )


def _resolve_pattern_by_key(pattern_key: Optional[str]) -> Optional[ProviderStarterPattern]:
    if not pattern_key:
        return None
    for patterns in _PROVIDER_PATTERNS.values():
        for pattern in patterns:
            if pattern.key == pattern_key:
                return pattern
    return None


def _provider_mode(entry: dict[str, object]) -> str:
    definition = entry.get("definition")
    has_resources = isinstance(definition, dict) and bool(definition.get("resources"))
    if entry.get("enforce_scoped_requests") and has_resources:
        return "scoped"
    return "passthrough"


def _provider_template_label(entry: dict[str, object]) -> str:
    template_id = entry.get("template_id")
    if template_id:
        return str(template_id)
    metadata = entry.get("metadata")
    if isinstance(metadata, dict) and metadata.get("starter_pattern"):
        return str(metadata["starter_pattern"])
    return "custom"


def _provider_credential_status(entry: dict[str, object]) -> str:
    auth_scheme = str(entry.get("auth_scheme") or "none")
    if auth_scheme == "none":
        return "not required"
    return "configured" if entry.get("credential_ref") else "missing"


def _definition_payload_for_existing_resources(
    entry: dict[str, object],
    *,
    provider_name: str,
    service_type: str,
    definition_id: str,
    auth_scheme: str,
    base_url: Optional[str],
    metadata: dict[str, object],
) -> Optional[dict[str, object]]:
    definition = entry.get("definition")
    if not isinstance(definition, dict):
        return None
    resources = dict(definition.get("resources") or {})
    if not resources:
        return None
    return {
        "definition_id": definition_id,
        "service_type": service_type,
        "display_name": provider_name,
        "auth_scheme": auth_scheme,
        "default_base_url": base_url,
        "resources": resources,
        "metadata": dict(metadata),
    }


def show_provider_manager(console: Console, state: FlowState) -> None:
    """Display provider manager interface."""
    while True:
        console.clear()
        console.print(
            Panel(
                f"[{Colors.PRIMARY}]Provider Manager[/]",
                subtitle=f"[{Colors.HINT}]Provider-defined resource/action catalog[/]",
                border_style=Colors.INFO,
            )
        )
        console.print()

        menu = Menu(
            "Provider Operations",
            items=[
                MenuItem("list", "List Providers", "View configured providers", Icons.LIST),
                MenuItem("add", "Add Provider", "Fast passthrough provider setup", Icons.ADD),
                MenuItem("update", "Update Provider", "Edit connection details and runtime settings", Icons.EDIT),
                MenuItem("enrich", "Enrich Provider", "Add or edit scoped resources/actions", Icons.SETTINGS),
                MenuItem("remove", "Remove Provider", "Delete provider configuration", Icons.DELETE),
                MenuItem("back", "Back to Menu", "", Icons.ARROW_LEFT),
            ],
        )
        result = menu.run()
        if not result or result.key == "back":
            break
        if result.key == "list":
            _list_providers(console)
        elif result.key == "add":
            _add_provider(console, state)
        elif result.key == "update":
            _update_provider(console, state)
        elif result.key == "enrich":
            _enrich_provider(console, state)
        elif result.key == "remove":
            _remove_provider(console, state)


def _active_workspace(config_manager: ConfigManager) -> str:
    workspace = get_active_workspace_name(config_manager)
    if workspace:
        return workspace
    raise RuntimeError("No workspaces found. Create one first with 'caracal workspace create <name>'.")


def _list_providers(console: Console) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Configured Providers[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        console.print()
        Prompt.ask("Press Enter to continue", default="")
        return

    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Name", style=Colors.PRIMARY)
    table.add_column("Template", style=Colors.NEUTRAL)
    table.add_column("Auth", style=Colors.NEUTRAL)
    table.add_column("Endpoint", style=Colors.DIM)
    table.add_column("Credential", style=Colors.DIM)
    table.add_column("Mode", style=Colors.DIM)

    for name in sorted(providers.keys()):
        entry = providers[name]
        table.add_row(
            name,
            _provider_template_label(entry),
            str(entry.get("auth_scheme") or "api_key"),
            str(entry.get("base_url") or "configured"),
            _provider_credential_status(entry),
            _provider_mode(entry),
        )

    console.print(table)
    console.print()
    Prompt.ask("Press Enter to continue", default="")


def _add_provider(console: Console, state: FlowState) -> None:
    edition_adapter = get_deployment_edition_adapter()
    if not edition_adapter.allows_local_provider_management():
        console.print(
            f"  [{Colors.WARNING}]{Icons.WARNING} Enterprise mode detected.[/] "
            f"[{Colors.DIM}]Register providers in the gateway vault/registry.[/]"
        )
        Prompt.ask("Press Enter to continue", default="")
        return

    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)
    prompt = FlowPrompt(console)

    console.clear()
    _render_provider_shell(
        console,
        workspace,
        "Guided setup with inline help, starter patterns, and secure credential capture.",
    )

    name = _prompt_identifier(
        prompt=prompt,
        console=console,
        label="Provider name",
        purpose="Stable identifier shown in the UI and used in scopes.",
        used_for="Policies, mandates, and execution requests reference this name.",
        example="openai-main",
        existing=providers.keys(),
    )
    definition_choice = _prompt_identifier(
        prompt=prompt,
        console=console,
        label="Definition ID",
        purpose="Catalog ID describing the provider's API bindings.",
        used_for="Identifies the correct integration structure for Caracal.",
        example="openai.chat.api",
        default=name,
    )
    service_type = _prompt_service_type(prompt, console)
    pattern = _prompt_provider_pattern(prompt, console, service_type)

    auth_scheme, base_url, credential_mode, credential_value, credential_ref, auth_header_name = _collect_connection_settings(
        console=console,
        prompt=prompt,
        provider_name=name,
        pattern=pattern,
    )
    resources = _collect_resource_catalog(
        console=console,
        prompt=prompt,
        workspace=workspace,
        provider_name=name,
        service_type=service_type,
        pattern=pattern,
    )
    advanced = _collect_advanced_settings(console=console, prompt=prompt)

    stored_credential_ref = None
    if auth_scheme != "none":
        stored_credential_ref = credential_ref

    _render_summary(
        console=console,
        workspace=workspace,
        provider_name=name,
        definition_id=definition_choice,
        service_type=service_type,
        pattern=pattern,
        auth_scheme=auth_scheme,
        base_url=base_url,
        auth_header_name=auth_header_name,
        credential_mode=credential_mode,
        credential_ref=stored_credential_ref,
        credential_value=credential_value,
        resources=resources,
        advanced=advanced,
    )

    if not Confirm.ask(f"[{Colors.INFO}]Save provider '{name}'?[/]", default=True):
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} Provider setup cancelled.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    if auth_scheme != "none" and credential_mode == "store-new" and credential_value is not None:
        stored_credential_ref = store_workspace_provider_credential(
            workspace=workspace,
            provider_id=name,
            value=credential_value,
        )

    providers[name] = build_provider_record(
        name=name,
        service_type=service_type,
        definition_id=definition_choice,
        auth_scheme=auth_scheme,
        base_url=base_url or None,
        resources=resources,
        healthcheck_path=str(advanced["healthcheck_path"]),
        timeout_seconds=int(advanced["timeout_seconds"]),
        max_retries=int(advanced["max_retries"]),
        rate_limit_rpm=advanced["rate_limit_rpm"],
        version=advanced["version"],
        tags=[],
        metadata={"starter_pattern": pattern.key} if pattern else {},
        auth_header_name=auth_header_name,
        credential_ref=stored_credential_ref,
        existing=providers.get(name),
        created_at=datetime.utcnow().isoformat(),
    )
    save_workspace_provider_registry(config_manager, workspace, providers)

    console.print()
    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{name}' added.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_add", f"Added provider {name}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")


def _collect_connection_settings(
    *,
    console: Console,
    prompt: FlowPrompt,
    provider_name: str,
    pattern: Optional[ProviderStarterPattern],
) -> tuple[str, str, Optional[str], Optional[str], Optional[str], Optional[str]]:
    console.print()
    console.print(
        Panel(
            "Choose the connection contract Caracal will execute against. Each field explains what you should enter, the expected format, and how execution will use it.",
            title=f"[bold {Colors.INFO}]Connection + Auth[/]",
            border_style=Colors.PRIMARY,
        )
    )
    _render_auth_scheme_table(console)

    suggested_auth = pattern.recommended_auth_scheme if pattern else "api_key"
    auth_scheme = prompt.select(
        "Auth scheme",
        sorted(_AUTH_SCHEME_GUIDANCE.keys()),
        default=suggested_auth,
    )

    auth_info = _AUTH_SCHEME_GUIDANCE[auth_scheme]
    _print_field_help(
        console,
        purpose=auth_info["expects"],
        expected_format=f"Choose one of: {', '.join(sorted(_AUTH_SCHEME_GUIDANCE.keys()))}",
        used_for=auth_info["caracal_use"],
        example=auth_info["example"],
    )

    if auth_scheme in _GATEWAY_ONLY_AUTH:
        console.print(
            Panel(
                "This auth scheme is stored correctly in open-source workspaces, but direct OSS broker execution does not translate it at runtime. Use the Enterprise gateway when you need token exchange or service-account mediation.",
                title=f"[bold {Colors.WARNING}]Gateway-Mediated Auth[/]",
                border_style=Colors.WARNING,
            )
        )

    _print_field_help(
        console,
        purpose="Base URL for the provider API or service root.",
        expected_format="Blank or a full http/https URL.",
        used_for="Caracal combines this with each action path prefix during execution.",
        example=pattern.base_url_example if pattern else "https://api.example.com",
    )
    base_url = prompt.text(
        "Base URL",
        default="",
        validator=_validate_url_or_blank,
        required=False,
    )

    auth_header_name = None
    credential_mode = None
    credential_value = None
    credential_ref = None

    if auth_scheme == "header":
        _print_field_help(
            console,
            purpose="Exact HTTP header name that should receive the credential.",
            expected_format="Header token such as X-API-Key or Authorization.",
            used_for="Caracal writes the secret to this header for each request.",
            example="X-Provider-Key",
        )
        auth_header_name = prompt.text(
            "Header name",
            default="X-API-Key",
            validator=lambda value: _validate_non_empty("Header name", value),
        )

    if auth_scheme != "none":
        console.print(
            Panel(
                "Credential values are stored as encrypted workspace secrets. New credential capture is multiline-safe and hidden by default. Existing secret refs are available when you already manage secrets separately.",
                title=f"[bold {Colors.INFO}]Credential Handling[/]",
                border_style=Colors.PRIMARY,
            )
        )
        credential_mode = prompt.select(
            "Credential source",
            ["store-new", "existing-ref"],
            default="store-new",
        )

        if credential_mode == "store-new":
            _print_field_help(
                console,
                purpose="Secret or token content for the provider. Multiline blocks are preserved exactly as typed.",
                expected_format="Any raw secret block, including tokens, PEM text, JSON, headers, quoted blocks, or line breaks.",
                used_for="Caracal encrypts it in the workspace vault and injects or forwards it according to the auth scheme.",
                example="API token, username:password, PEM, or JSON service credential.",
            )
            credential_value = _prompt_secret_block(
                console,
                label=f"Credential for {provider_name}",
            )
        else:
            _print_field_help(
                console,
                purpose="Reference to a secret already stored in the workspace vault.",
                expected_format="Existing secret key string.",
                used_for="Caracal resolves this reference at execution time instead of creating a new secret.",
                example=f"provider_{provider_name}_credential",
            )
            credential_ref = prompt.text(
                "Existing credential ref",
                validator=lambda value: _validate_non_empty("Credential ref", value),
            )

    return auth_scheme, base_url.strip(), credential_mode, credential_value, credential_ref, auth_header_name


def _collect_resource_catalog(
    *,
    console: Console,
    prompt: FlowPrompt,
    workspace: str,
    provider_name: str,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
) -> dict[str, dict]:
    console.print()
    console.print(
        Panel(
            "Resources and actions define the exact authority surface Caracal will expose. Resource IDs become provider-scoped resource scopes, action IDs become provider-scoped action scopes, and each action's method/path prefix is checked during execution.",
            title=f"[bold {Colors.INFO}]Resources + Actions[/]",
            border_style=Colors.PRIMARY,
        )
    )

    resources: dict[str, dict] = {}
    if pattern:
        _render_pattern_preview(console, provider_name, pattern)
        if prompt.confirm("Start with the suggested starter catalog?", default=True):
            resources = _build_resources_from_pattern(pattern)

    while True:
        console.clear()
        _render_provider_shell(
            console,
            workspace,
            f"Catalog editor for provider '{provider_name}'.",
        )
        _render_catalog(console, provider_name, service_type, resources, pattern)

        choices = ["add-resource", "add-action"]
        if resources:
            choices.extend(["remove-action", "remove-resource"])
        choices.append("done")

        default_choice = "done" if _catalog_is_complete(resources) else choices[0]
        step = prompt.select("Catalog step", choices, default=default_choice)

        if step == "done":
            error = _validate_catalog(resources)
            if error:
                console.print(f"  [{Colors.ERROR}]{Icons.ERROR} {error}[/]")
                Prompt.ask("Press Enter to continue", default="")
                continue
            return resources
        if step == "add-resource":
            _add_resource_to_catalog(console, prompt, service_type, pattern, resources)
        elif step == "add-action":
            _add_action_to_catalog(console, prompt, service_type, pattern, resources)
        elif step == "remove-action":
            _remove_action_from_catalog(prompt, resources)
        elif step == "remove-resource":
            _remove_resource_from_catalog(prompt, resources)


def _collect_advanced_settings(*, console: Console, prompt: FlowPrompt) -> dict[str, object]:
    advanced: dict[str, object] = {
        "healthcheck_path": "/health",
        "timeout_seconds": 30,
        "max_retries": 3,
        "rate_limit_rpm": None,
        "version": None,
    }

    console.print()
    console.print(
        Panel(
            "Advanced settings stay optional. Keep the defaults for a fast setup, or open the section to tune health checks, retries, limits, and version labeling.",
            title=f"[bold {Colors.INFO}]Advanced Runtime Settings[/]",
            border_style=Colors.PRIMARY,
        )
    )

    if not prompt.confirm("Customize advanced settings?", default=False):
        return advanced

    _print_field_help(
        console,
        purpose="Endpoint used for provider health checks.",
        expected_format="Path beginning with '/'.",
        used_for="Caracal calls it when health or readiness checks are performed.",
        example="/health",
    )
    advanced["healthcheck_path"] = prompt.text(
        "Health check path",
        default="/health",
        validator=_validate_path_prefix,
    )

    _print_field_help(
        console,
        purpose="Per-request timeout.",
        expected_format="Positive whole number of seconds.",
        used_for="Caracal stops execution when the upstream takes too long.",
        example="30",
    )
    advanced["timeout_seconds"] = int(prompt.number("Timeout seconds", default=30, min_value=1))

    _print_field_help(
        console,
        purpose="Retry attempts after the initial failure.",
        expected_format="Whole number 0 or greater.",
        used_for="Controls how aggressively Caracal retries transient provider failures.",
        example="3",
    )
    advanced["max_retries"] = int(prompt.number("Max retries", default=3, min_value=0))

    _print_field_help(
        console,
        purpose="Optional client-side request cap.",
        expected_format="Blank or whole number requests per minute.",
        used_for="Applies local throttling before requests are sent upstream.",
        example="120",
    )
    rate_limit_raw = prompt.text(
        "Rate limit rpm",
        default="",
        validator=_validate_optional_int,
        required=False,
    )
    advanced["rate_limit_rpm"] = int(rate_limit_raw) if rate_limit_raw else None

    _print_field_help(
        console,
        purpose="Optional API or provider version label.",
        expected_format="Any short label.",
        used_for="Stored with the provider config for operator clarity and future migrations.",
        example="2026-03",
    )
    version = prompt.text("Version label", default="", required=False)
    advanced["version"] = version or None

    return advanced


def _prompt_service_type(prompt: FlowPrompt, console: Console) -> str:
    console.print()
    console.print(
        Panel(
            "Pick a broad provider category to unlock starter patterns and examples. These are curated defaults, not fixed system types. If your provider does not fit cleanly, choose 'custom' and enter your own service type identifier.",
            title=f"[bold {Colors.INFO}]Service Type[/]",
            border_style=Colors.PRIMARY,
        )
    )
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Type", style=Colors.PRIMARY)
    table.add_column("Use For", style=Colors.NEUTRAL)
    table.add_column("Example IDs", style=Colors.DIM)
    table.add_column("Caracal Use", style=Colors.DIM)
    for service_type, info in _SERVICE_TYPE_GUIDANCE.items():
        table.add_row(service_type, info["purpose"], info["examples"], info["caracal_use"])
    console.print(table)
    choice = prompt.select(
        "Service type",
        list(_SERVICE_TYPE_GUIDANCE.keys()) + ["custom"],
        default="application",
    )
    if choice != "custom":
        return choice

    return _prompt_identifier(
        prompt=prompt,
        console=console,
        label="Custom service type",
        purpose="A custom category label for providers that do not fit the curated starter list.",
        used_for="Stored with the provider definition so operators can group and search similar providers consistently.",
        example="erp, crm, search, browser-automation",
    )


def _prompt_provider_pattern(
    prompt: FlowPrompt,
    console: Console,
    service_type: str,
) -> Optional[ProviderStarterPattern]:
    patterns = list(_PROVIDER_PATTERNS.get(service_type, ()))
    if not patterns:
        return None

    console.print()
    console.print(
        Panel(
            "Starter patterns provide structured defaults, examples, and action shapes for common provider setups. Pick one to start faster, or choose 'custom' for a blank catalog.",
            title=f"[bold {Colors.INFO}]Starter Pattern[/]",
            border_style=Colors.PRIMARY,
        )
    )
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Key", style=Colors.PRIMARY)
    table.add_column("Pattern", style=Colors.NEUTRAL)
    table.add_column("Best For", style=Colors.NEUTRAL)
    table.add_column("Starter Resources", style=Colors.DIM)
    for pattern in patterns:
        table.add_row(
            pattern.key,
            pattern.label,
            pattern.description,
            ", ".join(resource.resource_id for resource in pattern.resources),
        )
    table.add_row("custom", "Custom catalog", "Start empty and define every resource/action yourself.", "-")
    console.print(table)

    choice = prompt.select(
        "Starter pattern",
        [pattern.key for pattern in patterns] + ["custom"],
        default=patterns[0].key,
    )
    if choice == "custom":
        return None
    return next(pattern for pattern in patterns if pattern.key == choice)


def _prompt_identifier(
    *,
    prompt: FlowPrompt,
    console: Console,
    label: str,
    purpose: str,
    used_for: str,
    example: str,
    default: str = "",
    existing: Optional[object] = None,
) -> str:
    _print_field_help(
        console,
        purpose=purpose,
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for=used_for,
        example=example,
    )
    existing_values = {str(item) for item in existing} if existing else set()
    return prompt.text(
        label,
        default=default,
        validator=lambda value: _validate_identifier_value(label, value, existing_values),
    )


def _print_field_help(
    console: Console,
    *,
    purpose: str,
    expected_format: str,
    used_for: str,
    example: Optional[str] = None,
) -> None:
    message = (
        f"  [{Colors.HINT}]What:[/] [{Colors.DIM}]{purpose}[/]\n"
        f"  [{Colors.HINT}]Format:[/] [{Colors.DIM}]{expected_format}[/]\n"
        f"  [{Colors.HINT}]Used for:[/] [{Colors.DIM}]{used_for}[/]"
    )
    if example:
        message += f"\n  [{Colors.HINT}]Example:[/] [{Colors.DIM}]{example}[/]"
    console.print(message)


def _render_provider_shell(console: Console, workspace: str, subtitle: str) -> None:
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Add Provider[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace} | {subtitle}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()


def _render_auth_scheme_table(console: Console) -> None:
    table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    table.add_column("Scheme", style=Colors.PRIMARY)
    table.add_column("Input Expected", style=Colors.NEUTRAL)
    table.add_column("Execution Behavior", style=Colors.DIM)
    for scheme, info in _AUTH_SCHEME_GUIDANCE.items():
        table.add_row(scheme, info["expects"], info["caracal_use"])
    console.print(table)


def _render_pattern_preview(
    console: Console,
    provider_name: str,
    pattern: ProviderStarterPattern,
) -> None:
    console.print()
    console.print(
        Panel(
            f"Pattern: [bold]{pattern.label}[/]\n"
            f"Recommended auth: [bold]{pattern.recommended_auth_scheme}[/]\n"
            f"Base URL example: [bold]{pattern.base_url_example}[/]\n"
            f"Why it helps: {pattern.description}\n\n"
            f"Scopes will look like [bold]{build_resource_scope(provider_name, pattern.resources[0].resource_id)}[/] and "
            f"[bold]{build_action_scope(provider_name, pattern.resources[0].actions[0].action_id)}[/].",
            title=f"[bold {Colors.INFO}]Starter Catalog Preview[/]",
            border_style=Colors.PRIMARY,
        )
    )
    action_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    action_table.add_column("Resource", style=Colors.PRIMARY)
    action_table.add_column("Action", style=Colors.NEUTRAL)
    action_table.add_column("Method", style=Colors.NEUTRAL)
    action_table.add_column("Path Prefix", style=Colors.DIM)
    for resource in pattern.resources:
        for action in resource.actions:
            action_table.add_row(resource.resource_id, action.action_id, action.method, action.path_prefix)
    console.print(action_table)


def _render_catalog(
    console: Console,
    provider_name: str,
    service_type: str,
    resources: dict[str, dict],
    pattern: Optional[ProviderStarterPattern],
) -> None:
    console.print(
        Panel(
            "Every resource must have at least one action. Caracal validates method + path_prefix against requests, and policies or mandates reference the generated provider scopes directly.",
            title=f"[bold {Colors.INFO}]Current Catalog[/]",
            border_style=Colors.PRIMARY,
        )
    )

    if not resources:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No resources defined yet.[/]")
        examples = _resource_examples(service_type, pattern)
        console.print(
            f"  [{Colors.DIM}]Examples for {service_type}: {', '.join(examples)}. "
            f"Resources become scopes like {build_resource_scope(provider_name, examples[0])}.[/]"
        )
        console.print()
        return

    resource_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    resource_table.add_column("Resource", style=Colors.PRIMARY)
    resource_table.add_column("Description", style=Colors.NEUTRAL)
    resource_table.add_column("Actions", style=Colors.NEUTRAL)
    resource_table.add_column("Resource Scope", style=Colors.DIM)
    for resource_id in sorted(resources.keys()):
        payload = resources[resource_id]
        resource_table.add_row(
            resource_id,
            str(payload.get("description") or resource_id),
            ", ".join(sorted(payload.get("actions", {}).keys())) or "-",
            build_resource_scope(provider_name, resource_id),
        )
    console.print(resource_table)
    console.print()

    action_table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
    action_table.add_column("Resource", style=Colors.PRIMARY)
    action_table.add_column("Action", style=Colors.NEUTRAL)
    action_table.add_column("Method", style=Colors.NEUTRAL)
    action_table.add_column("Path Prefix", style=Colors.DIM)
    action_table.add_column("Action Scope", style=Colors.DIM)
    for resource_id in sorted(resources.keys()):
        actions = resources[resource_id].get("actions", {})
        for action_id in sorted(actions.keys()):
            action = actions[action_id]
            action_table.add_row(
                resource_id,
                action_id,
                str(action.get("method") or "POST"),
                str(action.get("path_prefix") or "/"),
                build_action_scope(provider_name, action_id),
            )
    console.print(action_table)
    console.print()
    console.print(
        f"  [{Colors.DIM}]Mandates, policies, delegation scopes, and execution enforcement all depend on these exact IDs. Use stable names, not temporary UI labels.[/]"
    )


def _add_resource_to_catalog(
    console: Console,
    prompt: FlowPrompt,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resources: dict[str, dict],
) -> None:
    examples = _resource_examples(service_type, pattern)
    _print_field_help(
        console,
        purpose="Logical provider surface such as a capability, entity family, or endpoint group.",
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for="Caracal turns it into a provider resource scope and uses it in policies and mandate checks.",
        example=examples[0],
    )
    resource_id = prompt.text(
        "Resource ID",
        validator=lambda value: _validate_identifier_value("Resource ID", value, resources.keys()),
    )
    _print_field_help(
        console,
        purpose="Short explanation shown to operators when reviewing the provider catalog.",
        expected_format="Free text.",
        used_for="Stored in the structured definition to make the catalog self-explanatory.",
        example="Ticket records managed through the external CRM API.",
    )
    description = prompt.text("Resource description", default=resource_id, required=False) or resource_id
    resources[resource_id] = {"description": description, "actions": {}}

    starter_resource = _find_pattern_resource(pattern, resource_id)
    if starter_resource and prompt.confirm(
        f"Apply suggested actions for resource '{resource_id}'?",
        default=True,
    ):
        resources[resource_id] = _resource_payload_from_starter(starter_resource)


def _add_action_to_catalog(
    console: Console,
    prompt: FlowPrompt,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resources: dict[str, dict],
) -> None:
    if not resources:
        console.print(f"  [{Colors.ERROR}]{Icons.ERROR} Add a resource first.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    resource_id = prompt.select(
        "Attach action to resource",
        sorted(resources.keys()),
        default=sorted(resources.keys())[0],
    )
    action_starters = _remaining_action_starters(pattern, resource_id, resources)
    selected_starter = None
    if action_starters:
        table = Table(show_header=True, header_style=f"bold {Colors.INFO}")
        table.add_column("Starter", style=Colors.PRIMARY)
        table.add_column("Method", style=Colors.NEUTRAL)
        table.add_column("Path Prefix", style=Colors.DIM)
        for starter in action_starters:
            table.add_row(starter.action_id, starter.method, starter.path_prefix)
        console.print(table)
        starter_choice = prompt.select(
            "Action starter",
            [starter.action_id for starter in action_starters] + ["custom"],
            default=action_starters[0].action_id,
        )
        if starter_choice != "custom":
            selected_starter = next(
                starter for starter in action_starters if starter.action_id == starter_choice
            )

    action_examples = _action_examples(service_type, pattern, resource_id)
    _print_field_help(
        console,
        purpose="Verb or capability exposed on the selected resource.",
        expected_format="Letters, numbers, '.', '-', '_' only.",
        used_for="Caracal turns it into a provider action scope and matches it against policies, delegation, and execution checks.",
        example=selected_starter.action_id if selected_starter else action_examples[0],
    )
    action_id = prompt.text(
        "Action ID",
        default=selected_starter.action_id if selected_starter else "",
        validator=lambda value: _validate_identifier_value(
            "Action ID",
            value,
            resources[resource_id]["actions"].keys(),
        ),
    )

    _print_field_help(
        console,
        purpose="Readable explanation of the action.",
        expected_format="Free text.",
        used_for="Stored with the provider definition to explain the action surface to operators.",
        example="Create a ticket in the upstream system.",
    )
    description = prompt.text(
        "Action description",
        default=selected_starter.description if selected_starter else action_id,
        required=False,
    ) or action_id

    _print_field_help(
        console,
        purpose="HTTP method used when this action executes.",
        expected_format="GET, POST, PUT, PATCH, or DELETE.",
        used_for="Caracal validates the outgoing request method against this definition.",
        example=selected_starter.method if selected_starter else "POST",
    )
    method = prompt.select(
        "HTTP method",
        _HTTP_METHODS,
        default=selected_starter.method if selected_starter else "POST",
    )

    _print_field_help(
        console,
        purpose="Path prefix beneath the base URL for requests using this action.",
        expected_format="Path starting with '/'.",
        used_for="Caracal checks that execution requests stay within this path boundary.",
        example=selected_starter.path_prefix if selected_starter else "/v1/resource",
    )
    path_prefix = prompt.text(
        "Path prefix",
        default=selected_starter.path_prefix if selected_starter else "/",
        validator=_validate_path_prefix,
    )

    resources[resource_id]["actions"][action_id] = {
        "description": description,
        "method": method,
        "path_prefix": path_prefix,
    }


def _remove_action_from_catalog(prompt: FlowPrompt, resources: dict[str, dict]) -> None:
    resource_id = prompt.select("Resource", sorted(resources.keys()), default=sorted(resources.keys())[0])
    action_ids = sorted(resources[resource_id]["actions"].keys())
    if not action_ids:
        return
    action_id = prompt.select("Action", action_ids, default=action_ids[0])
    del resources[resource_id]["actions"][action_id]


def _remove_resource_from_catalog(prompt: FlowPrompt, resources: dict[str, dict]) -> None:
    resource_id = prompt.select("Remove resource", sorted(resources.keys()), default=sorted(resources.keys())[0])
    del resources[resource_id]


def _render_summary(
    *,
    console: Console,
    workspace: str,
    provider_name: str,
    definition_id: str,
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    auth_scheme: str,
    base_url: str,
    auth_header_name: Optional[str],
    credential_mode: Optional[str],
    credential_ref: Optional[str],
    credential_value: Optional[str],
    resources: dict[str, dict],
    advanced: dict[str, object],
) -> None:
    console.clear()
    _render_provider_shell(console, workspace, "Review the complete provider contract before it is saved.")

    summary = Table(show_header=False, box=None, padding=(0, 2))
    summary.add_column("Field", style=Colors.DIM)
    summary.add_column("Value", style=Colors.NEUTRAL)
    summary.add_row("Provider name", provider_name)
    summary.add_row("Definition ID", definition_id)
    summary.add_row("Service type", service_type)
    summary.add_row("Starter pattern", pattern.label if pattern else "custom")
    summary.add_row("Auth scheme", auth_scheme)
    summary.add_row("Base URL", base_url or "(not set)")
    if auth_header_name:
        summary.add_row("Header name", auth_header_name)
    if auth_scheme != "none":
        if credential_mode == "store-new":
            summary.add_row("Credential", _masked_secret_summary(credential_value or ""))
            summary.add_row("Secret ref", credential_ref or "(generated)")
        else:
            summary.add_row("Credential", f"Existing secret ref: {credential_ref}")
    summary.add_row("Health path", str(advanced["healthcheck_path"]))
    summary.add_row("Timeout", f"{advanced['timeout_seconds']} seconds")
    summary.add_row("Retries", str(advanced["max_retries"]))
    summary.add_row("Rate limit", str(advanced["rate_limit_rpm"] or "not set"))
    summary.add_row("Version", str(advanced["version"] or "not set"))
    console.print(summary)
    console.print()

    _render_catalog(console, provider_name, service_type, resources, pattern)
    console.print()

    first_resource = next(iter(sorted(resources.keys())))
    first_action = next(iter(sorted(resources[first_resource]["actions"].keys())))
    console.print(
        Panel(
            f"Policy / mandate resource scope example:\n[bold]{build_resource_scope(provider_name, first_resource)}[/]\n\n"
            f"Policy / mandate action scope example:\n[bold]{build_action_scope(provider_name, first_action)}[/]\n\n"
            "These exact scopes control what principals can request, delegate, and execute. The method/path definitions above constrain how runtime requests are matched to those scopes.",
            title=f"[bold {Colors.INFO}]Authority Preview[/]",
            border_style=Colors.PRIMARY,
        )
    )


def _catalog_is_complete(resources: dict[str, dict]) -> bool:
    return bool(resources) and all(payload.get("actions") for payload in resources.values())


def _validate_catalog(resources: dict[str, dict]) -> Optional[str]:
    if not resources:
        return "At least one resource is required."
    for resource_id, payload in resources.items():
        if not payload.get("actions"):
            return f"Resource '{resource_id}' has no actions. Add at least one action per resource."
    return None


def _build_resources_from_pattern(pattern: ProviderStarterPattern) -> dict[str, dict]:
    return shared_build_resources_from_pattern(pattern)


def _resource_payload_from_starter(resource: ResourceStarter) -> dict:
    return {
        "description": resource.description,
        "actions": {
            action.action_id: {
                "description": action.description,
                "method": action.method,
                "path_prefix": action.path_prefix,
            }
            for action in resource.actions
        },
    }


def _resource_examples(service_type: str, pattern: Optional[ProviderStarterPattern]) -> list[str]:
    if pattern:
        return [resource.resource_id for resource in pattern.resources]
    for starter_pattern in _PROVIDER_PATTERNS.get(service_type, ()):
        return [resource.resource_id for resource in starter_pattern.resources]
    return ["records"]


def _action_examples(
    service_type: str,
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
) -> list[str]:
    if pattern:
        starter_resource = _find_pattern_resource(pattern, resource_id)
        if starter_resource:
            return [action.action_id for action in starter_resource.actions]
    for starter_pattern in _PROVIDER_PATTERNS.get(service_type, ()):
        starter_resource = _find_pattern_resource(starter_pattern, resource_id)
        if starter_resource:
            return [action.action_id for action in starter_resource.actions]
        if starter_pattern.resources:
            return [action.action_id for action in starter_pattern.resources[0].actions]
    return ["invoke"]


def _find_pattern_resource(
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
) -> Optional[ResourceStarter]:
    if not pattern:
        return None
    for resource in pattern.resources:
        if resource.resource_id == resource_id:
            return resource
    return None


def _remaining_action_starters(
    pattern: Optional[ProviderStarterPattern],
    resource_id: str,
    resources: dict[str, dict],
) -> list[ActionStarter]:
    starter_resource = _find_pattern_resource(pattern, resource_id)
    if not starter_resource:
        return []
    existing_actions = set(resources[resource_id]["actions"].keys())
    return [action for action in starter_resource.actions if action.action_id not in existing_actions]


def _prompt_secret_block(console: Console, *, label: str) -> str:
    console.print(
        Panel(
            "Hidden by default. Press F2 to reveal or hide the full secret. Enter inserts line breaks. Press Ctrl+S when the secret block is complete. The exact text you paste or type is preserved, including newlines, separators, quoted blocks, PEM markers, and header-style content.",
            title=f"[bold {Colors.INFO}]Secure Credential Input[/]",
            border_style=Colors.PRIMARY,
        )
    )

    hidden = [True]

    @Condition
    def is_hidden():
        return hidden[0]

    bindings = KeyBindings()

    @bindings.add("f2")
    def _toggle_visibility(event) -> None:
        hidden[0] = not hidden[0]

    @bindings.add("c-s")
    def _accept_secret(event) -> None:
        event.current_buffer.validate_and_handle()

    prompt_text = FormattedText(
        [
            (Colors.HINT, f"  {Icons.ARROW_RIGHT} "),
            (Colors.NEUTRAL, label),
            ("", ": "),
        ]
    )

    def bottom_toolbar() -> FormattedText:
        visibility = "hidden" if hidden[0] else "visible"
        return FormattedText(
            [
                (
                    Colors.DIM,
                    f"Enter keeps line breaks. Ctrl+S saves the exact secret block. F2 toggles visibility. Currently {visibility}.",
                )
            ]
        )

    secret = pt_prompt(
        prompt_text,
        multiline=True,
        is_password=is_hidden,
        key_bindings=bindings,
        validator=FlowValidator(lambda value: (bool(value), "Credential is required")),
        validate_while_typing=False,
        bottom_toolbar=bottom_toolbar,
    )
    console.print(f"  [{Colors.DIM}]Captured: {_masked_secret_summary(secret)}[/]")
    return secret


def _masked_secret_summary(secret: str) -> str:
    line_count = secret.count("\n") + 1 if secret else 0
    suffix = "s" if line_count != 1 else ""
    return f"**** ({len(secret)} chars across {line_count} line{suffix})"


def _validate_identifier_value(
    field_name: str,
    value: str,
    existing_values: Optional[object] = None,
) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return False, f"{field_name} is required"
    existing = {str(item) for item in existing_values} if existing_values else set()
    if candidate in existing:
        return False, f"{field_name} '{candidate}' already exists"
    if _IDENTIFIER_RE.match(candidate):
        return True, ""
    suggestion = _suggest_identifier(candidate)
    if suggestion and _IDENTIFIER_RE.match(suggestion):
        return (
            False,
            f"Invalid {field_name.lower()}. Allowed: letters, numbers, '.', '-', '_'. Try '{suggestion}'.",
        )
    return False, f"Invalid {field_name.lower()}. Allowed: letters, numbers, '.', '-', '_'."


def _validate_url_or_blank(value: str) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return True, ""
    parsed = urlparse(candidate)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return True, ""
    return False, "Enter a full http/https URL or leave blank"


def _validate_path_prefix(value: str) -> tuple[bool, str]:
    if not value.strip():
        return False, "Path prefix is required"
    if not value.startswith("/"):
        return False, "Path prefix must start with '/'"
    return True, ""


def _validate_optional_int(value: str) -> tuple[bool, str]:
    candidate = value.strip()
    if not candidate:
        return True, ""
    if candidate.isdigit():
        return True, ""
    return False, "Enter a whole number or leave blank"


def _validate_non_empty(field_name: str, value: str) -> tuple[bool, str]:
    if value.strip():
        return True, ""
    return False, f"{field_name} is required"


def _suggest_identifier(raw: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", raw.strip())
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    cleaned = cleaned.strip("-._")
    return cleaned.lower()


def _remove_provider(console: Console, state: FlowState) -> None:
    config_manager = ConfigManager()
    workspace = _active_workspace(config_manager)
    providers = load_workspace_provider_registry(config_manager, workspace)

    console.clear()
    console.print(
        Panel(
            f"[{Colors.PRIMARY}]Remove Provider[/]",
            subtitle=f"[{Colors.HINT}]Workspace: {workspace}[/]",
            border_style=Colors.INFO,
        )
    )
    console.print()

    if not providers:
        console.print(f"  [{Colors.WARNING}]{Icons.WARNING} No providers configured.[/]")
        Prompt.ask("Press Enter to continue", default="")
        return

    names = sorted(providers.keys())
    selected = Prompt.ask(
        f"[{Colors.INFO}]Provider name[/]",
        choices=names,
        default=names[0],
    )

    if not Confirm.ask(f"[{Colors.WARNING}]Remove provider '{selected}'?[/]", default=False):
        return

    removed = providers.pop(selected)
    save_workspace_provider_registry(config_manager, workspace, providers)

    credential_ref = removed.get("credential_ref")
    if credential_ref:
        try:
            delete_workspace_provider_credential(workspace, credential_ref)
        except SecretNotFoundError:
            pass

    console.print(f"  [{Colors.SUCCESS}]{Icons.SUCCESS} Provider '{selected}' removed.[/]")
    if state:
        state.add_recent_action(
            RecentAction.create("provider_remove", f"Removed provider {selected}", success=True)
        )
    Prompt.ask("Press Enter to continue", default="")
