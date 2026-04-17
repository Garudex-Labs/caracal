#!/usr/bin/env python3
"""Validate that the current test tree is internally consistent."""

import sys
from pathlib import Path
from typing import List, Tuple


def validate_directory_structure() -> Tuple[bool, List[str]]:
    """Validate that all required directories exist."""
    errors = []
    tests_dir = Path("tests")
    
    required_dirs = [
        "tests",
        "tests/unit",
        "tests/integration",
        "tests/e2e",
        "tests/security",
        "tests/sdk",
        "tests/fixtures",
        # Unit test components
        "tests/unit/core",
        "tests/unit/cli",
        "tests/unit/db",
        "tests/unit/deployment",
        "tests/unit/mcp",
        "tests/unit/merkle",
        "tests/unit/monitoring",
        "tests/unit/provider",
        "tests/unit/redis",
        "tests/unit/runtime",
        "tests/unit/storage",
        "tests/unit/flow",
        "tests/unit/config",
        "tests/unit/enterprise",
        # Integration test components
        "tests/integration/core",
        "tests/integration/db",
        "tests/integration/deployment",
        "tests/integration/mcp",
        "tests/integration/merkle",
        "tests/integration/monitoring",
        "tests/integration/redis",
        "tests/integration/api",
        "tests/integration/enterprise",
        # E2E test components
        "tests/e2e/workflows",
        "tests/e2e/cli",
        "tests/e2e/flow",
        "tests/e2e/enterprise",
        # Security test components
        "tests/security/abuse",
        "tests/security/fuzzing",
        "tests/security/regression",
        # SDK placeholders
        "tests/sdk/python",
        "tests/sdk/typescript",
    ]
    
    for dir_path in required_dirs:
        if not Path(dir_path).exists():
            errors.append(f"Missing directory: {dir_path}")
    
    return len(errors) == 0, errors


def validate_init_files() -> Tuple[bool, List[str]]:
    """Validate that __init__.py files exist in test directories."""
    errors = []
    
    required_init_files = [
        "tests/__init__.py",
        "tests/unit/__init__.py",
        "tests/integration/__init__.py",
        "tests/e2e/__init__.py",
        "tests/security/__init__.py",
        "tests/fixtures/__init__.py",
    ]
    
    for init_file in required_init_files:
        if not Path(init_file).exists():
            errors.append(f"Missing __init__.py: {init_file}")
    
    return len(errors) == 0, errors


def validate_config_files() -> Tuple[bool, List[str]]:
    """Validate that configuration files exist."""
    errors = []
    
    required_files = [
        "tests/conftest.py",
        "pyproject.toml",
    ]
    
    for file_path in required_files:
        if not Path(file_path).exists():
            errors.append(f"Missing configuration file: {file_path}")
    
    return len(errors) == 0, errors


def validate_test_files() -> Tuple[bool, List[str]]:
    """Validate basic test file naming conventions."""
    import re
    
    errors = []
    tests_dir = Path("tests")
    
    # Find all Python files in test directories
    test_dirs = ["unit", "integration", "e2e", "security"]
    
    for test_dir in test_dirs:
        dir_path = tests_dir / test_dir
        if not dir_path.exists():
            continue
        
        for py_file in dir_path.rglob("*.py"):
            # Skip __init__.py files
            if py_file.name == "__init__.py":
                continue
            
            filename = py_file.name
            
            # Check if file starts with test_
            if not filename.startswith("test_"):
                errors.append(
                    f"Test file does not start with 'test_': {py_file.relative_to(tests_dir)}"
                )
                continue
            
            # Remove test_ prefix and .py suffix
            name_part = filename[5:-3]  # Remove 'test_' and '.py'
            
            # Check for lowercase with underscores only
            if not re.match(r'^[a-z_]+$', name_part):
                errors.append(
                    f"Test file contains uppercase or invalid characters: {py_file.relative_to(tests_dir)}"
                )
                continue
            
    return len(errors) == 0, errors


def validate_sdk_readmes() -> Tuple[bool, List[str]]:
    """Validate that active SDK test directories are documented."""
    errors = []

    required_readmes = ["tests/sdk/README.md", "tests/sdk/python/README.md"]
    for readme in required_readmes:
        if not Path(readme).exists():
            errors.append(f"Missing SDK README: {readme}")

    typescript_dir = Path("tests/sdk/typescript")
    if typescript_dir.exists():
        active_entries = [
            path
            for path in typescript_dir.iterdir()
            if path.name != "__pycache__"
        ]
        if active_entries and not (typescript_dir / "README.md").exists():
            errors.append("Missing SDK README: tests/sdk/typescript/README.md")
    
    return len(errors) == 0, errors


def validate_fixture_files() -> Tuple[bool, List[str]]:
    """Validate that the shared fixture directory has content."""
    errors = []
    
    fixtures_dir = Path("tests/fixtures")
    if not fixtures_dir.exists():
        errors.append("Missing fixtures directory")
    else:
        py_files = list(fixtures_dir.glob("*.py"))
        if len(py_files) == 0:
            errors.append("No Python files in fixtures directory")
    
    return len(errors) == 0, errors


def main():
    """Run all validation checks."""
    print("=" * 70)
    print("Test Infrastructure Structure Validation")
    print("=" * 70)
    print()
    
    all_passed = True
    
    # Run all validation checks
    checks = [
        ("Directory Structure", validate_directory_structure),
        ("__init__.py Files", validate_init_files),
        ("Configuration Files", validate_config_files),
        ("Test File Naming", validate_test_files),
        ("SDK README Files", validate_sdk_readmes),
        ("Fixture Files", validate_fixture_files),
    ]
    
    for check_name, check_func in checks:
        print(f"Checking: {check_name}")
        passed, errors = check_func()
        
        if passed:
            print(f"  ✓ PASSED")
        else:
            print(f"  ✗ FAILED")
            all_passed = False
            for error in errors:
                print(f"    - {error}")
        print()
    
    print("=" * 70)
    if all_passed:
        print("✓ All validation checks passed!")
        print("=" * 70)
        return 0
    else:
        print("✗ Some validation checks failed. See errors above.")
        print("=" * 70)
        return 1


if __name__ == "__main__":
    sys.exit(main())
