#!/usr/bin/env python3
"""
Create distribution artifacts for Caracal Core.
Writes detailed logs to distribution_build.log
"""
import subprocess
import sys
import os
import shutil
from pathlib import Path

LOG_FILE = "distribution_build.log"

def log(message):
    """Write message to both console and log file."""
    with open(LOG_FILE, 'a') as f:
        f.write(message + '\n')
    print(message, flush=True)

def run_command(cmd, description):
    """Run a command and log the results."""
    log(f"\n{'='*60}")
    log(f"{description}")
    log(f"Command: {' '.join(cmd)}")
    log(f"{'='*60}")
    
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )
    
    log(f"Exit code: {result.returncode}")
    if result.stdout:
        log(f"STDOUT:\n{result.stdout}")
    if result.stderr:
        log(f"STDERR:\n{result.stderr}")
    
    return result.returncode == 0

def main():
    """Build distribution artifacts."""
    # Clear log file
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)
    
    log("Caracal Core Distribution Build")
    log(f"Python: {sys.version}")
    log(f"Working directory: {os.getcwd()}")
    
    # Clean previous builds
    log("\n1. Cleaning previous builds...")
    for dir_name in ['build', 'dist', 'caracal_core.egg-info']:
        if os.path.exists(dir_name):
            log(f"   Removing {dir_name}/")
            shutil.rmtree(dir_name)
    
    # Create dist directory
    os.makedirs('dist', exist_ok=True)
    
    # Build wheel
    success = run_command(
        [sys.executable, 'setup.py', 'bdist_wheel'],
        "2. Building wheel distribution"
    )
    
    if not success:
        log("ERROR: Wheel build failed!")
        return False
    
    # Build source distribution
    success = run_command(
        [sys.executable, 'setup.py', 'sdist'],
        "3. Building source distribution"
    )
    
    if not success:
        log("ERROR: Source distribution build failed!")
        return False
    
    # List created files
    log("\n4. Distribution artifacts:")
    if os.path.exists('dist'):
        files = list(Path('dist').glob('*'))
        if files:
            for filepath in files:
                size = filepath.stat().st_size
                log(f"   ✓ {filepath.name} ({size:,} bytes)")
        else:
            log("   ERROR: No files in dist/ directory!")
            return False
    else:
        log("   ERROR: dist/ directory not found!")
        return False
    
    log("\n" + "="*60)
    log("BUILD SUCCESSFUL!")
    log("="*60)
    return True

if __name__ == '__main__':
    try:
        success = main()
        sys.exit(0 if success else 1)
    except Exception as e:
        log(f"\nFATAL ERROR: {e}")
        import traceback
        log(traceback.format_exc())
        sys.exit(1)
