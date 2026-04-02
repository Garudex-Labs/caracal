#!/usr/bin/env python3
"""
Validate CI/CD pipeline configuration.

This script validates that the GitHub Actions workflow is properly configured.
"""
import sys
import yaml
from pathlib import Path
from typing import List, Tuple


def validate_workflow_file_exists() -> Tuple[bool, List[str]]:
    """Validate that the workflow file exists."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    if not workflow_path.exists():
        errors.append("GitHub Actions workflow file not found: .github/workflows/test.yml")
        return False, errors
    
    return True, errors


def validate_workflow_structure() -> Tuple[bool, List[str]]:
    """Validate the structure of the workflow file."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    if not workflow_path.exists():
        errors.append("Workflow file not found")
        return False, errors
    
    try:
        with open(workflow_path, 'r') as f:
            workflow = yaml.safe_load(f)
        
        # Check required top-level keys
        required_keys = ['name', 'on', 'jobs']
        for key in required_keys:
            if key not in workflow:
                errors.append(f"Missing required key in workflow: {key}")
        
        # Check that 'test' job exists
        if 'jobs' in workflow and 'test' not in workflow['jobs']:
            errors.append("Missing 'test' job in workflow")
        
        return len(errors) == 0, errors
    
    except yaml.YAMLError as e:
        errors.append(f"Invalid YAML in workflow file: {e}")
        return False, errors
    except Exception as e:
        errors.append(f"Error reading workflow file: {e}")
        return False, errors


def validate_python_versions() -> Tuple[bool, List[str]]:
    """Validate that multiple Python versions are tested."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    try:
        with open(workflow_path, 'r') as f:
            workflow = yaml.safe_load(f)
        
        # Check for Python version matrix
        if 'jobs' in workflow and 'test' in workflow['jobs']:
            test_job = workflow['jobs']['test']
            
            if 'strategy' in test_job and 'matrix' in test_job['strategy']:
                matrix = test_job['strategy']['matrix']
                
                if 'python-version' in matrix:
                    versions = matrix['python-version']
                    
                    if len(versions) < 2:
                        errors.append("Should test multiple Python versions")
                    
                    # Check for Python 3.10+
                    has_310_plus = any('3.10' in str(v) or '3.11' in str(v) or '3.12' in str(v) for v in versions)
                    if not has_310_plus:
                        errors.append("Should include Python 3.10 or higher")
                else:
                    errors.append("Python version matrix not found")
            else:
                errors.append("Strategy matrix not found")
        
        return len(errors) == 0, errors
    
    except Exception as e:
        errors.append(f"Error validating Python versions: {e}")
        return False, errors


def validate_test_services() -> Tuple[bool, List[str]]:
    """Validate that required services (PostgreSQL, Redis) are configured."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    try:
        with open(workflow_path, 'r') as f:
            workflow = yaml.safe_load(f)
        
        if 'jobs' in workflow and 'test' in workflow['jobs']:
            test_job = workflow['jobs']['test']
            
            if 'services' not in test_job:
                errors.append("No services configured in test job")
                return False, errors
            
            services = test_job['services']
            
            # Check for PostgreSQL
            if 'postgres' not in services:
                errors.append("PostgreSQL service not configured")
            
            # Check for Redis
            if 'redis' not in services:
                errors.append("Redis service not configured")
        
        return len(errors) == 0, errors
    
    except Exception as e:
        errors.append(f"Error validating services: {e}")
        return False, errors


def validate_test_steps() -> Tuple[bool, List[str]]:
    """Validate that all required test steps are present."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    try:
        with open(workflow_path, 'r') as f:
            workflow = yaml.safe_load(f)
        
        if 'jobs' in workflow and 'test' in workflow['jobs']:
            test_job = workflow['jobs']['test']
            
            if 'steps' not in test_job:
                errors.append("No steps defined in test job")
                return False, errors
            
            steps = test_job['steps']
            step_names = [step.get('name', '') for step in steps]
            
            # Check for required steps
            required_steps = [
                'unit tests',
                'integration tests',
                'security tests',
                'e2e tests',
                'coverage',
            ]
            
            for required in required_steps:
                if not any(required.lower() in name.lower() for name in step_names):
                    errors.append(f"Missing step for: {required}")
        
        return len(errors) == 0, errors
    
    except Exception as e:
        errors.append(f"Error validating test steps: {e}")
        return False, errors


def validate_coverage_steps() -> Tuple[bool, List[str]]:
    """Validate that coverage measurement and reporting steps are present."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    try:
        with open(workflow_path, 'r') as f:
            content = f.read()
        
        # Check for coverage-related commands
        coverage_checks = [
            '--cov=caracal',
            '--cov-report',
            'coverage report',
            'coverage html',
        ]
        
        for check in coverage_checks:
            if check not in content:
                errors.append(f"Missing coverage command: {check}")
        
        # Check for coverage threshold
        if 'fail-under' not in content:
            errors.append("Coverage threshold (fail-under) not configured")
        
        return len(errors) == 0, errors
    
    except Exception as e:
        errors.append(f"Error validating coverage steps: {e}")
        return False, errors


def validate_artifact_uploads() -> Tuple[bool, List[str]]:
    """Validate that test artifacts are uploaded."""
    errors = []
    workflow_path = Path(".github/workflows/test.yml")
    
    try:
        with open(workflow_path, 'r') as f:
            content = f.read()
        
        # Check for artifact uploads
        if 'actions/upload-artifact' not in content:
            errors.append("No artifact upload steps found")
        
        # Check for coverage report upload
        if 'coverage-report' not in content:
            errors.append("Coverage report upload not configured")
        
        return len(errors) == 0, errors
    
    except Exception as e:
        errors.append(f"Error validating artifact uploads: {e}")
        return False, errors


def main():
    """Run all validation checks."""
    print("=" * 70)
    print("CI/CD Pipeline Validation")
    print("=" * 70)
    print()
    
    all_passed = True
    
    checks = [
        ("Workflow File Exists", validate_workflow_file_exists),
        ("Workflow Structure", validate_workflow_structure),
        ("Python Versions", validate_python_versions),
        ("Test Services", validate_test_services),
        ("Test Steps", validate_test_steps),
        ("Coverage Steps", validate_coverage_steps),
        ("Artifact Uploads", validate_artifact_uploads),
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
