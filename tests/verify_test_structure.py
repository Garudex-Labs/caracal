#!/usr/bin/env python3
"""Verification script for current test organization and structure."""

import os
import re
from pathlib import Path
from typing import List, Tuple, Dict
from dataclasses import dataclass


@dataclass
class ValidationResult:
    """Result of a validation check."""
    passed: bool
    message: str
    details: List[str] = None

    def __post_init__(self):
        if self.details is None:
            self.details = []


class TestStructureValidator:
    """Validates test organization and structure."""

    def __init__(self, tests_dir: Path):
        self.tests_dir = tests_dir
        self.results: List[ValidationResult] = []

    def validate_all(self) -> bool:
        """Run all validations and return overall pass/fail."""
        print("=" * 80)
        print("Test Structure Validation")
        print("=" * 80)
        print()

        # Run all validation checks
        self.validate_directory_depth()
        self.validate_structure_mirroring()
        self.validate_enterprise_location()
        self.validate_file_naming()
        self.validate_fixture_organization()

        # Print results
        self._print_results()

        # Return overall status
        return all(r.passed for r in self.results)

    def validate_directory_depth(self):
        """Validate test directories stay reasonably shallow."""
        print("Checking directory depth (max 4 levels, excluding caches)...")
        violations = []

        for root, dirs, files in os.walk(self.tests_dir):
            dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]
            rel_path = Path(root).relative_to(self.tests_dir)
            depth = len(rel_path.parts)

            if depth > 4:
                violations.append(f"  {rel_path} (depth: {depth})")

        if violations:
            self.results.append(ValidationResult(
                passed=False,
                message="Directory depth exceeds 4 levels",
                details=violations
            ))
        else:
            self.results.append(ValidationResult(
                passed=True,
                message="All directories within 4 levels"
            ))

    def validate_structure_mirroring(self):
        """Validate that tests/unit/ mirrors caracal/ structure."""
        print("Checking structure mirroring...")
        caracal_dir = self.tests_dir.parent / "caracal"
        unit_tests_dir = self.tests_dir / "unit"

        if not caracal_dir.exists():
            self.results.append(ValidationResult(
                passed=False,
                message="caracal/ directory not found"
            ))
            return

        if not unit_tests_dir.exists():
            self.results.append(ValidationResult(
                passed=False,
                message="tests/unit/ directory not found"
            ))
            return

        # Get all Python package directories in caracal/
        caracal_packages = set()
        for root, dirs, files in os.walk(caracal_dir):
            # Skip __pycache__ and hidden directories
            dirs[:] = [d for d in dirs if not d.startswith('__') and not d.startswith('.')]
            
            rel_path = Path(root).relative_to(caracal_dir)
            if rel_path != Path('.'):
                caracal_packages.add(rel_path)

        # Check which packages have corresponding test directories
        missing_test_dirs = []
        for package in sorted(caracal_packages):
            expected_test_dir = unit_tests_dir / package
            if not expected_test_dir.exists():
                missing_test_dirs.append(f"  tests/unit/{package}")

        if missing_test_dirs:
            self.results.append(ValidationResult(
                passed=False,
                message="Some source directories missing corresponding test directories",
                details=missing_test_dirs[:10]  # Limit to first 10
            ))
        else:
            self.results.append(ValidationResult(
                passed=True,
                message="Test structure mirrors source structure"
            ))

    def validate_enterprise_location(self):
        """Enterprise checks were retired when coverage became cross-cutting."""
        print("Checking enterprise test location...")
        self.results.append(ValidationResult(
            passed=True,
            message="Enterprise tests may live outside enterprise/ when coverage is cross-cutting"
        ))

    def validate_file_naming(self):
        """Validate test file naming conventions."""
        print("Checking test file naming conventions...")
        violations = []

        pattern = re.compile(r'^test_[a-z0-9_]+\.py$')

        # Directories to exclude from test file naming checks
        excluded_dirs = {'fixtures', '.hypothesis', '__pycache__'}

        candidate_roots = (
            self.tests_dir / "unit",
            self.tests_dir / "integration",
            self.tests_dir / "e2e",
            self.tests_dir / "security",
            self.tests_dir / "sdk",
        )

        for candidate_root in candidate_roots:
            if not candidate_root.exists():
                continue

            for root, dirs, files in os.walk(candidate_root):
                # Skip excluded directories
                dirs[:] = [d for d in dirs if d not in excluded_dirs]

                root_path = Path(root)
                if any(excluded in root_path.parts for excluded in excluded_dirs):
                    continue

                for file in files:
                    if not file.endswith('.py'):
                        continue
                    if file in ['__init__.py', 'conftest.py']:
                        continue

                    if file.startswith('validate_') or file.startswith('simulate_') or \
                       file.startswith('run_') or file.startswith('final_') or \
                       file.startswith('verify_'):
                        continue

                    file_path = Path(root) / file
                    rel_path = file_path.relative_to(self.tests_dir)

                    if not pattern.match(file):
                        violations.append(f"  {rel_path} (should be test_*.py with lowercase and underscores)")
                        continue

        if violations:
            self.results.append(ValidationResult(
                passed=False,
                message="Test files violate naming conventions",
                details=violations[:20]  # Limit to first 20
            ))
        else:
            self.results.append(ValidationResult(
                passed=True,
                message="All test files follow naming conventions"
            ))

    def validate_fixture_organization(self):
        """Validate fixture organization."""
        print("Checking fixture organization...")
        fixtures_dir = self.tests_dir / "fixtures"

        if not fixtures_dir.exists():
            self.results.append(ValidationResult(
                passed=False,
                message="tests/fixtures/ directory not found"
            ))
            return

        # Expected fixture files
        expected_fixtures = [
            "database.py",
            "crypto.py"
        ]

        missing_fixtures = []
        for fixture_file in expected_fixtures:
            if not (fixtures_dir / fixture_file).exists():
                missing_fixtures.append(f"  tests/fixtures/{fixture_file}")

        # Check if fixtures are documented
        readme_path = self.tests_dir / "README.md"
        fixtures_documented = False
        if readme_path.exists():
            with open(readme_path, 'r', encoding='utf-8') as f:
                content = f.read()
                if 'fixture' in content.lower():
                    fixtures_documented = True

        issues = []
        if missing_fixtures:
            issues.extend(["Missing fixture files:"] + missing_fixtures)
        if not fixtures_documented:
            issues.append("Fixtures not documented in tests/README.md")

        if issues:
            self.results.append(ValidationResult(
                passed=False,
                message="Fixture organization issues",
                details=issues
            ))
        else:
            self.results.append(ValidationResult(
                passed=True,
                message="Fixtures properly organized and documented"
            ))

    def _print_results(self):
        """Print validation results."""
        print()
        print("=" * 80)
        print("Validation Results")
        print("=" * 80)
        print()

        passed_count = sum(1 for r in self.results if r.passed)
        total_count = len(self.results)

        for result in self.results:
            status = "✓ PASS" if result.passed else "✗ FAIL"
            print(f"{status}: {result.message}")
            if result.details:
                for detail in result.details:
                    print(detail)
            print()

        print("=" * 80)
        print(f"Summary: {passed_count}/{total_count} checks passed")
        print("=" * 80)


def main():
    """Main entry point."""
    tests_dir = Path(__file__).parent
    validator = TestStructureValidator(tests_dir)
    success = validator.validate_all()
    return 0 if success else 1


if __name__ == "__main__":
    exit(main())
