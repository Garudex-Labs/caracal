#!/usr/bin/env python3
"""Verify that native implementations can be imported and no ASE imports exist."""

import os
import sys
from pathlib import Path

def test_native_imports():
    """Test that native implementations can be imported."""
    print("Testing native imports...")
    
    try:
        from caracal.core.metering import MeteringEvent
        print("  ✓ MeteringEvent imported from caracal.core.metering")
        
        from caracal.core.identity import AgentIdentity, VerificationStatus
        print("  ✓ AgentIdentity imported from caracal.core.identity")
        print("  ✓ VerificationStatus imported from caracal.core.identity")
        
        from caracal.core.audit import AuditReference
        print("  ✓ AuditReference imported from caracal.core.audit")
        
        from caracal.core.metering import MeteringCollector
        print("  ✓ MeteringCollector imported from caracal.core.metering")
        
        return True
    except ImportError as e:
        print(f"  ✗ Import failed: {e}")
        return False

def check_ase_imports():
    """Check that no ASE imports exist in the codebase."""
    print("\nChecking for ASE imports...")
    
    caracal_dir = Path(__file__).parent / "caracal"
    tests_dir = Path(__file__).parent / "tests"
    
    files_with_ase = []
    
    for directory in [caracal_dir, tests_dir]:
        if not directory.exists():
            continue
            
        for root, dirs, files in os.walk(directory):
            # Skip virtual environments and cache directories
            dirs[:] = [d for d in dirs if d not in ['.venv', '__pycache__', '.pytest_cache', 'node_modules', '.git']]
            
            for file in files:
                if file.endswith('.py'):
                    file_path = Path(root) / file
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                            lines = content.split('\n')
                            
                            for line_num, line in enumerate(lines, 1):
                                stripped = line.strip()
                                # Skip comments
                                if stripped.startswith('#'):
                                    continue
                                
                                if 'from ase.' in line or (line.startswith('import ase') and not 'import ase' in line[11:]):
                                    files_with_ase.append({
                                        'file': str(file_path.relative_to(Path(__file__).parent)),
                                        'line': line_num,
                                        'content': line.strip()
                                    })
                    except Exception:
                        continue
    
    if files_with_ase:
        print("  ✗ Found ASE imports:")
        for item in files_with_ase:
            print(f"    {item['file']}:{item['line']} - {item['content']}")
        return False
    else:
        print("  ✓ No ASE imports found in codebase")
        return True

def check_ase_directory():
    """Check that ASE directory doesn't exist."""
    print("\nChecking for ASE directory...")
    
    workspace_root = Path(__file__).parent.parent
    ase_dir = workspace_root / "ase"
    
    if ase_dir.exists():
        print(f"  ✗ ASE directory still exists at {ase_dir}")
        return False
    else:
        print("  ✓ ASE directory does not exist")
        return True

def check_pyproject_toml():
    """Check that pyproject.toml files don't reference ase-protocol."""
    print("\nChecking pyproject.toml files...")
    
    workspace_root = Path(__file__).parent.parent
    
    files_to_check = [
        workspace_root / "Caracal" / "pyproject.toml",
        workspace_root / "caracalEnterprise" / "services" / "enterprise-api" / "pyproject.toml"
    ]
    
    all_clean = True
    
    for file_path in files_to_check:
        if file_path.exists():
            with open(file_path, 'r') as f:
                content = f.read()
                if 'ase-protocol' in content:
                    print(f"  ✗ Found 'ase-protocol' in {file_path.relative_to(workspace_root)}")
                    all_clean = False
                else:
                    print(f"  ✓ No 'ase-protocol' in {file_path.relative_to(workspace_root)}")
    
    return all_clean

if __name__ == "__main__":
    print("=" * 60)
    print("Native Implementation Verification")
    print("=" * 60)
    
    results = []
    
    results.append(("Native Imports", test_native_imports()))
    results.append(("No ASE Imports", check_ase_imports()))
    results.append(("No ASE Directory", check_ase_directory()))
    results.append(("No ASE in pyproject.toml", check_pyproject_toml()))
    
    print("\n" + "=" * 60)
    print("Summary")
    print("=" * 60)
    
    all_passed = True
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status}: {name}")
        if not passed:
            all_passed = False
    
    print("=" * 60)
    
    if all_passed:
        print("\n✅ All verification checks passed!")
        sys.exit(0)
    else:
        print("\n❌ Some verification checks failed!")
        sys.exit(1)
