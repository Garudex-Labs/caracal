"""CLI entrypoint for the baseline LangChain swarm demo."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from .scenario import load_scenario
from .workflow import run_langchain_workflow, run_mock_workflow, write_output


def _env_has_key(provider: str) -> bool:
    provider_norm = provider.strip().lower()
    if provider_norm == "openai":
        return bool(os.getenv("OPENAI_API_KEY"))
    if provider_norm == "gemini":
        return bool(os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY"))
    return False


def _resolve_mock_mode(flag: str, provider: str) -> bool:
    normalized = flag.strip().lower()
    if normalized == "always":
        return True
    if normalized == "never":
        return False
    return not _env_has_key(provider)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run baseline LangChain swarm demo")
    parser.add_argument(
        "--scenario",
        default=str(Path(__file__).resolve().parent / "fixtures" / "scenario.json"),
        help="Path to scenario JSON file",
    )
    parser.add_argument(
        "--provider",
        default="openai",
        choices=["openai", "gemini"],
        help="Primary provider for LangChain init_chat_model",
    )
    parser.add_argument(
        "--model-id",
        default=None,
        help="Optional explicit model id (for example openai:gpt-4.1-mini)",
    )
    parser.add_argument(
        "--mock",
        default="auto",
        choices=["auto", "always", "never"],
        help="Mock mode behavior when API keys are unavailable",
    )
    parser.add_argument(
        "--output",
        default=str(Path(__file__).resolve().parent / "outputs" / "latest.json"),
        help="Output file path for run artifact",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    scenario = load_scenario(args.scenario)
    use_mock = _resolve_mock_mode(args.mock, args.provider)

    if use_mock:
        result = run_mock_workflow(scenario)
    else:
        result = run_langchain_workflow(
            scenario,
            provider=args.provider,
            model_id=args.model_id,
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
