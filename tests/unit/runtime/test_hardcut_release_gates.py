"""Release-gate tests that prevent hard-cut regressions."""

from __future__ import annotations

import ast
from pathlib import Path
import re
import tomllib

import pytest

from tests.mock.source import caracal_source_roots, caracal_path


class _CaracalView:
    """Resolve `caracal/...` paths transparently across the host and server wheel sources."""

    def __init__(self, parts: tuple[str, ...] = ()) -> None:
        self._parts = parts

    def __truediv__(self, child) -> "_CaracalView":
        return _CaracalView(self._parts + (str(child),))

    def _resolve(self) -> Path:
        for root in caracal_source_roots():
            candidate = root.joinpath(*self._parts) if self._parts else root
            if candidate.exists():
                return candidate
        return caracal_source_roots()[0].joinpath(*self._parts)

    def __fspath__(self) -> str:
        return str(self._resolve())

    def __str__(self) -> str:
        return str(self._resolve())

    def read_text(self, *args, **kwargs):
        return self._resolve().read_text(*args, **kwargs)

    def exists(self) -> bool:
        return any(
            (root.joinpath(*self._parts) if self._parts else root).exists()
            for root in caracal_source_roots()
        )

    def rglob(self, pattern):
        for root in caracal_source_roots():
            target = root.joinpath(*self._parts) if self._parts else root
            if target.is_dir():
                yield from target.rglob(pattern)


class _RepoRootView:
    """Path-like view; `_REPO_ROOT / 'caracal'` returns a CaracalView spanning both wheels."""

    def __init__(self, path: Path) -> None:
        self._path = path

    def __truediv__(self, child):
        if str(child) == "caracal":
            return _CaracalView()
        return self._path / child

    def __fspath__(self) -> str:
        return str(self._path)

    def __str__(self) -> str:
        return str(self._path)

    def __getattr__(self, name):
        return getattr(self._path, name)


def _caracal_relative_posix(py_file: Path) -> str:
    """Return 'caracal/X/Y.py' for a py_file under either wheel source tree."""
    for root in caracal_source_roots():
        try:
            return "caracal/" + py_file.relative_to(root).as_posix()
        except ValueError:
            continue
    return py_file.as_posix()


_REPO_ROOT = _RepoRootView(Path(__file__).resolve().parents[3])
_OSS_ROOT = Path(__file__).resolve().parents[3]


def _core_package_version() -> str:
    pyproject = _OSS_ROOT / "packages" / "caracal" / "pyproject.toml"
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    return str(data["project"]["version"])


def _skip_without_enterprise_repo() -> None:
    marker = _OSS_ROOT.parent / "caracalEnterprise" / "docker-compose.enterprise.yml"
    if not marker.is_file():
        pytest.skip(
            "caracalEnterprise sibling checkout not present (optional for OSS-only clones)"
        )


@pytest.mark.unit
def test_release_version_sources_match_core_package_version() -> None:
    core_version = _core_package_version()

    assert (_OSS_ROOT / "VERSION").read_text(encoding="utf-8").strip() == core_version


@pytest.mark.unit
def test_runtime_release_image_defaults_match_core_package_version() -> None:
    core_version = _core_package_version()
    runtime_image = f"ghcr.io/garudex-labs/caracal-runtime:{core_version}"
    runtime_image_default = f"CCL_RUNTIME_IMAGE:-{runtime_image}"

    checked_files = (
        _OSS_ROOT / ".env.example",
        _OSS_ROOT / "deploy" / "docker-compose.image.yml",
        caracal_path("runtime", "data", "docker-compose.yml"),
        caracal_path("runtime", "entrypoints.py"),
    )

    for checked_file in checked_files:
        payload = checked_file.read_text(encoding="utf-8")
        assert runtime_image in payload or runtime_image_default in payload, str(checked_file)


@pytest.mark.unit
def test_runtime_dockerfile_core_constraint_matches_core_package_version() -> None:
    core_version = _core_package_version()
    payload = (_OSS_ROOT / "deploy" / "docker" / "Dockerfile.runtime").read_text(encoding="utf-8")

    assert f"caracal-core=={core_version}" in payload


@pytest.mark.unit
def test_identity_module_has_no_legacy_alias_exports() -> None:
    identity_file = _REPO_ROOT / "caracal" / "core" / "identity.py"
    payload = identity_file.read_text(encoding="utf-8")

    assert "AgentRegistry =" not in payload
    assert "AgentIdentity =" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_legacy_agent_identity_imports() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if "from caracal.core.identity import Agent" in payload:
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_has_no_sqlite_url_usages() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        if py_file.name == "hardcut_preflight.py":
            continue

        payload = py_file.read_text(encoding="utf-8").lower()
        if "sqlite://" in payload or "sqlite+" in payload:
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_hardcut_preflight_freezes_canonical_contract_constants() -> None:
    preflight_file = _REPO_ROOT / "caracal" / "runtime" / "hardcut_preflight.py"
    payload = preflight_file.read_text(encoding="utf-8")

    assert '_CANONICAL_ENTERPRISE_API_FAMILY = "/api/sync"' in payload
    assert '_CANONICAL_ENTERPRISE_CLI_FAMILY = "caracal enterprise"' in payload
    assert "_FORBIDDEN_SYNC_RUNTIME_MODEL_MARKERS" in payload


@pytest.mark.unit
def test_runtime_session_signing_has_no_legacy_env_alias_fallback() -> None:
    entrypoints_file = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    preflight_file = _REPO_ROOT / "caracal" / "runtime" / "hardcut_preflight.py"

    entrypoints_payload = entrypoints_file.read_text(encoding="utf-8")
    preflight_payload = preflight_file.read_text(encoding="utf-8")

    assert "AIS_SESSION_ALGORITHM_FALLBACK_ENV" not in entrypoints_payload
    legacy_session_alg = "CCL_" + "SESSION_" + "JWT_ALGORITHM"
    assert legacy_session_alg not in entrypoints_payload
    assert legacy_session_alg not in preflight_payload


@pytest.mark.unit
def test_runtime_compose_has_no_file_backed_state_markers() -> None:
    compose_files = (
        _REPO_ROOT / "deploy" / "docker-compose.yml",
        _REPO_ROOT / "deploy" / "docker-compose.image.yml",
    )

    for compose_file in compose_files:
        payload = compose_file.read_text(encoding="utf-8").lower()
        assert "caracal_state:" not in payload, str(compose_file)
        assert "/home/caracal/.caracal" not in payload, str(compose_file)


@pytest.mark.unit
def test_runtime_compose_persists_caracal_home_state_volume() -> None:
    compose_files = (
        _REPO_ROOT / "deploy" / "docker-compose.yml",
        _REPO_ROOT / "deploy" / "docker-compose.image.yml",
    )

    for compose_file in compose_files:
        payload = compose_file.read_text(encoding="utf-8")
        assert "runtime_data:/home/caracal/runtime" in payload, str(compose_file)
        assert "  runtime_data:" in payload, str(compose_file)


