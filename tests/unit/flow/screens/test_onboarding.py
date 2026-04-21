from io import StringIO
from pathlib import Path

import yaml
from rich.console import Console

from caracal.flow.screens import onboarding


class _WizardStub:
    def __init__(self, context: dict | None = None) -> None:
        self.context = context or {}
        self.console = Console(file=StringIO(), force_terminal=False, width=120)


def test_step_principal_skips_for_existing_workspace() -> None:
    wizard = _WizardStub({"workspace_existing": True})

    result = onboarding._step_principal(wizard)

    assert result is None
    assert "first_principal" not in wizard.context


def test_step_principal_collects_identity_for_new_workspace(monkeypatch) -> None:
    wizard = _WizardStub({"workspace_existing": False})

    monkeypatch.setattr(onboarding.FlowPrompt, "select", lambda self, *args, **kwargs: "human")

    def _fake_text(self, label: str, **kwargs):
        if label == "Principal name":
            return "alice"
        if label == "Owner email":
            return "alice@example.com"
        raise AssertionError(f"Unexpected prompt label: {label}")

    monkeypatch.setattr(onboarding.FlowPrompt, "text", _fake_text)

    result = onboarding._step_principal(wizard)

    assert result == {
        "name": "alice",
        "owner": "alice@example.com",
        "kind": "human",
    }
    assert wizard.context["first_principal"] == result


def test_initialize_caracal_dir_uses_vault_merkle_defaults(tmp_path) -> None:
    workspace = tmp_path / "ws"

    onboarding._initialize_caracal_dir(workspace, wipe=False)

    cfg = yaml.safe_load((workspace / "config.yaml").read_text())
    assert cfg["merkle"]["signing_backend"] == "vault"
    assert "private_key_path" not in cfg["merkle"]


def test_normalize_workspace_merkle_hardcut_config_migrates_software_backend(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("CARACAL_VAULT_MERKLE_SIGNING_KEY_REF", raising=False)
    monkeypatch.delenv("CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF", raising=False)
    workspace = tmp_path / "legacy-ws"
    workspace.mkdir(parents=True)
    cfg_path = workspace / "config.yaml"
    cfg_path.write_text(
        yaml.safe_dump(
            {
                "merkle": {
                    "signing_backend": "software",
                    "signing_algorithm": "ES256",
                    "private_key_path": str(Path("/tmp/legacy.pem")),
                }
            },
            default_flow_style=False,
            sort_keys=False,
        )
    )

    onboarding._normalize_workspace_merkle_hardcut_config(workspace)

    cfg = yaml.safe_load(cfg_path.read_text())
    assert cfg["merkle"]["signing_backend"] == "vault"
    assert cfg["merkle"]["vault_key_ref"] == "${CARACAL_VAULT_MERKLE_SIGNING_KEY_REF}"
    assert cfg["merkle"]["vault_public_key_ref"] == "${CARACAL_VAULT_MERKLE_PUBLIC_KEY_REF}"
    assert "private_key_path" not in cfg["merkle"]


def test_select_persisted_workspace_schema_keeps_existing_schema() -> None:
    assert (
        onboarding._select_persisted_workspace_schema(
            "ws_lsf",
            "ws_lsf_20260407120000_deadbeef",
        )
        == "ws_lsf"
    )


def test_select_persisted_workspace_schema_uses_proposed_when_missing() -> None:
    assert (
        onboarding._select_persisted_workspace_schema(
            "",
            "ws_lsf_20260407120000_deadbeef",
        )
        == "ws_lsf_20260407120000_deadbeef"
    )
