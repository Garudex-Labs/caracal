#!/usr/bin/env python3
"""
Checkpoint test runner for Task 14
"""
import subprocess
import sys

def run_tests():
    """Run all tests and report results"""
    print("="*80)
    print("CHECKPOINT 14: Running all tests")
    print("="*80)
    
    # Run unit tests
    print("\n1. Running unit tests...")
    result_unit = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/unit/', '-v', '--tb=short'],
        capture_output=True,
        text=True
    )
    
    print(result_unit.stdout)
    if result_unit.stderr:
        print("STDERR:", result_unit.stderr)
    
    # Run integration tests
    print("\n2. Running integration tests...")
    result_integration = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/integration/', '-v', '--tb=short'],
        capture_output=True,
        text=True
    )
    
    print(result_integration.stdout)
    if result_integration.stderr:
        print("STDERR:", result_integration.stderr)
    
    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    print(f"Unit tests: {'PASSED' if result_unit.returncode == 0 else 'FAILED'}")
    print(f"Integration tests: {'PASSED' if result_integration.returncode == 0 else 'FAILED'}")
    print("="*80)
    
    if result_unit.returncode == 0 and result_integration.returncode == 0:
        print("\n✓ All tests passed!")
        return 0
    else:
        print("\n✗ Some tests failed")
        return 1

if __name__ == '__main__':
    sys.exit(run_tests())
