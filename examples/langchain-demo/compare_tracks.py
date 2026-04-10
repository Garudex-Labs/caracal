"""Compare baseline and governed demo tracks against shared expectations."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .acceptance import load_expected_outcomes
from .baseline.scenario import load_scenario
from .baseline.workflow import run_mock_workflow
from .caracal.workflow import run_mock_governed_workflow


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compare baseline and governed demo tracks")
    parser.add_argument(
        "--scenario",
        default=str(Path(__file__).resolve().parent / "baseline" / "fixtures" / "scenario.json"),
        help="Path to scenario JSON file",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "outputs" / "comparison.json"),
        help="Output path for comparison artifact",
    )
    return parser


def build_comparison_artifact(scenario_path: str) -> dict[str, object]:
    scenario = load_scenario(scenario_path)
    expected = load_expected_outcomes()
    baseline = run_mock_workflow(scenario)
    governed = run_mock_governed_workflow(scenario)

    return {
        "scenario": scenario.get("company"),
        "input_prompt": scenario.get("user_prompt"),
        "expected_outcomes": expected,
        "baseline": {
            "mode": baseline.get("mode"),
            "acceptance_passed": baseline.get("acceptance", {}).get("passed"),
            "tool_invocations": baseline.get("tool_invocation_summary"),
            "has_authority_evidence": bool(baseline.get("authority_evidence")),
            "final_summary": baseline.get("final_summary"),
        },
        "governed": {
            "mode": governed.get("mode"),
            "acceptance_passed": governed.get("acceptance", {}).get("passed"),
            "has_authority_evidence": bool(governed.get("authority_evidence")),
            "revocation": governed.get("revocation"),
            "final_summary": governed.get("final_summary"),
        },
        "comparison": {
            "shared_business_outcomes_match": baseline.get("business_outcomes")
            == governed.get("business_outcomes"),
            "execution_boundary_difference": (
                "Baseline uses direct local tools and LangChain sub-agent wrappers; "
                "governed mode routes tool execution through Caracal mandates and authority checks."
            ),
            "permission_model_difference": (
                "Baseline has no mandate requirement; governed mode requires role-specific mandate IDs."
            ),
            "revocation_behavior_difference": (
                "Baseline cannot revoke tool access mid-run; governed mode captures denied-after-revoke evidence."
            ),
            "auditability_difference": (
                "Baseline records tool usage; governed mode records delegation, validation, and revocation evidence."
            ),
        },
    }


def main() -> int:
    args = build_parser().parse_args()
    artifact = build_comparison_artifact(args.scenario)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(artifact, indent=2) + "\n", encoding="utf-8")

    print(f"Comparison written to {output_path}")
    print(f"Baseline acceptance: {artifact['baseline']['acceptance_passed']}")
    print(f"Governed acceptance: {artifact['governed']['acceptance_passed']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
