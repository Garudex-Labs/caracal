#!/usr/bin/env python3
"""
Script to build distribution artifacts for Caracal Core.
"""
import subprocess
import sys
import os

def main():
    """Build wheel and source distribution."""
    print("Building Caracal Core distribution artifacts...")
    print(f"Python version: {sys.version}")
    print(f"Working directory: {os.getcwd()}")
    
    # Clean previous builds
    print("\n1. Cleaning previous builds...")
    for dir_name in ['build', 'dist', 'caracal_core.egg-info']:
        if os.path.exists(dir_name):
            print(f"   Removing {dir_name}/")
            subprocess.run(['rm', '-rf', dir_name], check=True)
    
    # Build wheel
    print("\n2. Building wheel...")
    result = subprocess.run(
        [sys.executable, 'setup.py', 'bdist_wheel'],
        capture_output=True,
        text=True
    )
    print(f"   Exit code: {result.returncode}")
    if result.stdout:
        print(f"   Output: {result.stdout[:500]}")
    if result.stderr:
        print(f"   Errors: {result.stderr[:500]}")
    
    # Build source distribution
    print("\n3. Building source distribution...")
    result = subprocess.run(
        [sys.executable, 'setup.py', 'sdist'],
        capture_output=True,
        text=True
    )
    print(f"   Exit code: {result.returncode}")
    if result.stdout:
        print(f"   Output: {result.stdout[:500]}")
    if result.stderr:
        print(f"   Errors: {result.stderr[:500]}")
    
    # List created files
    print("\n4. Distribution artifacts created:")
    if os.path.exists('dist'):
        for filename in os.listdir('dist'):
            filepath = os.path.join('dist', filename)
            size = os.path.getsize(filepath)
            print(f"   {filename} ({size:,} bytes)")
    else:
        print("   No dist/ directory found!")
    
    print("\nBuild complete!")

if __name__ == '__main__':
    main()