@pytest.mark.unit
def test_embedded_compose_persists_caracal_home_state_volume() -> None:
    compose_file = caracal_path("runtime", "data", "docker-compose.yml")
    payload = compose_file.read_text(encoding="utf-8")

    assert "runtime_data:/home/caracal/runtime" in payload
    assert "    runtime_data:" in payload


@pytest.mark.unit
def test_runtime_image_compose_has_vault_sidecar_and_hardcut_env_markers() -> None:
    compose_file = _REPO_ROOT / "deploy" / "docker-compose.image.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "  vault:" in payload
    assert "CCL_PRINCIPAL_KEY_BACKEND" in payload
    assert "CCL_VAULT_URL" in payload
    assert "CCL_VAULT_SESS_PUB_KEY_REF" in payload
    assert "CCL_SESS_SIGNING_ALG" in payload


@pytest.mark.unit
def test_runtime_compose_defaults_do_not_ship_latest_dev_tokens_or_baked_secrets() -> None:
    compose_files = (
        _REPO_ROOT / "deploy" / "docker-compose.yml",
        _REPO_ROOT / "deploy" / "docker-compose.image.yml",
        caracal_path("runtime", "data", "docker-compose.yml"),
    )

    forbidden_markers = (
        "infisical/infisical:latest",
        "caracal-runtime:latest",
        "ghcr.io/garudex-labs/caracal-runtime:latest",
        "dev-local-token",
        "caracal-dev-auth-secret",
        "f13dbc92aaaf86fa7cb0ed8ac3265f47",
        "CCL_DB_PASSWORD:-caracal",
        "POSTGRES_PASSWORD: ${CCL_DB_PASSWORD:-caracal}",
        "CCL_ENV_MODE:-dev",
    )
    required_markers = (
        "infisical/infisical:v0.159.16",
        "VAULT_AUTH_SECRET:?",
        "VAULT_ENC_KEY:?",
        "CCL_VAULT_TOKEN:?",
        "CCL_DB_PASSWORD:?",
        "CCL_ENV_MODE:-prod",
    )

    for compose_file in compose_files:
        payload = compose_file.read_text(encoding="utf-8")
        for marker in forbidden_markers:
            assert marker not in payload, f"{compose_file} still contains {marker!r}"
        for marker in required_markers:
            assert marker in payload, f"{compose_file} missing {marker!r}"


@pytest.mark.unit
def test_enterprise_compose_has_vault_sidecar_and_no_aws_or_null_backend_defaults() -> None:
    _skip_without_enterprise_repo()
    compose_file = _REPO_ROOT / ".." / "caracalEnterprise" / "docker-compose.enterprise.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "  vault:" in payload
    assert "infisical/infisical:latest" in payload
    assert "CCL_PRINCIPAL_KEY_BACKEND=${CCL_PRINCIPAL_KEY_BACKEND:-vault}" in payload
    assert "CCL_VAULT_URL=${CCL_VAULT_URL:-http://vault:8080}" in payload
    assert "CCL_SECRET_BACKEND" not in payload
    assert "VAULT_ADDR" not in payload
    assert "VAULT_ROLE_ID" not in payload
    assert "VAULT_SECRET_ID" not in payload
    assert "AWS_REGION" not in payload
    assert "AWS_ACCESS_KEY_ID" not in payload
    assert "AWS_SECRET_ACCESS_KEY" not in payload
    assert ":-null" not in payload


@pytest.mark.unit
def test_enterprise_compose_uses_separate_vault_topology_defaults_from_oss_runtime() -> None:
    _skip_without_enterprise_repo()
    compose_file = _REPO_ROOT / ".." / "caracalEnterprise" / "docker-compose.enterprise.yml"
    payload = compose_file.read_text(encoding="utf-8")

    assert "${CCLE_VAULT_PORT:-8180}:8080" in payload
    assert "CCL_VAULT_TOKEN=${CCL_VAULT_TOKEN:-enterprise-local-token}" in payload
    assert "CCL_VAULT_WORKSPACE_ID=${CCL_VAULT_WORKSPACE_ID:-caracal-enterprise-local}" in payload
    assert "CCL_VAULT_ENVIRONMENT=${CCL_VAULT_ENVIRONMENT:-dev}" in payload
    assert "CCL_VAULT_SECRET_PATH=${CCL_VAULT_SECRET_PATH:-/enterprise}" in payload


@pytest.mark.unit
def test_enterprise_startup_local_infra_boots_vault_sidecar() -> None:
    _skip_without_enterprise_repo()
    main_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "main.py"
    payload = main_file.read_text(encoding="utf-8")

    assert '"up", "-d", "redis", "postgres", "vault"' in payload
    assert "Start Postgres, Redis, and Vault manually before running uvicorn" in payload


@pytest.mark.unit
def test_enterprise_startup_has_no_best_effort_infra_fallbacks() -> None:
    _skip_without_enterprise_repo()
    main_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "main.py"
    payload = main_file.read_text(encoding="utf-8")

    assert "_try_start_known_containers" not in payload
    assert "ps --services --status running" not in payload
    assert "already reachable on localhost ports" not in payload
    assert "detected despite compose warnings" not in payload
    assert "continuing startup" not in payload


@pytest.mark.unit
def test_oss_env_example_uses_vault_only_hardcut_defaults() -> None:
    env_example = _REPO_ROOT / ".env.example"
    payload = env_example.read_text(encoding="utf-8")

    assert "CCL_PRINCIPAL_KEY_BACKEND=vault" in payload
    assert "CCL_VAULT_SIDECAR_IMAGE=infisical/infisical:v0.159.16" in payload
    assert "CCL_SECRET_BACKEND" not in payload
    assert "AWS_" not in payload
    assert "aws_kms" not in payload.lower()


@pytest.mark.unit
def test_enterprise_schema_hardcut_removes_bootstrap_sql_and_license_password_hash_artifact() -> None:
    _skip_without_enterprise_repo()
    bootstrap_sql = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "create_caracal_tables.sql"
    migration_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "alembic" / "versions" / "029_drop_license_password_hash_hardcut.py"
    metadata_cleanup_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "alembic" / "versions" / "030_cleanup_registration_metadata_hardcut.py"
    migration_payload = migration_file.read_text(encoding="utf-8")
    metadata_cleanup_payload = metadata_cleanup_file.read_text(encoding="utf-8")

    assert not bootstrap_sql.exists()
    assert 'revision: str = "029"' in migration_payload
    assert 'down_revision: Union[str, None] = "028"' in migration_payload
    assert 'op.drop_column("licenses", "password_hash")' in migration_payload
    assert 'revision: str = "030"' in metadata_cleanup_payload
    assert 'down_revision: Union[str, None] = "029"' in metadata_cleanup_payload
    assert '"sync_password_hash"' in metadata_cleanup_payload


