#!/usr/bin/env python3
"""
Check distribution files before uploading to PyPI.
"""
import subprocess
import sys
from pathlib import Path

def main():
    print("=" * 60)
    print("Caracal Core - PyPI Upload Pre-Check")
    print("=" * 60)
    
    # Check dist directory
    dist_dir = Path('dist')
    if not dist_dir.exists():
        print("ERROR: dist/ directory not found!")
        return False
    
    # List files
    files = list(dist_dir.glob('*'))
    if not files:
        print("ERROR: No files in dist/ directory!")
        return False
    
    print("\nDistribution files to upload:")
    for f in files:
        size = f.stat().st_size
        print(f"  - {f.name} ({size:,} bytes)")
    
    # Run twine check
    print("\nRunning twine check...")
    result = subprocess.run(
        ['twine', 'check', 'dist/*'],
        capture_output=True,
        text=True
    )
    
    print(result.stdout)
    if result.stderr:
        print("STDERR:", result.stderr)
    
    if result.returncode == 0:
        print("✓ All checks passed!")
        print("\n" + "=" * 60)
        print("Ready to upload to PyPI")
        print("=" * 60)
        print("\nTo upload to TestPyPI (recommended first):")
        print("  twine upload --repository testpypi dist/*")
        print("\nTo upload to PyPI:")
        print("  twine upload dist/*")
        print("\nNote: You'll need PyPI credentials (username/password or API token)")
        return True
    else:
        print("✗ Checks failed!")
        return False

if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
