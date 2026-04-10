"""Smoke test for bootstrap dry-run mode."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from examples.langchain_demo.bootstrap.main import main


def run_smoke_test() -> None:
    with tempfile.TemporaryDirectory() as temp_dir:
        artifact_path = Path(temp_dir) / "bootstrap_artifacts.json"
        env_path = Path(temp_dir) / "runtime_startup.env"

        exit_code = main([
            "--artifact-path",
            str(artifact_path),
            "--env-output",
            str(env_path),
        ])

        if exit_code != 0:
            raise RuntimeError(f"Bootstrap dry-run exited with status {exit_code}")

        if not artifact_path.exists():
            raise RuntimeError("Bootstrap dry-run did not create artifact file")

        payload = json.loads(artifact_path.read_text(encoding="utf-8"))
        if payload.get("mode") != "dry-run":
            raise RuntimeError("Expected dry-run mode in bootstrap artifact")

        expected_principals = {
            "swarm-issuer",
            "swarm-orchestrator",
            "swarm-finance",
            "swarm-ops",
        }
        principal_keys = set((payload.get("principals") or {}).keys())
        if principal_keys != expected_principals:
            raise RuntimeError(
                f"Unexpected principal keys in artifact: {sorted(principal_keys)}"
            )

    print("Bootstrap smoke test passed")


if __name__ == "__main__":
    run_smoke_test()