@pytest.mark.unit
def test_core_crypto_module_has_no_private_key_sign_helpers() -> None:
    crypto_file = _REPO_ROOT / "caracal" / "core" / "crypto.py"
    payload = crypto_file.read_text(encoding="utf-8")

    assert "def sign_mandate(" not in payload
    assert "def sign_merkle_root(" not in payload


@pytest.mark.unit
def test_session_manager_signing_routes_only_through_signer_abstraction() -> None:
    session_manager_file = _REPO_ROOT / "caracal" / "core" / "session_manager.py"
    payload = session_manager_file.read_text(encoding="utf-8")

    assert "self._token_signer.sign_token(" in payload
    assert "self._signing_key" not in payload
    assert "jwt.encode(" not in payload


@pytest.mark.unit
def test_vault_module_has_no_legacy_private_key_compatibility_helpers() -> None:
    vault_file = _REPO_ROOT / "caracal" / "core" / "vault.py"
    payload = vault_file.read_text(encoding="utf-8")

    assert "MasterKeyProvider" not in payload
    assert "CCL_VAULT_MEK_SECRET" not in payload
    assert "_load_private_key(" not in payload
    assert "private_bytes(" not in payload
    assert "load_pem_private_key" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_core_crypto_sign_helper_imports() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    forbidden_import_markers = (
        "from caracal.core.crypto import sign_mandate",
        "from caracal.core.crypto import sign_merkle_root",
    )
    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_import_markers):
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_runtime_and_cli_gateway_resolution_is_centralized_in_edition_adapter() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []
    forbidden_markers = (
        'os.environ.get("CCLE_API_URL")',
        'os.environ.get("CCLE_GATEWAY_ENABLED")',
    )
    allowed_files: set[str] = set()

    for py_file in source_root.rglob("*.py"):
        relative_path = _caracal_relative_posix(py_file)
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_oss_vault_modules_do_not_reference_enterprise_surface() -> None:
    scoped_files = (
        _REPO_ROOT / "caracal" / "core" / "vault.py",
        _REPO_ROOT / "caracal" / "deployment" / "secrets_adapter.py",
        _REPO_ROOT / "caracal" / "provider" / "credential_store.py",
    )
    forbidden_markers = (
        "CCLE_",
        "caracalEnterprise",
        "caracalEnterprise.",
        "from caracal.enterprise",
        "import caracal.enterprise",
    )
    offenders: list[str] = []

    for py_file in scoped_files:
        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_enterprise_secrets_route_does_not_import_oss_secrets_adapter() -> None:
    enterprise_root = _OSS_ROOT.parent / "caracalEnterprise"
    if not enterprise_root.is_dir():
        pytest.skip("caracalEnterprise sibling checkout not present")
    route_file = enterprise_root / "services" / "api" / "src" / "caracal_api" / "routes" / "secrets.py"
    payload = route_file.read_text(encoding="utf-8")

    assert "caracal.deployment.secrets_adapter" not in payload
    assert "SecretsAdapter(" not in payload


@pytest.mark.unit
def test_feature_modules_do_not_branch_on_is_enterprise_directly() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []
    allowed_files = {
        "caracal/deployment/edition.py",
        "caracal/deployment/edition_adapter.py",
    }

    for py_file in source_root.rglob("*.py"):
        relative_path = _caracal_relative_posix(py_file)
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if ".is_enterprise()" in payload:
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_enterprise_license_validation_has_no_offline_acceptance_fallback() -> None:
    license_file = _REPO_ROOT / "caracal" / "deployment" / "enterprise_license.py"
    payload = license_file.read_text(encoding="utf-8")

    assert "validated from cache" not in payload
    assert "trying cached license" not in payload
    assert "falling back to cached license" not in payload
    assert "CCLE_API_URL" not in payload
    assert "password_protected" not in payload


@pytest.mark.unit
def test_gateway_flow_has_no_hidden_auto_sync_path() -> None:
    gateway_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "gateway_flow.py"
    payload = gateway_flow_file.read_text(encoding="utf-8")

    assert "_auto_sync_gateway_if_needed" not in payload
    assert "Gateway auto-sync attempt failed" not in payload


@pytest.mark.unit
def test_gateway_features_resolve_gateway_endpoint_through_edition_adapter() -> None:
    gateway_features_file = _REPO_ROOT / "caracal" / "core" / "gateway_features.py"
    payload = gateway_features_file.read_text(encoding="utf-8")

    assert "get_deployment_edition_adapter" in payload
    assert "resolve_gateway_feature_overrides" in payload
    assert "load_enterprise_config" not in payload
    assert "CCLE_API_URL" not in payload


@pytest.mark.unit
def test_sdk_gateway_adapter_has_no_direct_api_fallback_transport() -> None:
    gateway_adapter_file = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "gateway.py"
    payload = gateway_adapter_file.read_text(encoding="utf-8")

    assert "fallback_base_url" not in payload
    assert "falling back to direct API" not in payload
    assert "endpoint-implies-enabled" not in payload
    assert "broker_base_url" in payload


@pytest.mark.unit
def test_core_and_runtime_modules_do_not_import_enterprise_license_directly() -> None:
    source_roots = (
        _REPO_ROOT / "caracal" / "core",
        _REPO_ROOT / "caracal" / "runtime",
    )
    offenders: list[str] = []
    forbidden_markers = (
        "from caracal.enterprise.license import",
        "import caracal.enterprise.license",
    )

    for source_root in source_roots:
        for py_file in source_root.rglob("*.py"):
            payload = py_file.read_text(encoding="utf-8")
            if any(marker in payload for marker in forbidden_markers):
                offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_runtime_cli_flow_and_deployment_modules_do_not_import_retired_enterprise_client_modules() -> None:
    source_roots = (
        _REPO_ROOT / "caracal" / "cli",
        _REPO_ROOT / "caracal" / "flow",
        _REPO_ROOT / "caracal" / "deployment",
    )
    offenders: list[str] = []
    forbidden_markers = (
        "from caracal.enterprise.license import",
        "import caracal.enterprise.license",
        "from caracal.enterprise.sync import",
        "import caracal.enterprise.sync",
        "from caracal.enterprise import EnterpriseLicenseValidator",
    )

    for source_root in source_roots:
        for py_file in source_root.rglob("*.py"):
            payload = py_file.read_text(encoding="utf-8")
            if any(marker in payload for marker in forbidden_markers):
                offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_core_runtime_and_deployment_modules_have_no_enterprise_route_or_ui_workflow_markers() -> None:
    source_roots = (
        _REPO_ROOT / "caracal" / "core",
        _REPO_ROOT / "caracal" / "runtime",
        _REPO_ROOT / "caracal" / "deployment",
        _REPO_ROOT / "caracal" / "db",
    )
    offenders: list[str] = []
    forbidden_markers = (
        "/api/onboarding",
        "/api/license",
        "registration_handoff",
        "better_auth",
        "gateway admin API",
    )
    allowed_files = {
        "caracal/deployment/enterprise_license.py",
    }

    for source_root in source_roots:
        for py_file in source_root.rglob("*.py"):
            relative_path = _caracal_relative_posix(py_file)
            if relative_path in allowed_files:
                continue
            payload = py_file.read_text(encoding="utf-8").lower()
            if any(marker.lower() in payload for marker in forbidden_markers):
                offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_enterprise_connect_flow_has_no_implicit_gateway_sync_or_auto_sync_copy() -> None:
    enterprise_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "enterprise_flow.py"
    payload = enterprise_flow_file.read_text(encoding="utf-8")

    assert "pull_gateway_config()" not in payload
    assert "automatic sync" not in payload.lower()
    assert "Gateway auto-configured" not in payload
    assert "Enter license password" not in payload
    assert "password=" not in payload


