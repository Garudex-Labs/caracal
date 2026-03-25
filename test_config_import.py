#!/usr/bin/env python3
"""Simple test script to verify ConfigManager import."""

import sys
import traceback

try:
    from caracal.deployment.config_manager import ConfigManager
    print("✓ Import successful")
    
    # Try to create an instance
    manager = ConfigManager()
    print("✓ ConfigManager instance created")
    
    print("\nAll tests passed!")
    sys.exit(0)
    
except Exception as e:
    print(f"✗ Error: {e}")
    traceback.print_exc()
    sys.exit(1)
