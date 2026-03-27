"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup script for Caracal Core.

This file exists for compatibility with older build tools.
The primary build configuration is in pyproject.toml.
"""

import shutil
from pathlib import Path
from setuptools import setup

# Read version from VERSION file
version_file = Path(__file__).parent / "VERSION"
version = version_file.read_text().strip()

# Guard against stale checked-in build artifacts being reused by setuptools.
build_lib_dir = Path(__file__).parent / "build" / "lib"
if build_lib_dir.exists():
    shutil.rmtree(build_lib_dir)

# Guard against stale local metadata overriding current pyproject script entrypoints.
for egg_info_dir in Path(__file__).parent.glob("*.egg-info"):
    if egg_info_dir.is_dir():
        shutil.rmtree(egg_info_dir)

setup(version=version)
