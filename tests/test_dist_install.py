#!/usr/bin/env python3
"""
Test installation from distribution artifacts.
"""
import subprocess
import sys
import os
import tempfile
import shutil
from pathlib import Path

LOG_FILE = "dist_install_test.log"

def log(message):
    """Write message to log file."""
    with open(LOG_FILE, 'a') as f:
        f.write(message + '\n')
    print(message, flush=True)

def run_command(cmd, description, cwd=None):
    """Run a command and log results."""
    log(f"\n{'='*60}")
    log(f"{description}")
    log(f"Command: {' '.join(cmd)}")
    if cwd:
        log(f"Working directory: {cwd}")
    log(f"{'='*60}")
    
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=cwd
    )
    
    log(f"Exit code: {result.returncode}")
    if result.stdout:
        log(f"STDOUT:\n{result.stdout[:1000]}")
    if result.stderr:
        log(f"STDERR:\n{result.stderr[:1000]}")
    
    return result.returncode == 0

def test_wheel_install():
    """Test installation from wheel."""
    log("\n" + "="*60)
    log("TEST 1: Install from wheel")
    log("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        venv_path = Path(tmpdir) / "test_venv"
        
        # Create virtual environment
        if not run_command(
            [sys.executable, '-m', 'venv', str(venv_path)],
            "Creating virtual environment"
        ):
            return False
        
        # Get paths
        if os.name == 'nt':
            python_exe = venv_path / 'Scripts' / 'python.exe'
            caracal_exe = venv_path / 'Scripts' / 'caracal.exe'
        else:
            python_exe = venv_path / 'bin' / 'python'
            caracal_exe = venv_path / 'bin' / 'caracal'
        
        # Install from wheel
        wheel_path = Path('dist/caracal_core-0.2.0-py3-none-any.whl').absolute()
        if not run_command(
            [str(python_exe), '-m', 'pip', 'install', str(wheel_path)],
            "Installing from wheel"
        ):
            return False
        
        # Test import
        if not run_command(
            [str(python_exe), '-c', 'import caracal; print(f"Version: {caracal.__version__}")'],
            "Testing package import"
        ):
            return False
        
        # Test CLI
        if not run_command(
            [str(caracal_exe), '--version'],
            "Testing CLI version command"
        ):
            return False
        
        if not run_command(
            [str(caracal_exe), '--help'],
            "Testing CLI help command"
        ):
            return False
        
        log("\n✓ Wheel installation test PASSED")
        return True

def test_sdist_install():
    """Test installation from source distribution."""
    log("\n" + "="*60)
    log("TEST 2: Install from source distribution")
    log("="*60)
    
    with tempfile.TemporaryDirectory() as tmpdir:
        venv_path = Path(tmpdir) / "test_venv"
        
        # Create virtual environment
        if not run_command(
            [sys.executable, '-m', 'venv', str(venv_path)],
            "Creating virtual environment"
        ):
            return False
        
        # Get paths
        if os.name == 'nt':
            python_exe = venv_path / 'Scripts' / 'python.exe'
            caracal_exe = venv_path / 'Scripts' / 'caracal.exe'
        else:
            python_exe = venv_path / 'bin' / 'python'
            caracal_exe = venv_path / 'bin' / 'caracal'
        
        # Install from sdist
        sdist_path = Path('dist/caracal_core-0.2.0.tar.gz').absolute()
        if not run_command(
            [str(python_exe), '-m', 'pip', 'install', str(sdist_path)],
            "Installing from source distribution"
        ):
            return False
        
        # Test import
        if not run_command(
            [str(python_exe), '-c', 'import caracal; print(f"Version: {caracal.__version__}")'],
            "Testing package import"
        ):
            return False
        
        # Test CLI
        if not run_command(
            [str(caracal_exe), '--version'],
            "Testing CLI version command"
        ):
            return False
        
        log("\n✓ Source distribution installation test PASSED")
        return True

def main():
    """Run all tests."""
    # Clear log file
    if os.path.exists(LOG_FILE):
        os.remove(LOG_FILE)
    
    log("Caracal Core Distribution Installation Tests")
    log(f"Python: {sys.version}")
    log(f"Working directory: {os.getcwd()}")
    
    tests = [
        ("Wheel Installation", test_wheel_install),
        ("Source Distribution Installation", test_sdist_install),
    ]
    
    results = []
    for name, test_func in tests:
        try:
            result = test_func()
            results.append((name, result))
        except Exception as e:
            log(f"\n✗ {name} FAILED with exception: {e}")
            import traceback
            log(traceback.format_exc())
            results.append((name, False))
    
    # Summary
    log("\n" + "="*60)
    log("TEST SUMMARY")
    log("="*60)
    for name, result in results:
        status = "✓ PASSED" if result else "✗ FAILED"
        log(f"{name}: {status}")
    
    passed = sum(1 for _, result in results if result)
    total = len(results)
    log(f"\nTotal: {passed}/{total} tests passed")
    log("="*60)
    
    return all(result for _, result in results)

if __name__ == '__main__':
    try:
        success = main()
        sys.exit(0 if success else 1)
    except Exception as e:
        log(f"\nFATAL ERROR: {e}")
        import traceback
        log(traceback.format_exc())
        sys.exit(1)
