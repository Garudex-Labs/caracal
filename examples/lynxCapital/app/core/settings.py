"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mutable runtime settings (active LLM model) layered on top of the static config.
"""
from __future__ import annotations

from threading import Lock

from app.config import get_config
from app.core.memory import MODEL_CONTEXT_LIMITS


ALLOWED_MODELS: tuple[str, ...] = (
    "gpt-5.4-nano",
    "gpt-5.4-mini",
    "gpt-5-mini",
)


class RuntimeSettings:
    def __init__(self) -> None:
        self._lock = Lock()
        self._model: str | None = None

    @property
    def model(self) -> str:
        with self._lock:
            if self._model is None:
                self._model = get_config().llm.model
            return self._model

    def set_model(self, model: str) -> tuple[str, str]:
        if model not in ALLOWED_MODELS:
            raise ValueError(f"Model {model!r} is not in the allowed set.")
        with self._lock:
            prior = self._model or get_config().llm.model
            self._model = model
            return model, prior

    def context_limit(self) -> int:
        return MODEL_CONTEXT_LIMITS.get(self.model, 128_000)


settings = RuntimeSettings()
