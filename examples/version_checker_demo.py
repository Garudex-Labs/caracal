"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Demo script for version compatibility checker.

This script demonstrates how to use the version compatibility checker
to validate version compatibility between local and remote instances.
"""

from caracal.deployment.version import (
    VersionChecker,
    get_version_checker,
    CompatibilityLevel,
)
from caracal.deployment.exceptions import VersionIncompatibleError, VersionParseError


def demo_version_parsing():
    """Demonstrate version parsing."""
    print("=" * 60)
    print("Version Parsing Demo")
    print("=" * 60)
    
    test_versions = [
        "1.2.3",
        "0.1.0",
        "2.0.0-beta.1",
        "1.5.3+20240115",
        "3.2.1-rc.1+build.123",
    ]
    
    for version_str in test_versions:
        try:
            version = VersionChecker.parse_version(version_str)
            print(f"✓ Parsed: {version_str} -> {version}")
        except VersionParseError as e:
            print(f"✗ Failed to parse {version_str}: {e}")
    
    print()


def demo_version_comparison():
    """Demonstrate version comparison."""
    print("=" * 60)
    print("Version Comparison Demo")
    print("=" * 60)
    
    comparisons = [
        ("1.2.3", "1.2.4", "patch difference"),
        ("1.2.3", "1.3.0", "minor difference"),
        ("1.2.3", "2.0.0", "major difference"),
        ("1.2.3", "1.2.3", "exact match"),
    ]
    
    for v1_str, v2_str, description in comparisons:
        v1 = VersionChecker.parse_version(v1_str)
        v2 = VersionChecker.parse_version(v2_str)
        
        if v1 < v2:
            comparison = "<"
        elif v1 > v2:
            comparison = ">"
        else:
            comparison = "=="
        
        print(f"{v1} {comparison} {v2} ({description})")
    
    print()


def demo_compatibility_checking():
    """Demonstrate compatibility checking."""
    print("=" * 60)
    print("Compatibility Checking Demo")
    print("=" * 60)
    
    checker = get_version_checker()
    local_version = checker.get_local_version()
    
    print(f"Local version: {local_version}")
    print()
    
    # Test different remote versions
    test_cases = [
        (str(local_version), "Exact match"),
        (f"{local_version.major}.{local_version.minor}.{local_version.patch + 1}", "Patch difference"),
        (f"{local_version.major}.{local_version.minor + 1}.0", "Minor difference"),
        (f"{local_version.major + 1}.0.0", "Major difference"),
    ]
    
    for remote_version, description in test_cases:
        print(f"Testing: {description} (remote: {remote_version})")
        
        try:
            compatibility = checker.check_compatibility(remote_version)
            
            print(f"  Level: {compatibility.compatibility_level.value}")
            print(f"  Message: {compatibility.message}")
            
            if compatibility.upgrade_instructions:
                print(f"  Instructions: {compatibility.upgrade_instructions}")
            
        except VersionParseError as e:
            print(f"  Error: {e}")
        
        print()


def demo_assert_compatible():
    """Demonstrate assert_compatible method."""
    print("=" * 60)
    print("Assert Compatible Demo")
    print("=" * 60)
    
    checker = get_version_checker()
    local_version = checker.get_local_version()
    
    # Test compatible version
    print(f"Testing compatible version: {local_version}")
    try:
        checker.assert_compatible(str(local_version))
        print("✓ Version is compatible")
    except VersionIncompatibleError as e:
        print(f"✗ Version is incompatible: {e}")
    
    print()
    
    # Test incompatible version
    incompatible_version = f"{local_version.major + 1}.0.0"
    print(f"Testing incompatible version: {incompatible_version}")
    try:
        checker.assert_compatible(incompatible_version)
        print("✓ Version is compatible")
    except VersionIncompatibleError as e:
        print(f"✗ Version is incompatible: {e}")
    
    print()


def demo_version_status_formatting():
    """Demonstrate version status formatting."""
    print("=" * 60)
    print("Version Status Formatting Demo")
    print("=" * 60)
    
    checker = get_version_checker()
    local_version = checker.get_local_version()
    
    # Status without remote version
    print("Status without remote connection:")
    print(checker.format_version_status())
    print()
    
    # Status with compatible remote version
    print("Status with compatible remote version:")
    print(checker.format_version_status(str(local_version)))
    print()
    
    # Status with incompatible remote version
    incompatible_version = f"{local_version.major + 1}.0.0"
    print("Status with incompatible remote version:")
    print(checker.format_version_status(incompatible_version))
    print()


def main():
    """Run all demos."""
    print("\n")
    print("╔" + "=" * 58 + "╗")
    print("║" + " " * 10 + "Caracal Version Checker Demo" + " " * 20 + "║")
    print("╚" + "=" * 58 + "╝")
    print()
    
    demo_version_parsing()
    demo_version_comparison()
    demo_compatibility_checking()
    demo_assert_compatible()
    demo_version_status_formatting()
    
    print("=" * 60)
    print("Demo completed!")
    print("=" * 60)


if __name__ == "__main__":
    main()
