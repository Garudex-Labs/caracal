"""Scenario loading helpers for the baseline LangChain swarm demo."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


def default_scenario_path() -> Path:
    return Path(__file__).resolve().parent / "fixtures" / "scenario.json"


def load_scenario(path: str | Path | None = None) -> Dict[str, Any]:
    resolved = Path(path) if path else default_scenario_path()
    return json.loads(resolved.read_text(encoding="utf-8"))
