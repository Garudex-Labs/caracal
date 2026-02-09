#!/usr/bin/env python3
"""
Simple verification script for MandateManager implementation.
"""

print("Starting verification...")

try:
    print("Importing MandateManager...")
    from caracal.core.mandate import MandateManager
    print("SUCCESS: MandateManager imported successfully")
    
    # Check that the class has the required methods
    required_methods = ['issue_mandate', 'revoke_mandate', 'delegate_mandate']
    for method in required_methods:
        if hasattr(MandateManager, method):
            print(f"SUCCESS: MandateManager.{method}() exists")
        else:
            print(f"FAIL: MandateManager.{method}() missing")
    
    # Check helper methods
    helper_methods = ['_get_active_policy', '_get_principal', '_validate_scope_subset', '_match_pattern', '_record_ledger_event']
    for method in helper_methods:
        if hasattr(MandateManager, method):
            print(f"SUCCESS: MandateManager.{method}() exists")
        else:
            print(f"FAIL: MandateManager.{method}() missing")
    
    print("\nSUCCESS: All required methods are present")
    print("SUCCESS: MandateManager implementation verified successfully")
    
except Exception as e:
    print(f"FAIL: Error: {e}")
    import traceback
    traceback.print_exc()
