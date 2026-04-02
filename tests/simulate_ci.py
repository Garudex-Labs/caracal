#!/usr/bin/env python
"""Simulate CI test workflow locally."""
import subprocess
import sys
from pathlib import Path

def run_step(name, cmd):
    """Run a CI step."""
    print(f"\n{'='*70}")
    print(f"Step: {name}")
    print(f"{'='*70}")
    print(f"Command: {' '.join(cmd)}")
    print()
    
    result = subprocess.run(
        cmd,
        cwd=Path(__file__).parent,
        capture_output=False,  # Show output directly
        text=True
    )
    
    if result.returncode != 0:
        print(f"\n✗ Step failed with exit code {result.returncode}")
        return False
    
    print(f"\n✓ Step passed")
    return True

def main():
    """Simulate CI workflow."""
    print("="*70)
    print("Simulating CI Test Workflow")
    print("="*70)
    
    steps = [
        ("Syntax Check - main_backup.py", 
         ["python", "-m", "py_compile", "caracal/cli/main_backup.py"]),
        
        ("Syntax Check - test_simple.py",
         ["python", "-m", "py_compile", "tests/test_simple.py"]),
        
        ("Run unit tests",
         ["python", "-m", "pytest", "-m", "unit", 
          "--cov=caracal", "--cov-report=term", "-v"]),
        
        ("Check coverage threshold (10%)",
         ["python", "-m", "coverage", "report", "--fail-under=10"]),
    ]
    
    failed_steps = []
    
    for name, cmd in steps:
        if not run_step(name, cmd):
            failed_steps.append(name)
    
    print("\n" + "="*70)
    print("Summary")
    print("="*70)
    
    if not failed_steps:
        print("\n✓ All steps passed! CI should succeed.")
        return 0
    else:
        print(f"\n✗ {len(failed_steps)} step(s) failed:")
        for step in failed_steps:
            print(f"  - {step}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
