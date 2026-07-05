"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Optional intelligence layer that uses OpenAI for human-like provider responses and falls back to deterministic text when unavailable.
"""

from __future__ import annotations

import os


def _enabled() -> bool:
    return (
        bool(os.environ.get("OPENAI_API_KEY"))
        and os.environ.get("PROVIDERLAB_FAST") != "1"
    )


def narrative(system: str, prompt: str, fallback: str) -> str:
    """Return a short generated narrative, or the deterministic fallback when LLM access is off."""
    if not _enabled():
        return fallback
    try:
        from openai import OpenAI

        client = OpenAI()
        resp = client.chat.completions.create(
            model=os.environ.get("PROVIDERLAB_LLM_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            max_tokens=180,
            temperature=0.4,
        )
        text = (resp.choices[0].message.content or "").strip()
        return text or fallback
    except Exception:
        return fallback