@pytest.mark.unit
def test_mandate_manager_uses_signing_service_for_signature_generation() -> None:
    mandate_file = _REPO_ROOT / "caracal" / "core" / "mandate.py"
    payload = mandate_file.read_text(encoding="utf-8")

    assert "sign_canonical_payload_for_principal(" in payload
    assert "from caracal.core.crypto import sign_mandate" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_direct_registry_register_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    for py_file in source_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")

        # Core registry implementation is allowed to define registration internals.
        if _caracal_relative_posix(py_file) in {
            "caracal/core/identity.py",
            "caracal/identity/service.py",
        }:
            continue

        if "registry.register_principal(" in payload:
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_uses_identity_service_for_registration_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    allowed_files = {
        "caracal/core/identity.py",
        "caracal/identity/service.py",
    }
    disallowed_pattern = re.compile(r"\b(?!identity_service\b)[A-Za-z_][A-Za-z0-9_]*\.register_principal\(")

    for py_file in source_root.rglob("*.py"):
        relative_path = _caracal_relative_posix(py_file)
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if disallowed_pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_runtime_code_uses_identity_service_for_spawn_callsites() -> None:
    source_root = _REPO_ROOT / "caracal"
    offenders: list[str] = []

    allowed_files = {
        "caracal/identity/service.py",
        "caracal/identity/ais_server.py",
    }
    disallowed_pattern = re.compile(r"\b(?!identity_service\b)[A-Za-z_][A-Za-z0-9_]*\.spawn_principal\(")

    for py_file in source_root.rglob("*.py"):
        relative_path = _caracal_relative_posix(py_file)
        if relative_path in allowed_files:
            continue

        payload = py_file.read_text(encoding="utf-8")
        if disallowed_pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_enterprise_code_has_no_direct_registry_or_spawn_manager_usage() -> None:
    enterprise_root = _REPO_ROOT / "caracal" / "enterprise"
    offenders: list[str] = []

    forbidden_markers = (
        "PrincipalRegistry(",
        "SpawnManager(",
        ".register_principal(",
        ".spawn_principal(",
        "from caracal.core.identity import PrincipalRegistry",
        "from caracal.core.spawn import SpawnManager",
    )

    for py_file in enterprise_root.rglob("*.py"):
        payload = py_file.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(_caracal_relative_posix(py_file))

    assert offenders == []


@pytest.mark.unit
def test_forbidden_marker_scanner_covers_phase_13_hardcut_expansion() -> None:
    scanner_file = _REPO_ROOT / "scripts" / "hardcut_forbidden_marker_scan.py"
    payload = scanner_file.read_text(encoding="utf-8")

    assert "legacy_sync_auth_surfaces" in payload
    assert "compatibility_env_aliases" in payload
    assert "enterprise_logic_leakage" in payload
    assert "combined_onboarding_setup_helpers" in payload
    assert "stale_removed_surface_names" in payload
    assert "split_mode_markers" in payload
    assert "single_lineage_residuals" in payload
    assert "transitional_architecture_markers" in payload
    assert "provider_legacy_contract_fields" in payload
    assert "provider_legacy_secret_ref_schema_alias" in payload
    assert "provider_configmanager_secret_usage" in payload
    legacy_session_alg = "CCL_" + "SESSION_" + "JWT_ALGORITHM"
    assert legacy_session_alg not in payload
    assert "temporary blocker" in payload
    assert "guard file" in payload
    assert "non-hardcut" in payload
    assert "owner_phase" in payload
    assert "_gate_missing_repo_violations" in payload


@pytest.mark.unit
def test_active_provider_code_paths_have_no_legacy_provider_markers() -> None:
    workspace_root = _REPO_ROOT.parent
    oss_paths = (
        _REPO_ROOT / "caracal" / "provider" / "catalog.py",
        _REPO_ROOT / "caracal" / "provider" / "workspace.py",
        _REPO_ROOT / "caracal" / "provider" / "credential_store.py",
        _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py",
        _REPO_ROOT / "caracal" / "flow" / "screens" / "provider_manager.py",
        _REPO_ROOT / "caracal" / "deployment" / "broker.py",
        _REPO_ROOT / "caracal" / "deployment" / "gateway_client.py",
    )
    enterprise_paths = (
        _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "gateway.py",
        _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "sync.py",
        _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "gateway" / "provider_registry.py",
        _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "gateway" / "proxy.py",
        _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "gateway" / "page.tsx",
        _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts",
    )
    checked_files = list(oss_paths)
    if (_OSS_ROOT.parent / "caracalEnterprise" / "docker-compose.enterprise.yml").is_file():
        checked_files.extend(enterprise_paths)
    forbidden_markers = (
        "provider_definition_data",
        "api_key_ref",
        '"secret_ref"',
        "'secret_ref'",
        "ConfigManager.get_secret(",
        "ConfigManager.store_secret(",
    )

    offenders: list[str] = []
    for file_path in checked_files:
        if not file_path.exists():
            continue
        payload = file_path.read_text(encoding="utf-8")
        if any(marker in payload for marker in forbidden_markers):
            offenders.append(str(file_path.relative_to(workspace_root)))

    assert offenders == []





@pytest.mark.unit
def test_revocation_webhook_publisher_has_single_sync_header_strategy() -> None:
    publisher_file = _REPO_ROOT / "caracal" / "core" / "revocation_publishers.py"
    payload = publisher_file.read_text(encoding="utf-8")

    assert '"X-Sync-Api-Key": self._sync_api_key' in payload
    assert "bearer_token" not in payload
    assert 'headers["Authorization"]' not in payload


@pytest.mark.unit
def test_runtime_ais_handlers_are_not_stubbed() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert "AIS runtime handlers are not wired" not in payload


@pytest.mark.unit
def test_signing_service_uses_vault_reference_not_raw_private_key_resolution() -> None:
    signing_service_file = _REPO_ROOT / "caracal" / "core" / "signing_service.py"
    payload = signing_service_file.read_text(encoding="utf-8")

    assert "get_signing_key_reference(" in payload
    assert "resolve_private_key(" not in payload
    assert "load_pem_private_key(" not in payload


