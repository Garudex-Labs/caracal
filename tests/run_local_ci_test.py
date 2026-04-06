#!/usr/bin/env python
"""
Comprehensive local CI test to verify all fixes work correctly.
This simulates what GitHub Actions will run.
"""
import subprocess
import sys
from pathlib import Path
import os

class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def print_header(text):
    """Print a formatted header."""
    print(f"\n{Colors.BOLD}{Colors.BLUE}{'='*70}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{text}{Colors.RESET}")
    print(f"{Colors.BOLD}{Colors.BLUE}{'='*70}{Colors.RESET}\n")

def print_step(number, text):
    """Print a step header."""
    print(f"\n{Colors.BOLD}{Colors.YELLOW}[Step {number}] {text}{Colors.RESET}")
    print(f"{Colors.YELLOW}{'-'*70}{Colors.RESET}")

def run_command(cmd, description, cwd=None, env=None):
    """Run a command and report results."""
    if cwd is None:
        cwd = Path(__file__).parent
    
    print(f"\n{Colors.BOLD}Running:{Colors.RESET} {description}")
    print(f"{Colors.BOLD}Command:{Colors.RESET} {' '.join(cmd)}")
    
    try:
        # Merge environment variables
        run_env = os.environ.copy()
        if env:
            run_env.update(env)
        
        result = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=120,
            env=run_env
        )
        
        # Show output
        if result.stdout:
            print(f"\n{Colors.BOLD}Output:{Colors.RESET}")
            for line in result.stdout.strip().split('\n'):
                print(f"  {line}")
        
        if result.returncode == 0:
            print(f"\n{Colors.GREEN}✓ SUCCESS{Colors.RESET}")
            return True
        else:
            print(f"\n{Colors.RED}✗ FAILED (exit code: {result.returncode}){Colors.RESET}")
            if result.stderr:
                print(f"\n{Colors.RED}Error output:{Colors.RESET}")
                for line in result.stderr.strip().split('\n'):
                    print(f"  {line}")
            return False
            
    except subprocess.TimeoutExpired:
        print(f"\n{Colors.RED}✗ TIMEOUT (exceeded 120 seconds){Colors.RESET}")
        return False
    except Exception as e:
        print(f"\n{Colors.RED}✗ ERROR: {e}{Colors.RESET}")
        return False

def main():
    """Run all CI validation tests."""
    print_header("LOCAL CI/CD VALIDATION TEST")
    print(f"{Colors.BOLD}This simulates the GitHub Actions workflow locally{Colors.RESET}")
    
    results = []
    
    # Step 1: Check Python version
    print_step(1, "Check Python Version")
    success = run_command(
        ["python", "--version"],
        "Verify Python version"
    )
    results.append(("Python Version Check", success))
    
    # Step 2: Syntax validation
    print_step(2, "Syntax Validation")
    
    # Check main.py
    success = run_command(
        ["python", "-m", "py_compile", "caracal/cli/main.py"],
        "Validate main.py syntax"
    )
    results.append(("main.py Syntax", success))
    
    # Check test_simple.py
    success = run_command(
        ["python", "-m", "py_compile", "tests/test_simple.py"],
        "Validate test_simple.py syntax"
    )
    results.append(("test_simple.py Syntax", success))
    
    # Step 3: Import validation
    print_step(3, "Import Validation")
    
    success = run_command(
        ["python", "-c", "import sys; sys.path.insert(0, '.'); import caracal; print(f'Caracal version: {caracal.__version__}')"],
        "Import caracal package"
    )
    results.append(("Caracal Import", success))
    
    # Step 4: Check dependencies
    print_step(4, "Check Test Dependencies")
    
    success = run_command(
        ["python", "-c", "import pytest; print(f'pytest version: {pytest.__version__}')"],
        "Check pytest availability"
    )
    results.append(("pytest Available", success))
    
    success = run_command(
        ["python", "-c", "import coverage; print(f'coverage version: {coverage.__version__}')"],
        "Check coverage availability"
    )
    results.append(("coverage Available", success))
    
    # Step 5: Test discovery
    print_step(5, "Test Discovery")
    
    success = run_command(
        ["python", "-m", "pytest", "--collect-only", "tests/test_simple.py", "-q"],
        "Discover tests in test_simple.py"
    )
    results.append(("Test Discovery", success))
    
    # Step 6: Run unit tests (like CI)
    print_step(6, "Run Unit Tests")
    
    success = run_command(
        ["python", "-m", "pytest", "-m", "unit", 
         "--cov=caracal", "--cov-report=term", "-v"],
        "Run unit tests with coverage",
        env={"PYTHONPATH": str(Path.cwd())}
    )
    results.append(("Unit Tests", success))
    
    # Step 7: Check coverage threshold
    print_step(7, "Check Coverage Threshold")
    
    success = run_command(
        ["python", "-m", "coverage", "report", "--fail-under=10"],
        "Verify coverage meets 10% threshold"
    )
    results.append(("Coverage Threshold (10%)", success))
    
    # Step 8: Generate coverage report
    print_step(8, "Generate Coverage Report")
    
    success = run_command(
        ["python", "-m", "coverage", "html"],
        "Generate HTML coverage report"
    )
    results.append(("HTML Coverage Report", success))
    
    # Step 9: Validate test structure
    print_step(9, "Validate Test Structure")
    
    success = run_command(
        ["python", "tests/validate_structure.py"],
        "Run test structure validation"
    )
    results.append(("Test Structure Validation", success))
    
    # Print summary
    print_header("TEST SUMMARY")
    
    all_passed = True
    for description, success in results:
        status = f"{Colors.GREEN}✓ PASS{Colors.RESET}" if success else f"{Colors.RED}✗ FAIL{Colors.RESET}"
        print(f"{status}: {description}")
        if not success:
            all_passed = False
    
    print(f"\n{Colors.BOLD}{'='*70}{Colors.RESET}")
    
    if all_passed:
        print(f"\n{Colors.GREEN}{Colors.BOLD}✓ ALL TESTS PASSED!{Colors.RESET}")
        print(f"{Colors.GREEN}The CI/CD pipeline should work correctly.{Colors.RESET}\n")
        return 0
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}✗ SOME TESTS FAILED!{Colors.RESET}")
        print(f"{Colors.RED}Please fix the issues before pushing to CI.{Colors.RESET}\n")
        return 1

if __name__ == "__main__":
    sys.exit(main())
