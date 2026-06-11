"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Runnable reference of the Lynx Capital Caracal flows: per-boundary application clients,
labeled agent sessions spawned under narrowed delegation edges, resource-mandate minting,
and gateway-mediated partner calls.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv

load_dotenv(ROOT / ".env")

from app import caracal, tenancy
from app.agents.runner import create_runner


def describe_plan() -> None:
    """Offline view of the identity model the SDK flows operate over. Always runnable."""
    model = tenancy.load_model()
    print("application boundaries:")
    for app in model.applications:
        views = model.application_resources(app.id)
        print(f"  {app.applicationName}  views={len(views)}")
        for role in (r for r in model.roles if r.application == app.id):
            marker = " (dynamic)" if role.dynamic else ""
            print(f"    agent {role.name}{marker}  labels={tenancy.agent_labels(role.name)}  scopes={role.scopes}")
    print("resource views:")
    for view in model.resources:
        print(f"  {view.identifier}  app={view.application}  provider={view.provider}  scopes={view.scopes}")


async def demonstrate_worker(runner, role: str, scope: str) -> None:
    """Spawn one labeled worker session narrowed to its role's scopes, mint a resource
    mandate against one of its views, and release the session. A scope outside the
    role's grant is denied by policy at the mint."""
    handle = await runner.aspawn(role, scope, parent=None, layer="reference")
    authority = handle.authority
    if authority is None:
        print(f"  {role}: no authority resolved")
        handle.terminate("failed")
        return
    views = tenancy.role_views(role)
    try:
        token = authority.mandate(views[0], sorted(authority.scopes)[:1])
        print(f"  {role}: session={authority.agent_session_id}  mandate for {views[0]} ({len(token)} chars)")
    except Exception as exc:  # noqa: BLE001 — surface the failure class, fail closed.
        print(f"  {role}: mandate denied/failed ({type(exc).__name__}: {exc})")
    finally:
        handle.terminate()


async def run_flows() -> None:
    """Live demonstration: per-application runtimes, then one least-privilege worker per
    boundary, each as its own labeled Caracal agent session."""
    caracal.startup()
    run_id = f"reference-{uuid4().hex[:8]}"
    runner = create_runner(run_id)
    samples = [
        ("invoice-intake", "intake.reference"),
        ("ledger-match", "ledger.reference"),
        ("policy-check", "compliance.reference"),
        ("payment-execution", "payments.reference"),
        ("audit", "audit.reference"),
    ]
    print(f"\nrun {run_id}: spawning one worker per boundary")
    try:
        for role, scope in samples:
            await demonstrate_worker(runner, role, scope)
    finally:
        await runner.aclose()
        await caracal.aclose()


async def main() -> None:
    describe_plan()
    if not caracal.enabled():
        print("\nCaracal is not configured (set CARACAL_ZONE_ID and the LYNX_CARACAL_<APP>_* credentials).")
        print("The plan above is valid offline; provision the zone to exercise the live flows.")
        return
    await run_flows()


if __name__ == "__main__":
    asyncio.run(main())
