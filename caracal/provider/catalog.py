"""
Shared provider catalog, templates, validation, and record serialization.

This module is the single source of truth for provider field structure across
CLI, TUI, broker mode, gateway mode, and enterprise APIs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple
import base64
import re

_IDENTIFIER_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
GATEWAY_ONLY_AUTH = {"oauth2_client_credentials", "service_account"}


class ProviderCatalogError(ValueError):
    """Raised when provider catalog inputs are invalid."""


@dataclass(frozen=True)
class ProviderRecord:
    provider_id: str
    name: str
    service_type: str
    provider_definition: str
    definition: Optional[Dict[str, Any]]
    base_url: Optional[str]
    auth_scheme: str
    credential_ref: Optional[str]
    credential_storage: str
    healthcheck_path: str
    timeout_seconds: int
    max_retries: int
    rate_limit_rpm: Optional[int]
    version: Optional[str]
    tags: List[str]
    capabilities: List[str]
    access_policy: Dict[str, Any]
    auth_metadata: Dict[str, Any]
    default_headers: Dict[str, Any]
    metadata: Dict[str, Any]
    resources: List[str]
    actions: List[str]
    enforce_scoped_requests: bool
    provider_layer: str
    template_id: Optional[str]
    managed_by: Optional[str]
    organization_id: Optional[str]
    created_at: str
    updated_at: str


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
    actions: Tuple[ActionStarter, ...]


@dataclass(frozen=True)
class ProviderStarterPattern:
    key: str
    label: str
    description: str
    service_type: str
    recommended_auth_scheme: str
    base_url_example: str
    resources: Tuple[ResourceStarter, ...]


SERVICE_TYPE_GUIDANCE: Dict[str, Dict[str, str]] = {
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

AUTH_SCHEME_GUIDANCE: Dict[str, Dict[str, str]] = {
    "none": {
        "expects": "No credential input.",
        "caracal_use": "Calls the provider without injecting auth material.",
        "example": "Public health endpoint or trusted internal service.",
    },
    "api_key": {
        "expects": "Single API key or token string.",
        "caracal_use": "Injects the credential into a configured API-key style header.",
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

PROVIDER_PATTERNS: Dict[str, Tuple[ProviderStarterPattern, ...]] = {
    "ai": (
        ProviderStarterPattern(
            key="ai_chat_platform",
            label="Chat + embeddings API",
            description="Common AI provider surface with inference, embeddings, and model listing.",
            service_type="ai",
            recommended_auth_scheme="bearer",
            base_url_example="https://api.example-llm.com",
            resources=(
                ResourceStarter("responses", "Primary text and multimodal generation endpoint", (ActionStarter("create", "Create a model response", "POST", "/v1/responses"),)),
                ResourceStarter("embeddings", "Embedding generation endpoint", (ActionStarter("embed", "Generate vector embeddings", "POST", "/v1/embeddings"),)),
                ResourceStarter("models", "Model catalog endpoint", (ActionStarter("list", "List available models", "GET", "/v1/models"),)),
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
                ResourceStarter("assistants", "Assistant configuration and execution surface", (
                    ActionStarter("create", "Create or update an assistant", "POST", "/v1/assistants"),
                    ActionStarter("list", "List assistants", "GET", "/v1/assistants"),
                )),
                ResourceStarter("runs", "Thread and run execution surface", (
                    ActionStarter("create", "Start an assistant run", "POST", "/v1/threads/runs"),
                    ActionStarter("read", "Inspect a run", "GET", "/v1/threads/runs"),
                )),
            ),
        ),
    ),
    "application": (
        ProviderStarterPattern(
            key="application_crm",
            label="CRUD business API",
            description="Typical SaaS CRUD provider with records and approval surfaces.",
            service_type="application",
            recommended_auth_scheme="bearer",
            base_url_example="https://api.example-crm.com",
            resources=(
                ResourceStarter("records", "Primary CRUD entity collection", (
                    ActionStarter("list", "List records", "GET", "/v1/records"),
                    ActionStarter("create", "Create a record", "POST", "/v1/records"),
                    ActionStarter("update", "Update a record", "PATCH", "/v1/records"),
                    ActionStarter("delete", "Delete a record", "DELETE", "/v1/records"),
                )),
                ResourceStarter("approvals", "Approval or workflow state transitions", (
                    ActionStarter("request", "Request approval", "POST", "/v1/approvals"),
                    ActionStarter("resolve", "Resolve approval", "POST", "/v1/approvals/resolve"),
                )),
            ),
        ),
        ProviderStarterPattern(
            key="application_support",
            label="Ticketing / support platform",
            description="Service desk style surface for tickets and approval workflows.",
            service_type="application",
            recommended_auth_scheme="api_key",
            base_url_example="https://support.example.com/api",
            resources=(
                ResourceStarter("tickets", "Support or incident records", (
                    ActionStarter("list", "List tickets", "GET", "/v1/tickets"),
                    ActionStarter("create", "Create a ticket", "POST", "/v1/tickets"),
                    ActionStarter("update", "Update a ticket", "PATCH", "/v1/tickets"),
                )),
                ResourceStarter("approvals", "Approval workflow for ticket changes", (
                    ActionStarter("request", "Request approval", "POST", "/v1/approvals"),
                    ActionStarter("resolve", "Resolve approval", "POST", "/v1/approvals/resolve"),
                )),
            ),
        ),
    ),
    "data": (
        ProviderStarterPattern(
            key="data_sql_service",
            label="Query + schema service",
            description="Query engine or SQL proxy that separates reads, writes, and schema changes.",
            service_type="data",
            recommended_auth_scheme="basic",
            base_url_example="https://sql.example-data.com",
            resources=(
                ResourceStarter("queries", "Ad hoc or saved query execution", (
                    ActionStarter("read", "Run a read-only query", "POST", "/query/read"),
                    ActionStarter("write", "Run a mutating query", "POST", "/query/write"),
                )),
                ResourceStarter("schema", "Schema inspection and migration surface", (
                    ActionStarter("inspect", "Inspect schema metadata", "GET", "/schema"),
                    ActionStarter("migrate", "Apply schema changes", "POST", "/schema/migrate"),
                )),
            ),
        ),
        ProviderStarterPattern(
            key="data_vector_search",
            label="Vector / search service",
            description="Vector indexing and retrieval operations for search providers.",
            service_type="data",
            recommended_auth_scheme="header",
            base_url_example="https://vectors.example-search.com",
            resources=(
                ResourceStarter("indexes", "Vector or search indexes", (
                    ActionStarter("list", "List indexes", "GET", "/v1/indexes"),
                    ActionStarter("upsert", "Create or update vectors", "POST", "/v1/indexes"),
                )),
                ResourceStarter("query", "Similarity or keyword query surface", (
                    ActionStarter("query", "Run a vector search", "POST", "/v1/query"),
                )),
            ),
        ),
    ),
    "identity": (
        ProviderStarterPattern(
            key="identity_directory",
            label="Directory / SCIM admin API",
            description="Identity admin surface with users and groups.",
            service_type="identity",
            recommended_auth_scheme="bearer",
            base_url_example="https://id.example.com",
            resources=(
                ResourceStarter("users", "Directory users", (
                    ActionStarter("list", "List users", "GET", "/scim/v2/Users"),
                    ActionStarter("create", "Create a user", "POST", "/scim/v2/Users"),
                    ActionStarter("update", "Update a user", "PATCH", "/scim/v2/Users"),
                )),
                ResourceStarter("groups", "Directory groups and memberships", (
                    ActionStarter("list", "List groups", "GET", "/scim/v2/Groups"),
                    ActionStarter("update", "Update group membership", "PATCH", "/scim/v2/Groups"),
                )),
            ),
        ),
    ),
    "messaging": (
        ProviderStarterPattern(
            key="messaging_delivery",
            label="Messaging delivery API",
            description="Email, SMS, or chat delivery plus template management.",
            service_type="messaging",
            recommended_auth_scheme="api_key",
            base_url_example="https://msg.example.com",
            resources=(
                ResourceStarter("messages", "Outbound message delivery surface", (
                    ActionStarter("send", "Send a message", "POST", "/v1/messages"),
                    ActionStarter("status", "Check delivery status", "GET", "/v1/messages"),
                )),
                ResourceStarter("templates", "Template listing and rendering", (
                    ActionStarter("list", "List templates", "GET", "/v1/templates"),
                    ActionStarter("render", "Render a template", "POST", "/v1/templates/render"),
                )),
            ),
        ),
        ProviderStarterPattern(
            key="messaging_events",
            label="Event publisher / webhook relay",
            description="Publish and validate event or webhook payloads.",
            service_type="messaging",
            recommended_auth_scheme="header",
            base_url_example="https://events.example.com",
            resources=(
                ResourceStarter("events", "Event publishing surface", (
                    ActionStarter("publish", "Publish an event", "POST", "/v1/events"),
                    ActionStarter("validate", "Validate an event signature", "POST", "/v1/events/validate"),
                )),
            ),
        ),
    ),
    "storage": (
        ProviderStarterPattern(
            key="storage_objects",
            label="Object storage API",
            description="Bucket and object lifecycle management.",
            service_type="storage",
            recommended_auth_scheme="service_account",
            base_url_example="https://storage.example.com",
            resources=(
                ResourceStarter("objects", "Stored binary objects or files", (
                    ActionStarter("list", "List objects", "GET", "/v1/objects"),
                    ActionStarter("upload", "Upload an object", "POST", "/v1/objects"),
                    ActionStarter("delete", "Delete an object", "DELETE", "/v1/objects"),
                )),
                ResourceStarter("buckets", "Storage containers", (
                    ActionStarter("list", "List buckets", "GET", "/v1/buckets"),
                )),
            ),
        ),
    ),
    "payments": (
        ProviderStarterPattern(
            key="payments_processor",
            label="Payments processor",
            description="Charge, customer, and refund operations for billing providers.",
            service_type="payments",
            recommended_auth_scheme="bearer",
            base_url_example="https://payments.example.com",
            resources=(
                ResourceStarter("charges", "Payment collection and capture", (
                    ActionStarter("create", "Create a charge", "POST", "/v1/charges"),
                    ActionStarter("read", "Inspect a charge", "GET", "/v1/charges"),
                    ActionStarter("refund", "Refund a charge", "POST", "/v1/refunds"),
                )),
                ResourceStarter("customers", "Customer billing profiles", (
                    ActionStarter("list", "List customers", "GET", "/v1/customers"),
                    ActionStarter("update", "Update customer billing details", "PATCH", "/v1/customers"),
                )),
            ),
        ),
    ),
    "developer-tools": (
        ProviderStarterPattern(
            key="devtools_repo_ci",
            label="SCM + CI platform",
            description="Repositories, pull requests, and build pipelines.",
            service_type="developer-tools",
            recommended_auth_scheme="bearer",
            base_url_example="https://dev.example.com",
            resources=(
                ResourceStarter("repos", "Repositories and metadata", (
                    ActionStarter("list", "List repositories", "GET", "/v1/repos"),
                    ActionStarter("read", "Read repository metadata", "GET", "/v1/repos"),
                )),
                ResourceStarter("pull-requests", "Code review and merge surface", (
                    ActionStarter("list", "List pull requests", "GET", "/v1/pull-requests"),
                    ActionStarter("merge", "Merge a pull request", "POST", "/v1/pull-requests/merge"),
                )),
                ResourceStarter("builds", "Build and pipeline execution", (
                    ActionStarter("run", "Start a build or pipeline", "POST", "/v1/builds"),
                    ActionStarter("cancel", "Cancel a build or pipeline", "POST", "/v1/builds/cancel"),
                )),
            ),
        ),
    ),
    "observability": (
        ProviderStarterPattern(
            key="observability_monitoring",
            label="Monitoring + incident platform",
            description="Logs, alerts, incidents, and incident workflow controls.",
            service_type="observability",
            recommended_auth_scheme="bearer",
            base_url_example="https://observe.example.com",
            resources=(
                ResourceStarter("alerts", "Alert listing and silencing", (
                    ActionStarter("list", "List alerts", "GET", "/v1/alerts"),
                    ActionStarter("silence", "Silence an alert", "POST", "/v1/alerts/silence"),
                )),
                ResourceStarter("incidents", "Incident declaration and resolution", (
                    ActionStarter("create", "Create an incident", "POST", "/v1/incidents"),
                    ActionStarter("resolve", "Resolve an incident", "POST", "/v1/incidents/resolve"),
                )),
                ResourceStarter("logs", "Log querying surface", (
                    ActionStarter("query", "Query logs", "POST", "/v1/logs/query"),
                )),
            ),
        ),
    ),
    "infrastructure": (
        ProviderStarterPattern(
            key="infrastructure_control_plane",
            label="Deployment control plane",
            description="Deployments, jobs, and cluster operations.",
            service_type="infrastructure",
            recommended_auth_scheme="service_account",
            base_url_example="https://infra.example.com",
            resources=(
                ResourceStarter("deployments", "Deployment lifecycle", (
                    ActionStarter("list", "List deployments", "GET", "/v1/deployments"),
                    ActionStarter("deploy", "Start a deployment", "POST", "/v1/deployments"),
                    ActionStarter("rollback", "Rollback a deployment", "POST", "/v1/deployments/rollback"),
                )),
                ResourceStarter("jobs", "Batch or workflow jobs", (
                    ActionStarter("run", "Run a job", "POST", "/v1/jobs"),
                    ActionStarter("cancel", "Cancel a running job", "POST", "/v1/jobs/cancel"),
                )),
                ResourceStarter("clusters", "Cluster inspection and restart surface", (
                    ActionStarter("read", "Read cluster state", "GET", "/v1/clusters"),
                    ActionStarter("restart", "Restart a workload", "POST", "/v1/clusters/restart"),
                )),
            ),
        ),
    ),
    "internal": (
        ProviderStarterPattern(
            key="internal_workflows",
            label="Internal task / approval service",
            description="Internal dispatch and approval workflows.",
            service_type="internal",
            recommended_auth_scheme="header",
            base_url_example="https://internal.example.com",
            resources=(
                ResourceStarter("tasks", "Task dispatch and status surface", (
                    ActionStarter("dispatch", "Dispatch a task", "POST", "/tasks/dispatch"),
                    ActionStarter("status", "Read task status", "GET", "/tasks"),
                )),
                ResourceStarter("approvals", "Approval request flow", (
                    ActionStarter("request", "Request approval", "POST", "/approvals"),
                    ActionStarter("resolve", "Resolve approval", "POST", "/approvals/resolve"),
                )),
            ),
        ),
    ),
}


def ensure_identifier(label: str, value: str) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        raise ProviderCatalogError(f"{label} is required")
    if not _IDENTIFIER_RE.match(candidate):
        raise ProviderCatalogError(
            f"Invalid {label}: '{candidate}'. Allowed: letters, numbers, '.', '-', '_'"
        )
    return candidate


def ensure_path_prefix(value: str) -> str:
    candidate = str(value or "").strip() or "/"
    if not candidate.startswith("/"):
        raise ProviderCatalogError("Path prefixes must start with '/'.")
    return candidate


def normalize_identifier(value: str) -> str:
    candidate = str(value or "").strip().lower()
    candidate = re.sub(r"[^a-z0-9._-]+", "-", candidate)
    candidate = re.sub(r"-{2,}", "-", candidate).strip("-._")
    return candidate or "provider"


def normalize_auth_scheme(value: str) -> str:
    scheme = str(value or "api_key").strip().replace("-", "_").lower()
    if scheme not in AUTH_SCHEME_GUIDANCE:
        raise ProviderCatalogError(f"Unsupported auth scheme: {value}")
    return scheme


def resource_payload_from_pattern(resource: ResourceStarter) -> Dict[str, Any]:
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


def build_resources_from_pattern(pattern: ProviderStarterPattern) -> Dict[str, Dict[str, Any]]:
    return {
        resource.resource_id: resource_payload_from_pattern(resource)
        for resource in pattern.resources
    }


def summarize_catalog(resources: Dict[str, Dict[str, Any]]) -> Tuple[List[str], List[str]]:
    resource_ids = sorted(resources.keys())
    action_ids = sorted(
        {
            str(action_id)
            for resource in resources.values()
            for action_id in (resource.get("actions") or {}).keys()
        }
    )
    return resource_ids, action_ids


def validate_resources(resources: Dict[str, Dict[str, Any]]) -> None:
    if not resources:
        raise ProviderCatalogError("At least one resource is required.")

    for resource_id, payload in resources.items():
        ensure_identifier("Resource ID", resource_id)
        actions = payload.get("actions")
        if not isinstance(actions, dict) or not actions:
            raise ProviderCatalogError(
                f"Resource '{resource_id}' must define at least one action."
            )
        for action_id, action_payload in actions.items():
            ensure_identifier("Action ID", action_id)
            method = str(action_payload.get("method") or "POST").upper()
            if method not in HTTP_METHODS:
                raise ProviderCatalogError(
                    f"Action '{resource_id}:{action_id}' has unsupported method '{method}'."
                )
            ensure_path_prefix(str(action_payload.get("path_prefix") or "/"))


def build_definition_payload(
    *,
    definition_id: str,
    service_type: str,
    display_name: str,
    auth_scheme: str,
    base_url: Optional[str],
    resources: Dict[str, Dict[str, Any]],
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    validate_resources(resources)
    return {
        "definition_id": ensure_identifier("Definition ID", definition_id),
        "service_type": str(service_type or "application").strip().lower() or "application",
        "display_name": str(display_name or definition_id).strip() or definition_id,
        "auth_scheme": normalize_auth_scheme(auth_scheme),
        "default_base_url": str(base_url).strip() if base_url else None,
        "resources": resources,
        "metadata": dict(metadata or {}),
    }


def build_provider_record(
    *,
    name: str,
    service_type: str,
    definition_id: str,
    auth_scheme: str,
    base_url: Optional[str],
    resources: Optional[Dict[str, Dict[str, Any]]] = None,
    definition: Optional[Dict[str, Any]] = None,
    healthcheck_path: str = "/health",
    timeout_seconds: int = 30,
    max_retries: int = 3,
    rate_limit_rpm: Optional[int] = None,
    version: Optional[str] = None,
    tags: Optional[Iterable[str]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    auth_header_name: Optional[str] = None,
    credential_ref: Optional[str] = None,
    credential_storage: str = "workspace_vault",
    provider_layer: str = "user_provider",
    template_id: Optional[str] = None,
    managed_by: Optional[str] = None,
    organization_id: Optional[str] = None,
    existing: Optional[Dict[str, Any]] = None,
    created_at: Optional[str] = None,
    enforce_scoped_requests: Optional[bool] = None,
) -> Dict[str, Any]:
    normalized_name = ensure_identifier("Provider name", name)
    normalized_definition_id = ensure_identifier("Definition ID", definition_id)
    normalized_auth = normalize_auth_scheme(auth_scheme)
    service = str(service_type or "application").strip().lower() or "application"
    now = datetime.now(timezone.utc).isoformat()
    preserved_existing = dict(existing or {})
    auth_metadata = dict(preserved_existing.get("auth_metadata") or {})
    if auth_header_name:
        auth_metadata["header_name"] = auth_header_name

    definition_payload: Optional[Dict[str, Any]] = None
    normalized_resources: Dict[str, Dict[str, Any]] = {}
    if definition is not None:
        definition_payload = dict(definition)
        normalized_resources = dict(definition_payload.get("resources") or {})
        if normalized_resources:
            definition_payload = build_definition_payload(
                definition_id=str(definition_payload.get("definition_id") or normalized_definition_id),
                service_type=str(definition_payload.get("service_type") or service),
                display_name=str(definition_payload.get("display_name") or normalized_name),
                auth_scheme=str(definition_payload.get("auth_scheme") or normalized_auth),
                base_url=definition_payload.get("default_base_url", base_url),
                resources=normalized_resources,
                metadata=dict(definition_payload.get("metadata") or metadata or {}),
            )
        else:
            definition_payload = {
                "definition_id": normalized_definition_id,
                "service_type": service,
                "display_name": normalized_name,
                "auth_scheme": normalized_auth,
                "default_base_url": str(base_url).strip() if base_url else None,
                "resources": {},
                "metadata": dict(metadata or {}),
            }
    elif resources:
        normalized_resources = dict(resources)
        definition_payload = build_definition_payload(
            definition_id=normalized_definition_id,
            service_type=service,
            display_name=normalized_name,
            auth_scheme=normalized_auth,
            base_url=base_url,
            resources=normalized_resources,
            metadata=metadata,
        )

    resource_ids, action_ids = summarize_catalog(normalized_resources)
    scoped_requests_enabled = (
        bool(normalized_resources)
        if enforce_scoped_requests is None
        else bool(enforce_scoped_requests)
    )

    return asdict(
        ProviderRecord(
            provider_id=normalized_name,
            name=normalized_name,
            service_type=service,
            provider_definition=normalized_definition_id,
            definition=definition_payload,
            base_url=str(base_url).strip() if base_url else None,
            auth_scheme=normalized_auth,
            credential_ref=credential_ref,
            credential_storage=credential_storage,
            healthcheck_path=ensure_path_prefix(healthcheck_path),
            timeout_seconds=int(timeout_seconds),
            max_retries=int(max_retries),
            rate_limit_rpm=rate_limit_rpm,
            version=version,
            tags=list(tags or []),
            capabilities=list(preserved_existing.get("capabilities") or []),
            access_policy=dict(preserved_existing.get("access_policy") or {"scopes": []}),
            auth_metadata=auth_metadata,
            default_headers=dict(preserved_existing.get("default_headers") or {}),
            metadata=dict(metadata or {}),
            resources=resource_ids,
            actions=action_ids,
            enforce_scoped_requests=scoped_requests_enabled,
            provider_layer=provider_layer,
            template_id=template_id,
            managed_by=managed_by,
            organization_id=organization_id,
            created_at=created_at or preserved_existing.get("created_at") or now,
            updated_at=now,
        )
    )


def resolve_auth_headers(
    *,
    auth_scheme: str,
    credential_value: Optional[str],
    auth_metadata: Optional[Dict[str, Any]] = None,
    allow_gateway_managed: bool = False,
) -> Dict[str, str]:
    scheme = normalize_auth_scheme(auth_scheme)
    metadata = dict(auth_metadata or {})

    if scheme == "none":
        return {}
    if credential_value is None:
        raise ProviderCatalogError("Credential value is required for authenticated providers.")

    if scheme == "api_key":
        header_name = str(metadata.get("header_name") or "X-API-Key")
        return {header_name: credential_value}
    if scheme == "bearer":
        return {"Authorization": f"Bearer {credential_value}"}
    if scheme == "basic":
        encoded = base64.b64encode(credential_value.encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {encoded}"}
    if scheme == "header":
        header_name = str(metadata.get("header_name") or "X-API-Key")
        return {header_name: credential_value}
    if scheme in GATEWAY_ONLY_AUTH:
        if allow_gateway_managed and metadata.get("header_name"):
            return {str(metadata["header_name"]): credential_value}
        raise ProviderCatalogError(
            f"Auth scheme '{auth_scheme}' requires gateway-managed execution."
        )
    raise ProviderCatalogError(f"Unsupported auth scheme: {auth_scheme}")


def system_templates() -> List[Dict[str, Any]]:
    templates: List[Dict[str, Any]] = []
    for service_type, patterns in sorted(PROVIDER_PATTERNS.items()):
        for pattern in patterns:
            resources = build_resources_from_pattern(pattern)
            definition = build_definition_payload(
                definition_id=pattern.key,
                service_type=service_type,
                display_name=pattern.label,
                auth_scheme=pattern.recommended_auth_scheme,
                base_url=pattern.base_url_example,
                resources=resources,
                metadata={"system_template": True, "managed_by": "caracal_catalog"},
            )
            templates.append(
                {
                    "template_id": pattern.key,
                    "name": pattern.label,
                    "display_name": pattern.label,
                    "description": pattern.description,
                    "service_type": service_type,
                    "auth_scheme": pattern.recommended_auth_scheme,
                    "base_url_example": pattern.base_url_example,
                    "definition_id": pattern.key,
                    "definition": definition,
                    "resources": sorted(resources.keys()),
                    "actions": summarize_catalog(resources)[1],
                    "provider_layer": "system_template",
                    "managed_by": "caracal_catalog",
                    "read_only": True,
                }
            )
    return templates


def catalog_snapshot() -> Dict[str, Any]:
    return {
        "service_types": [
            {"id": key, **value}
            for key, value in SERVICE_TYPE_GUIDANCE.items()
        ],
        "auth_schemes": [
            {"id": key, **value, "gateway_only": key in GATEWAY_ONLY_AUTH}
            for key, value in AUTH_SCHEME_GUIDANCE.items()
        ],
        "system_templates": system_templates(),
    }


def workspace_to_gateway_payload(
    provider_name: str,
    entry: Dict[str, Any],
    *,
    organization_id: Optional[str],
    credential_storage: str = "gateway_vault",
) -> Dict[str, Any]:
    definition = dict(entry.get("definition") or entry.get("provider_definition_data") or {})
    resources = dict(definition.get("resources") or {})
    if not resources:
        raise ProviderCatalogError(
            f"Provider '{provider_name}' is missing structured resources and cannot be mapped to gateway mode."
        )
    return build_provider_record(
        name=provider_name,
        service_type=str(entry.get("service_type") or entry.get("provider_type") or "application"),
        definition_id=str(entry.get("provider_definition") or provider_name),
        auth_scheme=str(entry.get("auth_scheme") or "api_key"),
        base_url=entry.get("base_url"),
        definition=definition,
        healthcheck_path=str(entry.get("healthcheck_path") or "/health"),
        timeout_seconds=int(entry.get("timeout_seconds") or 30),
        max_retries=int(entry.get("max_retries") or 3),
        rate_limit_rpm=entry.get("rate_limit_rpm"),
        version=entry.get("version"),
        tags=entry.get("tags") or [],
        metadata=entry.get("metadata") or {},
        auth_header_name=(entry.get("auth_metadata") or {}).get("header_name"),
        credential_ref=entry.get("credential_ref"),
        credential_storage=credential_storage,
        provider_layer="user_provider",
        template_id=entry.get("template_id"),
        managed_by=entry.get("managed_by"),
        organization_id=organization_id,
        existing=entry,
    )


def gateway_to_workspace_entry(record: Dict[str, Any]) -> Dict[str, Any]:
    entry = dict(record)
    definition = dict(record.get("definition") or record.get("provider_definition_data") or {})
    entry["definition"] = definition
    entry["provider_definition"] = str(record.get("provider_definition") or definition.get("definition_id") or record.get("name") or "custom")
    entry["name"] = str(record.get("name") or record.get("provider_id") or "provider")
    return entry
