"""CLI entrypoint for the Caracal-backed demo app workflow."""

from __future__ import annotations

import argparse
from pathlib import Path

from ..baseline.scenario import load_scenario
from .workflow import GovernedRunConfig, run_governed_workflow, write_output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Caracal-backed demo workflow")
    parser.add_argument(
        "--scenario",
        default=str(Path(__file__).resolve().parent.parent / "baseline" / "fixtures" / "scenario.json"),
        help="Path to scenario JSON file",
    )
    parser.add_argument(
        "--mode",
        default="mock",
        choices=["mock", "real"],
        help="Whether upstream providers should run in deterministic mock mode or real API mode",
    )
    parser.add_argument(
        "--provider-strategy",
        default="mixed",
        choices=["mixed", "openai", "gemini"],
        help="Provider routing strategy for finance and ops specialist briefs",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "outputs" / "latest.json"),
        help="Output path for governed run artifact",
    )
    parser.add_argument(
        "--no-revocation-check",
        action="store_true",
        help="Skip the post-delegation mandate revocation check",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    scenario = load_scenario(args.scenario)
    result = run_governed_workflow(
        scenario,
        GovernedRunConfig(
            mode=args.mode,
            provider_strategy=args.provider_strategy,
            include_revocation_check=not bool(args.no_revocation_check),
        ),
    )

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