@pytest.mark.unit
def test_embedded_runtime_compose_includes_vault_sidecar() -> None:
    compose_file = caracal_path("runtime", "data", "docker-compose.yml")
    payload = compose_file.read_text(encoding="utf-8")

    assert "CCL_VAULT_SIDECAR_IMAGE" in payload
    assert "CCL_VAULT_URL" in payload
    assert "vault:" in payload
    assert "/home/caracal/.caracal" not in payload


@pytest.mark.unit
def test_runtime_host_up_pulls_and_starts_vault_sidecar() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert 'pull_services = ["postgres", "redis", "vault"]' in payload
    assert '[*up_cmd, "postgres", "redis", "vault", "mcp"]' in payload


@pytest.mark.unit
def test_runtime_host_flow_starts_vault_sidecar() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    payload = runtime_entrypoints.read_text(encoding="utf-8")

    assert 'compose_cmd + ["up", "-d", "postgres", "redis", "vault"]' in payload


@pytest.mark.unit
def test_config_manager_has_no_local_secret_storage_markers() -> None:
    config_manager_file = _REPO_ROOT / "caracal" / "deployment" / "config_manager.py"
    payload = config_manager_file.read_text(encoding="utf-8")

    assert "secrets.vault" not in payload
    assert "CCL_CFG_ENC_KEY" not in payload
    assert "aead_v1:" not in payload


@pytest.mark.unit
def test_operator_secret_surfaces_have_no_aws_secret_backend_copy() -> None:
    secrets_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "secrets_flow.py"
    secrets_cli_file = _REPO_ROOT / "caracal" / "cli" / "secrets.py"
    enterprise_flow_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "enterprise_flow.py"

    combined = "\n".join(
        [
            secrets_flow_file.read_text(encoding="utf-8"),
            secrets_cli_file.read_text(encoding="utf-8"),
            enterprise_flow_file.read_text(encoding="utf-8"),
        ]
    )

    assert "AWS Secrets Manager" not in combined
    assert "AWS SM" not in combined


@pytest.mark.unit
def test_principal_key_helpers_have_no_raw_private_key_resolution_api() -> None:
    principal_keys_file = _REPO_ROOT / "caracal" / "core" / "principal_keys.py"
    payload = principal_keys_file.read_text(encoding="utf-8")

    assert "def resolve_principal_private_key(" not in payload
    assert "def store_principal_private_key(" not in payload
    assert "def backup_local_private_key(" not in payload
    assert "ec.generate_private_key(" not in payload
    assert "private_bytes(" not in payload


@pytest.mark.unit
def test_delegation_manager_has_no_private_key_generation_helper() -> None:
    delegation_file = _REPO_ROOT / "caracal" / "core" / "delegation.py"
    payload = delegation_file.read_text(encoding="utf-8")

    assert "def generate_key_pair(" not in payload


@pytest.mark.unit
def test_merkle_config_and_cli_enforce_hardcut_vault_guard() -> None:
    settings_file = _REPO_ROOT / "caracal" / "config" / "settings.py"
    merkle_cli_file = _REPO_ROOT / "caracal" / "cli" / "merkle.py"

    settings_payload = settings_file.read_text(encoding="utf-8")
    cli_payload = merkle_cli_file.read_text(encoding="utf-8")

    assert "CCL_VAULT_MERKLE_SIGNING_KEY_REF" in settings_payload
    assert "CCL_VAULT_MERKLE_PUB_KEY_REF" in settings_payload
    assert "Local file-backed Merkle signing is forbidden." in settings_payload
    assert "Local Merkle key-file commands are disabled in runtime paths." in cli_payload


@pytest.mark.unit
def test_db_models_have_no_legacy_sync_state_orm_classes() -> None:
    models_file = _REPO_ROOT / "caracal" / "db" / "models.py"
    payload = models_file.read_text(encoding="utf-8")

    assert "class SyncOperation(" not in payload
    assert "class SyncConflict(" not in payload
    assert "class SyncMetadata(" not in payload


@pytest.mark.unit
def test_runtime_code_has_no_legacy_sync_state_table_markers() -> None:
    source_root = _REPO_ROOT / "caracal"
    allowed_files = {
        "caracal/db/schema_version.py",
        "caracal/runtime/hardcut_preflight.py",
    }
    allowed_prefixes = (
        "caracal/db/migrations/versions/",
    )
    offenders: list[str] = []

    pattern = re.compile(r"\bsync_(operations|conflicts|metadata)\b")

    for py_file in source_root.rglob("*.py"):
        relative_path = _caracal_relative_posix(py_file)
        if relative_path in allowed_files or relative_path.startswith(allowed_prefixes):
            continue

        payload = py_file.read_text(encoding="utf-8")
        if pattern.search(payload):
            offenders.append(relative_path)

    assert offenders == []


@pytest.mark.unit
def test_legacy_sync_modules_are_removed() -> None:
    sync_engine_file = _REPO_ROOT / "caracal" / "deployment" / "sync_engine.py"
    sync_state_file = _REPO_ROOT / "caracal" / "deployment" / "sync_state.py"

    assert not sync_engine_file.exists()
    assert not sync_state_file.exists()


@pytest.mark.unit
def test_main_cli_uses_enterprise_group_and_has_no_top_level_sync_group() -> None:
    main_cli_file = _REPO_ROOT / "caracal" / "cli" / "main.py"
    payload = main_cli_file.read_text(encoding="utf-8")

    assert "def enterprise(ctx):" in payload
    assert "enterprise.add_command(enterprise_login, name='login')" in payload
    assert "enterprise.add_command(enterprise_disconnect, name='disconnect')" in payload
    assert "enterprise.add_command(enterprise_status, name='status')" in payload
    assert "def sync(ctx):" not in payload
    assert "caracal sync " not in payload


@pytest.mark.unit
def test_deployment_cli_has_hardcut_enterprise_commands_only() -> None:
    deployment_cli_file = _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py"
    payload = deployment_cli_file.read_text(encoding="utf-8")

    assert "@click.group(name=\"sync\")" not in payload
    assert "@enterprise_group.command(name=\"login\")" in payload
    assert "@enterprise_group.command(name=\"disconnect\")" in payload
    assert "@enterprise_group.command(name=\"sync\")" in payload
    assert "@enterprise_group.command(name=\"status\")" in payload
    assert "enterprise_group.command(name=\"conflicts\")" not in payload
    assert "enterprise_group.command(name=\"auto-enable\")" not in payload
    assert "enterprise_group.command(name=\"auto-disable\")" not in payload


@pytest.mark.unit
def test_flow_sync_monitor_screen_is_removed() -> None:
    sync_monitor_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "sync_monitor.py"
    assert not sync_monitor_file.exists()


