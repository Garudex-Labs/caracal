"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Configuration loader for company.yaml.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel


class ThemeConfig(BaseModel):
    primary: str
    accent: str
    surface: str
    border: str
    text: str
    danger: str
    success: str
    warning: str
    amber: str
    teal: str


class LlmConfig(BaseModel):
    model: str
    temperature: float


class RegionEntry(BaseModel):
    id: str
    name: str
    currency: str


class ProviderEntry(BaseModel):
    id: str
    name: str
    category: str


class AgentLayerEntry(BaseModel):
    id: str
    label: str
    perRegion: int
    ephemeral: bool = False


class ScenarioConfig(BaseModel):
    invoices: int
    totalUsd: float
    regions: int
    peakAgents: int
    description: str


class ContentConfig(BaseModel):
    tagline: str
    scenarioTitle: str
    disclaimer: str


class AppConfig(BaseModel):
    company: str
    shortName: str
    theme: ThemeConfig
    llm: LlmConfig
    regions: list[RegionEntry]
    providers: list[ProviderEntry]
    agentLayers: list[AgentLayerEntry]
    scenario: ScenarioConfig
    content: ContentConfig


_config: AppConfig | None = None


def load_config() -> AppConfig:
    global _config
    if _config is not None:
        return _config
    path = Path(os.environ.get("LYNX_CONFIG", "config/company.yaml"))
    data: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
    _config = AppConfig.model_validate(data)
    return _config


def get_config() -> AppConfig:
    if _config is None:
        raise RuntimeError("Config not loaded. Call load_config() at startup.")
    return _config
