#!/usr/bin/env python3
"""
Test script to verify Caracal Core installation and CLI functionality.
"""
import subprocess
import sys

def test_import():
    """Test that caracal can be imported."""
    print("Testing package import...")
    try:
        import caracal
        print(f"✓ Package imported successfully")
        print(f"  Version: {caracal.__version__}")
        return True
    except ImportError as e:
        print(f"✗ Failed to import package: {e}")
        return False

def test_cli_version():
    """Test that CLI version command works."""
    print("\nTesting CLI version command...")
    try:
        result = subprocess.run(
            ['caracal', '--version'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            print(f"✓ CLI version command works")
            print(f"  Output: {result.stdout.strip()}")
            return True
        else:
            print(f"✗ CLI version command failed with exit code {result.returncode}")
            return False
    except Exception as e:
        print(f"✗ Failed to run CLI: {e}")
        return False

def test_cli_help():
    """Test that CLI help command works."""
    print("\nTesting CLI help command...")
    try:
        result = subprocess.run(
            ['caracal', '--help'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0 and 'Economic control plane' in result.stdout:
            print(f"✓ CLI help command works")
            return True
        else:
            print(f"✗ CLI help command failed")
            return False
    except Exception as e:
        print(f"✗ Failed to run CLI help: {e}")
        return False

def test_cli_commands():
    """Test that CLI subcommands are available."""
    print("\nTesting CLI subcommands...")
    commands = ['agent', 'policy', 'ledger', 'pricebook']
    all_passed = True
    
    for cmd in commands:
        try:
            result = subprocess.run(
                ['caracal', cmd, '--help'],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                print(f"✓ Command 'caracal {cmd}' is available")
            else:
                print(f"✗ Command 'caracal {cmd}' failed")
                all_passed = False
        except Exception as e:
            print(f"✗ Failed to test command '{cmd}': {e}")
            all_passed = False
    
    return all_passed

def main():
    """Run all tests."""
    print("=" * 60)
    print("Caracal Core Installation Verification")
    print("=" * 60)
    
    tests = [
        test_import,
        test_cli_version,
        test_cli_help,
        test_cli_commands,
    ]
    
    results = [test() for test in tests]
    
    print("\n" + "=" * 60)
    print(f"Results: {sum(results)}/{len(results)} tests passed")
    print("=" * 60)
    
    return all(results)

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