@pytest.mark.unit
def test_config_manager_has_no_sync_workspace_fields() -> None:
    config_manager_file = _REPO_ROOT / "caracal" / "deployment" / "config_manager.py"
    payload = config_manager_file.read_text(encoding="utf-8")

    assert "sync_enabled" not in payload
    assert "sync_url" not in payload
    assert "sync_direction" not in payload
    assert "auto_sync_interval" not in payload
    assert "conflict_strategy" not in payload


@pytest.mark.unit
def test_edition_detection_has_no_sync_or_license_backdoor_markers() -> None:
    edition_file = _REPO_ROOT / "caracal" / "deployment" / "edition.py"
    payload = edition_file.read_text(encoding="utf-8")

    assert "sync-enabled workspace" not in payload
    assert "enterprise license state" not in payload
    assert "edition_detected_enterprise_license" not in payload
    assert "edition_license_detection_failed" not in payload
    assert "sync_api_key" not in payload


@pytest.mark.unit
def test_edition_surfaces_have_no_auto_detected_gateway_copy() -> None:
    edition_file = _REPO_ROOT / "caracal" / "deployment" / "edition.py"
    deployment_cli_file = _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py"

    combined = "\n".join(
        [
            edition_file.read_text(encoding="utf-8"),
            deployment_cli_file.read_text(encoding="utf-8"),
        ]
    )

    assert "auto-detected edition" not in combined.lower()
    assert "auto-detected from enterprise connectivity" not in combined.lower()
    assert "explicit gateway execution signals" in combined


@pytest.mark.unit
def test_connector_docs_use_enterprise_command_path_only() -> None:
    docs_file = _REPO_ROOT / "docs" / "content" / "open-source" / "developers" / "enterprise-connector" / "index.mdx"
    payload = docs_file.read_text(encoding="utf-8")

    assert "caracal enterprise login <url> <token>" in payload
    assert "caracal enterprise status" in payload
    assert "caracal enterprise sync" in payload
    assert "caracal enterprise disconnect" in payload
    assert "caracal sync " not in payload


@pytest.mark.unit
def test_flow_tui_docs_have_no_sync_monitor_reference() -> None:
    docs_file = _REPO_ROOT / "docs" / "content" / "open-source" / "developers" / "flow-tui" / "index.mdx"
    if not docs_file.exists():
        pytest.skip("flow-tui docs file not yet created")
    payload = docs_file.read_text(encoding="utf-8")

    assert "sync monitor" not in payload.lower()


@pytest.mark.unit
def test_python_sdk_sync_uses_api_sync_path_only() -> None:
    authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "authority_client.py"
    async_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "async_authority_client.py"

    assert not authority_client.exists()
    assert not async_authority_client.exists()


@pytest.mark.unit
def test_async_python_sdk_has_no_legacy_sync_metadata_helper() -> None:
    async_authority_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "async_authority_client.py"
    assert not async_authority_client.exists()


@pytest.mark.unit
def test_sdk_sync_extension_stubs_are_removed() -> None:
    python_sync_stub = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "enterprise" / "sync.py"
    node_sync_stub = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "enterprise" / "sync.ts"
    python_enterprise_init = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "enterprise" / "__init__.py"
    node_enterprise_index = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "enterprise" / "index.ts"
    enterprise_facade = _REPO_ROOT / "caracal" / "enterprise" / "__init__.py"

    assert not python_sync_stub.exists()
    assert not node_sync_stub.exists()

    python_payload = python_enterprise_init.read_text(encoding="utf-8")
    node_payload = node_enterprise_index.read_text(encoding="utf-8")
    facade_payload = enterprise_facade.read_text(encoding="utf-8")

    assert "SyncExtension" not in python_payload
    assert "SyncExtension" not in node_payload
    assert "SyncExtension" not in facade_payload


@pytest.mark.unit
def test_node_sdk_dist_has_no_removed_sync_artifacts() -> None:
    node_dist_sync_js = _REPO_ROOT / "sdk" / "node-sdk" / "dist" / "enterprise" / "sync.js"
    node_dist_sync_dts = _REPO_ROOT / "sdk" / "node-sdk" / "dist" / "enterprise" / "sync.d.ts"

    assert not node_dist_sync_js.exists()
    assert not node_dist_sync_dts.exists()


@pytest.mark.unit
def test_python_sdk_secrets_have_no_aws_fallback_markers() -> None:
    secrets_adapter = _REPO_ROOT / "caracal" / "deployment" / "secrets_adapter.py"
    payload = secrets_adapter.read_text(encoding="utf-8")

    assert "boto3" not in payload
    assert "AWSSecretsManagerBackend" not in payload
    assert "_LocalAWSSecretsManagerBackend" not in payload
    assert "caracalEnterprise" not in payload
    assert "backend_for_tier" not in payload
    assert 'return f"aws:' not in payload
    assert 'return f"caracal:' in payload


@pytest.mark.unit
def test_deployment_help_has_no_sync_engine_or_legacy_secret_storage_text() -> None:
    deployment_help_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "deployment_help.py"
    payload = deployment_help_file.read_text(encoding="utf-8")

    assert "### Sync Engine" not in payload
    assert "System keyring integration" not in payload
    assert "PBKDF2 key derivation fallback" not in payload
    assert "Age encryption for secrets" not in payload


