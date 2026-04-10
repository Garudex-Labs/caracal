"""CLI entrypoint for the Caracal-governed swarm demo."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from ..baseline.scenario import load_scenario
from .workflow import GovernedRunConfig, run_governed_workflow, run_mock_governed_workflow, write_output


DEFAULT_TOOL_IDS = {
    "finance": "demo:swarm:logic:finance:analyze",
    "ops": "demo:swarm:logic:ops:analyze",
    "orchestrator": "demo:swarm:logic:orchestrator:summarize",
}


def _resolve_mock_mode(
    mode: str,
    *,
    api_key: str | None,
    mandates: dict[str, str],
) -> bool:
    normalized = mode.strip().lower()
    if normalized == "always":
        return True
    if normalized == "never":
        return False
    return not api_key or not all(mandates.values())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run Caracal-governed swarm demo")
    parser.add_argument(
        "--scenario",
        default=str(Path(__file__).resolve().parent.parent / "baseline" / "fixtures" / "scenario.json"),
        help="Path to scenario JSON file",
    )
    parser.add_argument(
        "--mock",
        default="auto",
        choices=["auto", "always", "never"],
        help="Mock mode behavior for governed workflow",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "outputs" / "latest.json"),
        help="Output path for governed run artifact",
    )

    parser.add_argument("--api-key", default=os.environ.get("CARACAL_API_KEY"))
    parser.add_argument("--base-url", default=os.environ.get("CARACAL_API_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--organization-id", default=os.environ.get("CARACAL_ORG_ID"))
    parser.add_argument("--workspace-id", default=os.environ.get("CARACAL_WORKSPACE_ID"))
    parser.add_argument("--project-id", default=os.environ.get("CARACAL_PROJECT_ID"))

    parser.add_argument(
        "--orchestrator-mandate-id",
        default=os.environ.get("CARACAL_ORCHESTRATOR_MANDATE_ID", ""),
    )
    parser.add_argument(
        "--finance-mandate-id",
        default=os.environ.get("CARACAL_FINANCE_MANDATE_ID", ""),
    )
    parser.add_argument(
        "--ops-mandate-id",
        default=os.environ.get("CARACAL_OPS_MANDATE_ID", ""),
    )

    parser.add_argument(
        "--finance-tool-id",
        default=DEFAULT_TOOL_IDS["finance"],
    )
    parser.add_argument(
        "--ops-tool-id",
        default=DEFAULT_TOOL_IDS["ops"],
    )
    parser.add_argument(
        "--orchestrator-tool-id",
        default=DEFAULT_TOOL_IDS["orchestrator"],
    )

    parser.add_argument(
        "--no-fallback",
        action="store_true",
        help="Disable fallback to deterministic mock mode when live mode fails",
    )
    parser.add_argument(
        "--enable-live-revocation",
        action="store_true",
        help="Attempt live mandate revocation and post-revoke denial validation",
    )
    parser.add_argument(
        "--revoker-id",
        default=os.environ.get("CARACAL_REVOCATION_REVOKER_ID"),
        help="Principal ID used to revoke mandate in live revocation mode",
    )
    parser.add_argument(
        "--revocation-reason",
        default="Demo live revocation check",
        help="Reason attached to live revocation operation",
    )
    parser.add_argument(
        "--require-revocation-denial",
        action="store_true",
        help="Fail live run when post-revocation denial evidence is not captured",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    scenario = load_scenario(args.scenario)
    mandates = {
        "orchestrator": str(args.orchestrator_mandate_id or "").strip(),
        "finance": str(args.finance_mandate_id or "").strip(),
        "ops": str(args.ops_mandate_id or "").strip(),
    }

    use_mock = _resolve_mock_mode(args.mock, api_key=args.api_key, mandates=mandates)

    if use_mock:
        result = run_mock_governed_workflow(scenario)
    else:
        if not args.api_key:
            raise ValueError("Live governed mode requires --api-key or CARACAL_API_KEY")

        missing = [name for name, value in mandates.items() if not value]
        if missing:
            raise ValueError(
                "Live governed mode requires mandate IDs for roles: " + ", ".join(sorted(missing))
            )

        config = GovernedRunConfig(
            api_key=args.api_key,
            base_url=args.base_url,
            organization_id=args.organization_id,
            workspace_id=args.workspace_id,
            project_id=args.project_id,
            mandates=mandates,
            tool_ids={
                "finance": args.finance_tool_id,
                "ops": args.ops_tool_id,
                "orchestrator": args.orchestrator_tool_id,
            },
            allow_mock_fallback=not args.no_fallback,
            revocation_enabled=bool(args.enable_live_revocation),
            revoker_id=str(args.revoker_id or "").strip() or None,
            revocation_reason=str(args.revocation_reason or "").strip() or "Demo live revocation check",
            require_revocation_denial=bool(args.require_revocation_denial),
        )
        result = run_governed_workflow(scenario, config)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_output(str(output_path), result)

    print(f"Run complete. Mode: {result['mode']}")
    print(f"Output: {output_path}")
    print("Final summary:")
    print(result.get("final_summary", ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
