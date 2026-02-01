#!/usr/bin/env python3
"""
Verification script to check that the package structure is correct.
"""

import sys
from pathlib import Path

# Add the package to the path
sys.path.insert(0, str(Path(__file__).parent))

def verify_imports():
    """Verify that all modules can be imported."""
    print("Verifying package structure...")
    
    try:
        import caracal
        print(f"✓ caracal imported successfully (version {caracal.__version__})")
    except ImportError as e:
        print(f"✗ Failed to import caracal: {e}")
        return False
    
    try:
        from caracal import exceptions
        print("✓ caracal.exceptions imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.exceptions: {e}")
        return False
    
    try:
        from caracal import logging_config
        print("✓ caracal.logging_config imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.logging_config: {e}")
        return False
    
    try:
        from caracal import core
        print("✓ caracal.core imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.core: {e}")
        return False
    
    try:
        from caracal import sdk
        print("✓ caracal.sdk imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.sdk: {e}")
        return False
    
    try:
        from caracal import cli
        print("✓ caracal.cli imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.cli: {e}")
        return False
    
    try:
        from caracal import config
        print("✓ caracal.config imported successfully")
    except ImportError as e:
        print(f"✗ Failed to import caracal.config: {e}")
        return False
    
    print("\n✓ All imports successful!")
    return True


def verify_exceptions():
    """Verify that exception hierarchy is correct."""
    print("\nVerifying exception hierarchy...")
    
    from caracal.exceptions import (
        CaracalError,
        IdentityError,
        PolicyError,
        LedgerError,
        MeteringError,
        PricebookError,
        ConfigurationError,
        StorageError,
        SDKError,
    )
    
    # Test inheritance
    assert issubclass(IdentityError, CaracalError)
    assert issubclass(PolicyError, CaracalError)
    assert issubclass(LedgerError, CaracalError)
    assert issubclass(MeteringError, CaracalError)
    assert issubclass(PricebookError, CaracalError)
    assert issubclass(ConfigurationError, CaracalError)
    assert issubclass(StorageError, CaracalError)
    assert issubclass(SDKError, CaracalError)
    
    print("✓ Exception hierarchy verified!")
    return True


def verify_logging():
    """Verify that logging configuration works."""
    print("\nVerifying logging configuration...")
    
    from caracal.logging_config import setup_logging, get_logger
    
    setup_logging(level="INFO")
    logger = get_logger("test")
    
    assert logger.name == "caracal.test"
    
    print("✓ Logging configuration verified!")
    return True


def main():
    """Run all verification checks."""
    print("=" * 60)
    print("Caracal Core Package Structure Verification")
    print("=" * 60)
    
    checks = [
        verify_imports,
        verify_exceptions,
        verify_logging,
    ]
    
    results = []
    for check in checks:
        try:
            result = check()
            results.append(result)
        except Exception as e:
            print(f"✗ Check failed with error: {e}")
            results.append(False)
    
    print("\n" + "=" * 60)
    if all(results):
        print("✓ All verification checks passed!")
        print("=" * 60)
        return 0
    else:
        print("✗ Some verification checks failed!")
        print("=" * 60)
        return 1


if __name__ == "__main__":
    sys.exit(main())