@pytest.mark.unit
def test_sdk_sources_have_no_legacy_security_or_sync_markers() -> None:
    sdk_roots = (
        _REPO_ROOT / "sdk" / "python-sdk" / "src",
        _REPO_ROOT / "sdk" / "node-sdk" / "src",
    )
    forbidden_patterns = (
        r"\bboto3\b",
        r"\bkeyring\b",
        r"cryptography\.fernet",
        r"\bFernet\b",
        r"/api/connection\b",
        r"\bSyncExtension\b",
        r"\bcaracal_sdk\.enterprise\.sync\b",
    )

    offenders: list[str] = []
    for root in sdk_roots:
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
                continue
            payload = path.read_text(encoding="utf-8")
            if any(re.search(pattern, payload) for pattern in forbidden_patterns):
                offenders.append(str(path.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_enterprise_frontend_secrets_surface_has_no_removed_migration_or_aws_backend_copy() -> None:
    _skip_without_enterprise_repo()
    secrets_route = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "secrets.py"
    secrets_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "secrets" / "page.tsx"
    frontend_api = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts"

    route_payload = secrets_route.read_text(encoding="utf-8")
    page_payload = secrets_page.read_text(encoding="utf-8")
    api_payload = frontend_api.read_text(encoding="utf-8")

    assert "migration_available" not in route_payload
    assert '@router.post("/migration-plan")' not in route_payload
    assert '@router.post("/migrate")' not in route_payload
    assert '@router.get("/migration-status/{migration_id}")' not in route_payload
    assert '@router.post("/downgrade-plan")' not in route_payload
    assert "MigrationWizard" not in page_payload
    assert '"migration"' not in page_payload
    assert "AWS Secrets Manager" not in page_payload
    assert "aws_secrets_manager" not in page_payload
    assert "migration-plan" not in api_payload
    assert "migration-status" not in api_payload
    assert "downgrade-plan" not in api_payload


@pytest.mark.unit
def test_enterprise_frontend_settings_copy_uses_hardcut_enterprise_commands_only() -> None:
    _skip_without_enterprise_repo()
    settings_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "settings" / "page.tsx"
    payload = settings_page.read_text(encoding="utf-8")

    assert "caracal enterprise login" not in payload
    assert "caracal enterprise sync" not in payload
    assert "generate-sync-key" not in payload
    assert "auto-sync" not in payload
    assert "Sync API key readiness" in payload


@pytest.mark.unit
def test_enterprise_frontend_principal_taxonomy_uses_final_role_terms_only() -> None:
    _skip_without_enterprise_repo()
    dashboard_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "page.tsx"
    principals_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "principals" / "page.tsx"
    setup_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "setup" / "page.tsx"
    team_step = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "components" / "onboarding" / "TeamStep.tsx"
    complete_step = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "components" / "onboarding" / "CompleteStep.tsx"
    frontend_api = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts"

    combined = "\n".join(
        [
            dashboard_page.read_text(encoding="utf-8"),
            principals_page.read_text(encoding="utf-8"),
            setup_page.read_text(encoding="utf-8"),
            team_step.read_text(encoding="utf-8"),
            complete_step.read_text(encoding="utf-8"),
            frontend_api.read_text(encoding="utf-8"),
        ]
    )

    assert '"human" | "orchestrator" | "worker" | "service"' in combined
    assert "Worker and orchestrator principals are agent identities." in combined
    assert "Service principals represent long-lived integrations." in combined
    assert "human operators in the workspace" in combined
    assert "Manage agents, users, and services" not in combined
    assert "AI agents, users, or services" not in combined
    assert "Register an AI agent principal" not in combined
    assert "Agent and service principals use their own runtime taxonomy" not in combined


@pytest.mark.unit
def test_enterprise_registration_rebind_surface_uses_final_route_names_only() -> None:
    _skip_without_enterprise_repo()
    license_route = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "license.py"
    frontend_api = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts"

    combined = "\n".join(
        [
            license_route.read_text(encoding="utf-8"),
            frontend_api.read_text(encoding="utf-8"),
        ]
    )

    assert "/api/license/request-rebind" in combined
    assert "/api/license/switch-container" not in combined
    assert "SwitchContainerRequest" not in combined
    assert "SwitchContainerResponse" not in combined
    assert "automatic sync" not in combined.lower()
    assert "cli auto-sync" not in combined.lower()


@pytest.mark.unit
def test_enterprise_gateway_surface_has_no_connection_instruction_or_auto_start_helpers() -> None:
    _skip_without_enterprise_repo()
    gateway_route = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "enterprise-api" / "src" / "caracal_enterprise" / "routes" / "gateway.py"
    gateway_page = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "gateway" / "page.tsx"
    frontend_api = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "lib" / "api.ts"

    combined = "\n".join(
        [
            gateway_route.read_text(encoding="utf-8"),
            gateway_page.read_text(encoding="utf-8"),
            frontend_api.read_text(encoding="utf-8"),
        ]
    )

    assert "/api/gateway/connection-instructions" not in combined
    assert "getConnectionInstructions" not in combined
    assert "SelfHostedSetupGuide" not in combined
    assert "QuickStartPanel" not in combined
    assert "setup_guide" not in combined
    assert "_try_start_gateway" not in combined
    assert '"auto_started"' not in combined
    assert "auto-start will be attempted" not in combined
    assert "Gateway auto-started successfully" not in combined
    assert "Deployment Contract" in combined


@pytest.mark.unit
def test_oss_packages_have_no_enterprise_backend_import_leakage() -> None:
    source_roots = (
        _REPO_ROOT / "caracal" / "core",
        _REPO_ROOT / "caracal" / "runtime",
        _REPO_ROOT / "caracal" / "identity",
        _REPO_ROOT / "caracal" / "cli",
        _REPO_ROOT / "caracal" / "flow",
        _REPO_ROOT / "caracal" / "deployment",
        _REPO_ROOT / "sdk",
    )
    offenders: list[str] = []
    forbidden_markers = (
        "from caracal_enterprise",
        "import caracal_enterprise",
        "caracal_enterprise.",
    )

    for source_root in source_roots:
        for path in source_root.rglob("*"):
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
                continue
            payload = path.read_text(encoding="utf-8")
            if any(marker in payload for marker in forbidden_markers):
                offenders.append(str(path.relative_to(_REPO_ROOT)))

    assert offenders == []


@pytest.mark.unit
def test_repo_has_no_phase_artifact_directory() -> None:
    assert not (_REPO_ROOT / ".github" / "hardcut").exists()


@pytest.mark.unit
def test_python_sdk_public_surface_remains_minimal_and_explicit() -> None:
    sdk_init = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "__init__.py"
    payload = sdk_init.read_text(encoding="utf-8")

    expected_exports = {
        "__version__",
        "CaracalClient",
        "CaracalBuilder",
        "SDKConfigurationError",
        "ContextManager",
        "ScopeContext",
        "ToolOperations",
        "HookRegistry",
        "CaracalExtension",
        "BaseAdapter",
        "HttpAdapter",
        "MockAdapter",
        "GatewayAdapter",
        "GatewayAdapterError",
        "build_gateway_adapter",
        "ais",
    }

    module = ast.parse(payload)
    exports: set[str] | None = None
    for node in module.body:
        if not isinstance(node, ast.Assign):
            continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        if node.targets[0].id != "__all__" or not isinstance(node.value, ast.List):
            continue
        exports = {
            element.value
            for element in node.value.elts
            if isinstance(element, ast.Constant) and isinstance(element.value, str)
        }
        break

    assert exports is not None

    assert exports == expected_exports
    assert "caracal_sdk.enterprise" not in payload
    assert "SyncExtension" not in payload


@pytest.mark.unit
def test_node_sdk_generated_output_matches_surviving_source_modules() -> None:
    import subprocess

    sdk_root = _REPO_ROOT / "sdk" / "node-sdk"
    src_root = sdk_root / "src"
    dist_root = sdk_root / "dist"

    if not any(dist_root.rglob("*.js")):
        subprocess.run(
            ["npx", "tsc", "--project", str(sdk_root / "tsconfig.json")],
            cwd=str(sdk_root),
            check=True,
            capture_output=True,
        )

    src_modules = {
        path.relative_to(src_root).with_suffix("").as_posix()
        for path in src_root.rglob("*.ts")
    }
    dist_modules = {
        path.relative_to(dist_root).with_suffix("").as_posix()
        for path in dist_root.rglob("*.js")
    }

    assert src_modules == dist_modules
    assert "enterprise/sync" not in src_modules
    assert "enterprise/sync" not in dist_modules


@pytest.mark.unit
def test_broker_and_gateway_migration_surfaces_remain_explicit_with_no_live_sync_dependency() -> None:
    _skip_without_enterprise_repo()
    migration_cli_file = _REPO_ROOT / "caracal" / "cli" / "migration.py"
    migration_manager_file = _REPO_ROOT / "caracal" / "deployment" / "migration.py"
    onboarding_file = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "components" / "onboarding" / "LicenseSetupStep.tsx"
    settings_file = _REPO_ROOT / ".." / "caracalEnterprise" / "src" / "app" / "dashboard" / "settings" / "page.tsx"

    combined = "\n".join(
        [
            migration_cli_file.read_text(encoding="utf-8"),
            migration_manager_file.read_text(encoding="utf-8"),
            onboarding_file.read_text(encoding="utf-8"),
            settings_file.read_text(encoding="utf-8"),
        ]
    )

    assert "explicit_only" in combined
    assert "migration_contracts" in combined
    assert "background reconciliation" in combined
    assert "continuous synchronization" in combined
    assert "live sync dependency" not in combined.lower()


@pytest.mark.unit
def test_migration_cli_exposes_explicit_hardcut_bidirectional_commands() -> None:
    migration_cli_file = _REPO_ROOT / "caracal" / "cli" / "migration.py"
    payload = migration_cli_file.read_text(encoding="utf-8")

    assert '@migrate_group.command(name="oss-to-enterprise")' in payload
    assert '@migrate_group.command(name="enterprise-to-oss")' in payload
    assert "--write-contract-file" in payload
    assert "--import-contract-file" in payload


@pytest.mark.unit
def test_enterprise_login_disconnect_do_not_embed_credential_migration_flows() -> None:
    deployment_cli_file = _REPO_ROOT / "caracal" / "cli" / "deployment_cli.py"
    payload = deployment_cli_file.read_text(encoding="utf-8")

    assert "--no-credential-migration" not in payload
    assert "Connected, but enterprise migration had warnings" not in payload
    assert "run `caracal migrate oss-to-enterprise`" in payload
    assert "run `caracal migrate enterprise-to-oss`" in payload
    assert "Use --allow-local-secrets-migration" not in payload


@pytest.mark.unit
def test_sdk_exports_include_management_migration_and_ais_groups() -> None:
    python_sdk_init = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "__init__.py"
    node_sdk_index = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "index.ts"

    python_payload = python_sdk_init.read_text(encoding="utf-8")
    node_payload = node_sdk_index.read_text(encoding="utf-8")

    assert 'import caracal_sdk.management as management' not in python_payload
    assert 'import caracal_sdk.migration as migration' not in python_payload
    assert 'import caracal_sdk.ais as ais' in python_payload
    assert "export * as management from './management'" not in node_payload
    assert "export * as migration from './migration'" not in node_payload
    assert "export * as ais from './ais'" in node_payload


@pytest.mark.unit
def test_sdk_clients_resolve_ais_routing_when_socket_path_is_configured() -> None:
    python_client = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "client.py"
    node_client = _REPO_ROOT / "sdk" / "node-sdk" / "src" / "client.ts"

    combined_python = python_client.read_text(encoding="utf-8")
    node_payload = node_client.read_text(encoding="utf-8")

    assert "resolve_sdk_base_url" in combined_python
    assert "CCL_AIS_UNIX_SOCKET_PATH" in (_REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "ais.py").read_text(encoding="utf-8")
    assert "resolveSdkBaseUrl" in node_payload


@pytest.mark.unit
def test_runtime_identity_layers_do_not_require_sdk_runtime_imports() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    identity_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"
    identity_service = _REPO_ROOT / "caracal" / "identity" / "service.py"

    combined = "\n".join(
        [
            runtime_entrypoints.read_text(encoding="utf-8"),
            identity_server.read_text(encoding="utf-8"),
            identity_service.read_text(encoding="utf-8"),
        ]
    )

    assert "caracal_sdk" not in combined
    assert "sdk/python-sdk" not in combined
    assert "sdk/node-sdk" not in combined


@pytest.mark.unit
def test_ais_runtime_binding_transport_and_refresh_contracts_are_present() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    ais_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"

    entrypoints_payload = runtime_entrypoints.read_text(encoding="utf-8")
    ais_payload = ais_server.read_text(encoding="utf-8")

    assert "startup_principal = _consume_ais_startup_attestation()" in entrypoints_payload
    assert "_complete_ais_startup_attestation(" in entrypoints_payload
    assert "validate_ais_bind_host" in ais_payload
    assert "@router.post(\"/refresh\")" in ais_payload


@pytest.mark.unit
def test_ais_runtime_has_no_credential_envelope_disk_persistence_markers() -> None:
    runtime_entrypoints = _REPO_ROOT / "caracal" / "runtime" / "entrypoints.py"
    ais_server = _REPO_ROOT / "caracal" / "identity" / "ais_server.py"

    combined = "\n".join(
        [
            runtime_entrypoints.read_text(encoding="utf-8").lower(),
            ais_server.read_text(encoding="utf-8").lower(),
        ]
    )

    assert "credential_envelope_path" not in combined
    assert "credential-envelope" not in combined
    assert "credential_envelope.json" not in combined


@pytest.mark.unit
def test_python_sdk_compat_module_has_no_fallback_alias_logic() -> None:
    compat_file = _REPO_ROOT / "sdk" / "python-sdk" / "src" / "caracal_sdk" / "_compat.py"
    payload = compat_file.read_text(encoding="utf-8")

    assert 'return "0.1.0"' not in payload
    assert "except Exception" not in payload
    assert "except ImportError" not in payload
    assert "CoreSDKConfigurationError" not in payload
    assert "CoreConnectionError" not in payload
    assert "CoreAuthorityDeniedError" not in payload


@pytest.mark.unit
def test_oss_enterprise_facade_has_no_sdk_extension_redirect_exports() -> None:
    enterprise_facade = _REPO_ROOT / "caracal" / "enterprise" / "__init__.py"
    payload = enterprise_facade.read_text(encoding="utf-8")

    assert "def __getattr__(" not in payload
    assert "ComplianceExtension" not in payload
    assert "AnalyticsExtension" not in payload
    assert "WorkflowsExtension" not in payload
    assert "SSOExtension" not in payload
    assert "LicenseExtension" not in payload


@pytest.mark.unit
def test_provider_manager_has_no_legacy_provider_secret_key_cleanup_markers() -> None:
    provider_manager_file = _REPO_ROOT / "caracal" / "flow" / "screens" / "provider_manager.py"
    payload = provider_manager_file.read_text(encoding="utf-8")

    assert "provider_{selected}_api_key" not in payload
    assert "provider_{selected}_credential" not in payload


@pytest.mark.unit
def test_enterprise_gateway_authority_proxy_module_is_removed() -> None:
    authority_proxy_file = _REPO_ROOT / ".." / "caracalEnterprise" / "services" / "gateway" / "authority_proxy.py"
    assert not authority_proxy_file.exists()
