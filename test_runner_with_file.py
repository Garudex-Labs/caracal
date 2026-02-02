#!/usr/bin/env python3
"""Test runner that writes to file"""
import subprocess
import sys
import os

output_file = "checkpoint_test_results.txt"

with open(output_file, 'w') as f:
    f.write("="*80 + "\n")
    f.write("CHECKPOINT 14: Test Results\n")
    f.write("="*80 + "\n\n")
    
    # Run unit tests
    f.write("1. Unit Tests\n")
    f.write("-"*80 + "\n")
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/unit/', '-v', '--tb=short'],
        capture_output=True,
        text=True
    )
    f.write(result.stdout)
    f.write(result.stderr)
    f.write(f"\nExit code: {result.returncode}\n\n")
    unit_passed = result.returncode == 0
    
    # Run integration tests
    f.write("2. Integration Tests\n")
    f.write("-"*80 + "\n")
    result = subprocess.run(
        [sys.executable, '-m', 'pytest', 'tests/integration/', '-v', '--tb=short'],
        capture_output=True,
        text=True
    )
    f.write(result.stdout)
    f.write(result.stderr)
    f.write(f"\nExit code: {result.returncode}\n\n")
    integration_passed = result.returncode == 0
    
    # Summary
    f.write("="*80 + "\n")
    f.write("SUMMARY\n")
    f.write("="*80 + "\n")
    f.write(f"Unit tests: {'PASSED' if unit_passed else 'FAILED'}\n")
    f.write(f"Integration tests: {'PASSED' if integration_passed else 'FAILED'}\n")
    
    if unit_passed and integration_passed:
        f.write("\n✓ All tests passed!\n")
    else:
        f.write("\n✗ Some tests failed\n")

print(f"Test results written to {output_file}")
print("Reading results...")
with open(output_file, 'r') as f:
    print(f.read())
