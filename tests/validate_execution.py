#!/usr/bin/env python3
"""
Validate test execution capabilities.

This script validates that tests can be discovered and executed properly.
"""
import subprocess
import sys
from pathlib import Path


def run_command(cmd: list, description: str) -> tuple[bool, str]:
    """Run a command and return success status and output."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=Path(__file__).parent.parent
        )
        return result.returncode == 0, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        return False, "Command timed out"
    except Exception as e:
        return False, str(e)


def validate_test_discovery():
    """Validate that pytest can discover tests."""
    print("Checking: Test Discovery")
    
    cmd = ["uv", "run", "pytest", "--collect-only", "-q", "tests/"]
    success, output = run_command(cmd, "Test discovery")
    
    if success:
        print("  ✓ PASSED - Tests can be discovered")
        return True
    else:
        print("  ✗ FAILED - Test discovery failed")
        print(f"    Output: {output[:200]}")
        return False


def validate_unit_test_execution():
    """Validate that unit tests can be executed."""
    print("Checking: Unit Test Execution")
    
    cmd = ["uv", "run", "pytest", "-m", "unit", "-v", "--tb=short"]
    success, output = run_command(cmd, "Unit test execution")
    
    if success or "no tests ran" in output.lower() or "passed" in output.lower():
        print("  ✓ PASSED - Unit tests can be executed")
        return True
    else:
        print("  ✗ FAILED - Unit test execution failed")
        print(f"    Output: {output[:200]}")
        return False


def validate_integration_test_execution():
    """Validate that integration tests can be executed."""
    print("Checking: Integration Test Execution")
    
    cmd = ["uv", "run", "pytest", "-m", "integration", "-v", "--tb=short"]
    success, output = run_command(cmd, "Integration test execution")
    
    if success or "no tests ran" in output.lower() or "passed" in output.lower():
        print("  ✓ PASSED - Integration tests can be executed")
        return True
    else:
        print("  ✗ FAILED - Integration test execution failed")
        print(f"    Output: {output[:200]}")
        return False


def validate_marker_filtering():
    """Validate that pytest markers work correctly."""
    print("Checking: Marker Filtering")
    
    # Check if markers are defined
    cmd = ["uv", "run", "pytest", "--markers"]
    success, output = run_command(cmd, "Marker listing")
    
    required_markers = ["unit", "integration", "e2e", "security", "property", "asyncio"]
    markers_found = all(marker in output for marker in required_markers)
    
    if success and markers_found:
        print("  ✓ PASSED - All required markers are defined")
        return True
    else:
        print("  ✗ FAILED - Some markers are missing")
        missing = [m for m in required_markers if m not in output]
        print(f"    Missing markers: {missing}")
        return False


def validate_async_support():
    """Validate that async tests are supported."""
    print("Checking: Async Test Support")
    
    # Check if pytest-asyncio is available
    cmd = ["uv", "run", "python", "-c", "import pytest_asyncio; print('OK')"]
    success, output = run_command(cmd, "Async support check")
    
    if success and "OK" in output:
        print("  ✓ PASSED - Async test support is available")
        return True
    else:
        print("  ✗ FAILED - pytest-asyncio not available")
        return False


def main():
    """Run all validation checks."""
    print("=" * 70)
    print("Test Execution Validation")
    print("=" * 70)
    print()
    
    checks = [
        validate_test_discovery,
        validate_unit_test_execution,
        validate_integration_test_execution,
        validate_marker_filtering,
        validate_async_support,
    ]
    
    results = []
    for check in checks:
        result = check()
        results.append(result)
        print()
    
    print("=" * 70)
    if all(results):
        print("✓ All validation checks passed!")
        print("=" * 70)
        return 0
    else:
        print("✗ Some validation checks failed. See errors above.")
        print("=" * 70)
        return 1


if __name__ == "__main__":
    sys.exit(main())
