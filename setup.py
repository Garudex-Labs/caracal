"""
Setup script for Caracal Core.

This file exists for compatibility with older build tools.
The primary build configuration is in pyproject.toml.
"""

from pathlib import Path
from setuptools import setup

# Read version from VERSION file
version_file = Path(__file__).parent / "VERSION"
version = version_file.read_text().strip()

setup(version=version)
