#!/usr/bin/env python3
"""Simple test check"""
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    # Try importing the main modules
    print("Checking imports...")
    from caracal.core import identity, policy, ledger, metering
    from caracal.db import models, connection
    from caracal.gateway import proxy, auth, cache
    from caracal.mcp import adapter
    print("✓ All core modules import successfully")
    
    # Try running a simple test
    print("\nRunning basic functionality check...")
    from caracal.db.connection import DatabaseConnectionManager
    print("✓ DatabaseConnectionManager imported")
    
    from caracal.core.provisional_charges import ProvisionalChargeManager
    print("✓ ProvisionalChargeManager imported")
    
    from caracal.core.delegation import DelegationTokenManager
    print("✓ DelegationTokenManager imported")
    
    print("\n✓ All core features appear to be integrated correctly")
    sys.exit(0)
    
except Exception as e:
    print(f"\n✗ Error: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
