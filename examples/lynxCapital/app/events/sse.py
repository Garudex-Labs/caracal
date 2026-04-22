"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SSE generators for per-run event streams and the global categorized log stream.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator

from app.events.bus import bus


async def run_stream(run_id: str) -> AsyncIterator[str]:
    q = bus.subscribe(run_id)
    replayed: set[str] = set()

    for event in bus.history(run_id):
        replayed.add(event.id)
        yield f"data: {event.model_dump_json()}\n\n"

    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30.0)
                if event.id not in replayed:
                    yield f"data: {event.model_dump_json()}\n\n"
                if event.kind == "run_end":
                    break
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        bus.unsubscribe(run_id, q)


async def log_stream(run_id: str | None = None, category: str | None = None) -> AsyncIterator[str]:
    q = bus.subscribe_global()

    for rid in bus.runs():
        if run_id and rid != run_id:
            continue
        for event in bus.history(rid):
            if category and event.category != category:
                continue
            yield f"data: {event.model_dump_json()}\n\n"

    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30.0)
                if run_id and event.run_id != run_id:
                    continue
                if category and event.category != category:
                    continue
                yield f"data: {event.model_dump_json()}\n\n"
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
    finally:
        bus.unsubscribe_global(q)
