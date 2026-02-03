#!/usr/bin/env python3
"""
Checkpoint test runner for Task 20 - Caracal Core v0.3
Runs all tests to ensure v0.3 features work correctly.
"""
import subprocess
import sys
import os

def run_tests():
    """Run all tests and report results"""
    print("="*80)
    print("CHECKPOINT 20: Running all v0.3 tests")
    print("="*80)
    
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    results = {}
    
    # Run unit tests
    print("\n1. Running unit tests...")
    result_unit = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/unit/', '-v', '--tb=short', '-x'],
        capture_output=False,
        text=True
    )
    results['unit'] = result_unit.returncode == 0
    
    # Run integration tests
    print("\n2. Running integration tests...")
    result_integration = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/integration/', '-v', '--tb=short', '-x'],
        capture_output=False,
        text=True
    )
    results['integration'] = result_integration.returncode == 0
    
    # Summary
    print("\n" + "="*80)
    print("TEST SUMMARY")
    print("="*80)
    print(f"Unit tests: {'✓ PASSED' if results['unit'] else '✗ FAILED'}")
    print(f"Integration tests: {'✓ PASSED' if results['integration'] else '✗ FAILED'}")
    print("="*80)
    
    if all(results.values()):
        print("\n✓ All tests passed!")
        return 0
    else:
        print("\n✗ Some tests failed")
        return 1

if __name__ == '__main__':
    sys.exit(run_tests())
