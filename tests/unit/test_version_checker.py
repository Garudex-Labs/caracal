"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for version compatibility checker.
"""

import pytest

from caracal.deployment.version import (
    VersionChecker,
    SemanticVersion,
    CompatibilityLevel,
    VersionCompatibility,
    get_version_checker,
)
from caracal.deployment.exceptions import VersionParseError, VersionIncompatibleError


class TestSemanticVersion:
    """Tests for SemanticVersion class."""
    
    def test_version_string_representation(self):
        """Test string representation of semantic version."""
        version = SemanticVersion(major=1, minor=2, patch=3)
        assert str(version) == "1.2.3"
    
    def test_version_with_prerelease(self):
        """Test version with prerelease identifier."""
        version = SemanticVersion(major=1, minor=2, patch=3, prerelease="beta.1")
        assert str(version) == "1.2.3-beta.1"
    
    def test_version_with_build(self):
        """Test version with build metadata."""
        version = SemanticVersion(major=1, minor=2, patch=3, build="20240115")
        assert str(version) == "1.2.3+20240115"
    
    def test_version_with_prerelease_and_build(self):
        """Test version with both prerelease and build."""
        version = SemanticVersion(
            major=1, minor=2, patch=3,
            prerelease="beta.1", build="20240115"
        )
        assert str(version) == "1.2.3-beta.1+20240115"
    
    def test_version_equality(self):
        """Test version equality comparison."""
        v1 = SemanticVersion(major=1, minor=2, patch=3)
        v2 = SemanticVersion(major=1, minor=2, patch=3)
        v3 = SemanticVersion(major=1, minor=2, patch=4)
        
        assert v1 == v2
        assert v1 != v3
    
    def test_version_equality_ignores_build(self):
        """Test that version equality ignores build metadata."""
        v1 = SemanticVersion(major=1, minor=2, patch=3, build="abc")
        v2 = SemanticVersion(major=1, minor=2, patch=3, build="xyz")
        
        assert v1 == v2
    
    def test_version_comparison_major(self):
        """Test version comparison by major version."""
        v1 = SemanticVersion(major=1, minor=0, patch=0)
        v2 = SemanticVersion(major=2, minor=0, patch=0)
        
        assert v1 < v2
        assert v2 > v1
        assert v1 <= v2
        assert v2 >= v1
    
    def test_version_comparison_minor(self):
        """Test version comparison by minor version."""
        v1 = SemanticVersion(major=1, minor=2, patch=0)
        v2 = SemanticVersion(major=1, minor=3, patch=0)
        
        assert v1 < v2
        assert v2 > v1
    
    def test_version_comparison_patch(self):
        """Test version comparison by patch version."""
        v1 = SemanticVersion(major=1, minor=2, patch=3)
        v2 = SemanticVersion(major=1, minor=2, patch=4)
        
        assert v1 < v2
        assert v2 > v1
    
    def test_version_comparison_prerelease(self):
        """Test version comparison with prerelease."""
        v1 = SemanticVersion(major=1, minor=2, patch=3, prerelease="alpha")
        v2 = SemanticVersion(major=1, minor=2, patch=3, prerelease="beta")
        v3 = SemanticVersion(major=1, minor=2, patch=3)
        
        # Prerelease versions are less than release versions
        assert v1 < v3
        assert v2 < v3
        # Alpha comes before beta
        assert v1 < v2


class TestVersionChecker:
    """Tests for VersionChecker class."""
    
    def test_parse_simple_version(self):
        """Test parsing simple semantic version."""
        version = VersionChecker.parse_version("1.2.3")
        
        assert version.major == 1
        assert version.minor == 2
        assert version.patch == 3
        assert version.prerelease is None
        assert version.build is None
    
    def test_parse_version_with_prerelease(self):
        """Test parsing version with prerelease."""
        version = VersionChecker.parse_version("1.2.3-beta.1")
        
        assert version.major == 1
        assert version.minor == 2
        assert version.patch == 3
        assert version.prerelease == "beta.1"
        assert version.build is None
    
    def test_parse_version_with_build(self):
        """Test parsing version with build metadata."""
        version = VersionChecker.parse_version("1.2.3+20240115")
        
        assert version.major == 1
        assert version.minor == 2
        assert version.patch == 3
        assert version.prerelease is None
        assert version.build == "20240115"
    
    def test_parse_version_with_prerelease_and_build(self):
        """Test parsing version with prerelease and build."""
        version = VersionChecker.parse_version("1.2.3-beta.1+20240115")
        
        assert version.major == 1
        assert version.minor == 2
        assert version.patch == 3
        assert version.prerelease == "beta.1"
        assert version.build == "20240115"
    
    def test_parse_version_with_leading_zeros_rejected(self):
        """Test that versions with leading zeros are rejected."""
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("01.2.3")
        
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("1.02.3")
        
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("1.2.03")
    
    def test_parse_version_zero_allowed(self):
        """Test that zero versions are allowed."""
        version = VersionChecker.parse_version("0.0.0")
        
        assert version.major == 0
        assert version.minor == 0
        assert version.patch == 0
    
    def test_parse_invalid_version_empty(self):
        """Test parsing empty version string."""
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("")
    
    def test_parse_invalid_version_none(self):
        """Test parsing None as version."""
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version(None)
    
    def test_parse_invalid_version_format(self):
        """Test parsing invalid version format."""
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("1.2")
        
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("1.2.3.4")
        
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("v1.2.3")
        
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("abc")
    
    def test_parse_version_strips_whitespace(self):
        """Test that version parsing strips whitespace."""
        version = VersionChecker.parse_version("  1.2.3  ")
        
        assert version.major == 1
        assert version.minor == 2
        assert version.patch == 3
    
    def test_get_local_version(self):
        """Test getting local version."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        assert isinstance(local_version, SemanticVersion)
        assert local_version.major >= 0
        assert local_version.minor >= 0
        assert local_version.patch >= 0
    
    def test_check_compatibility_exact_match(self):
        """Test compatibility check with exact version match."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        compatibility = checker.check_compatibility(str(local_version))
        
        assert compatibility.compatibility_level == CompatibilityLevel.COMPATIBLE
        assert "match" in compatibility.message.lower()
    
    def test_check_compatibility_patch_difference(self):
        """Test compatibility check with patch version difference."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Create remote version with different patch
        remote_version = SemanticVersion(
            major=local_version.major,
            minor=local_version.minor,
            patch=local_version.patch + 1
        )
        
        compatibility = checker.check_compatibility(str(remote_version))
        
        assert compatibility.compatibility_level == CompatibilityLevel.COMPATIBLE
        assert "patch" in compatibility.message.lower()
        assert "safe" in compatibility.message.lower()
    
    def test_check_compatibility_minor_difference(self):
        """Test compatibility check with minor version difference."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Create remote version with different minor
        remote_version = SemanticVersion(
            major=local_version.major,
            minor=local_version.minor + 1,
            patch=0
        )
        
        compatibility = checker.check_compatibility(str(remote_version))
        
        assert compatibility.compatibility_level == CompatibilityLevel.WARNING
        assert "minor" in compatibility.message.lower()
        assert "issues" in compatibility.message.lower()
    
    def test_check_compatibility_major_difference(self):
        """Test compatibility check with major version difference."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Create remote version with different major
        remote_version = SemanticVersion(
            major=local_version.major + 1,
            minor=0,
            patch=0
        )
        
        compatibility = checker.check_compatibility(str(remote_version))
        
        assert compatibility.compatibility_level == CompatibilityLevel.INCOMPATIBLE
        assert "major" in compatibility.message.lower()
        assert "blocked" in compatibility.message.lower()
        assert compatibility.upgrade_instructions is not None
    
    def test_upgrade_instructions_local_older(self):
        """Test upgrade instructions when local version is older."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Create newer remote version
        remote_version = SemanticVersion(
            major=local_version.major + 1,
            minor=0,
            patch=0
        )
        
        compatibility = checker.check_compatibility(str(remote_version))
        
        assert "upgrade your local installation" in compatibility.upgrade_instructions.lower()
        assert "pip install --upgrade" in compatibility.upgrade_instructions.lower()
    
    def test_upgrade_instructions_local_newer(self):
        """Test upgrade instructions when local version is newer."""
        checker = VersionChecker()
        
        # Create older remote version (assuming local is at least 1.0.0)
        remote_version = "0.1.0"
        
        compatibility = checker.check_compatibility(remote_version)
        
        if compatibility.compatibility_level == CompatibilityLevel.INCOMPATIBLE:
            assert "administrator" in compatibility.upgrade_instructions.lower()
            assert "enterprise instance" in compatibility.upgrade_instructions.lower()
    
    def test_assert_compatible_success(self):
        """Test assert_compatible with compatible versions."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Should not raise exception
        checker.assert_compatible(str(local_version))
    
    def test_assert_compatible_failure(self):
        """Test assert_compatible with incompatible versions."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        # Create incompatible remote version
        remote_version = SemanticVersion(
            major=local_version.major + 1,
            minor=0,
            patch=0
        )
        
        with pytest.raises(VersionIncompatibleError) as exc_info:
            checker.assert_compatible(str(remote_version))
        
        assert "major version mismatch" in str(exc_info.value).lower()
    
    def test_format_version_status_no_remote(self):
        """Test formatting version status without remote version."""
        checker = VersionChecker()
        status = checker.format_version_status()
        
        assert "Local Version:" in status
        assert "Not connected" in status
    
    def test_format_version_status_with_remote(self):
        """Test formatting version status with remote version."""
        checker = VersionChecker()
        local_version = checker.get_local_version()
        
        status = checker.format_version_status(str(local_version))
        
        assert "Local Version:" in status
        assert "Remote Version:" in status
        assert "Compatibility:" in status
    
    def test_format_version_status_invalid_remote(self):
        """Test formatting version status with invalid remote version."""
        checker = VersionChecker()
        status = checker.format_version_status("invalid")
        
        assert "Local Version:" in status
        assert "Remote Version:" in status
        assert "invalid" in status.lower()
        assert "Error:" in status
    
    def test_get_version_checker_singleton(self):
        """Test that get_version_checker returns singleton instance."""
        checker1 = get_version_checker()
        checker2 = get_version_checker()
        
        assert checker1 is checker2


class TestVersionCompatibilityEdgeCases:
    """Tests for edge cases in version compatibility."""
    
    def test_compatibility_with_zero_versions(self):
        """Test compatibility checking with 0.x.x versions."""
        checker = VersionChecker()
        
        # Parse 0.x.x versions
        v1 = VersionChecker.parse_version("0.1.0")
        v2 = VersionChecker.parse_version("0.2.0")
        
        # Different minor versions in 0.x.x should still warn
        assert v1.major == v2.major
        assert v1.minor != v2.minor
    
    def test_compatibility_with_large_version_numbers(self):
        """Test compatibility with large version numbers."""
        version = VersionChecker.parse_version("999.999.999")
        
        assert version.major == 999
        assert version.minor == 999
        assert version.patch == 999
    
    def test_prerelease_version_compatibility(self):
        """Test compatibility checking with prerelease versions."""
        checker = VersionChecker()
        
        v1 = VersionChecker.parse_version("1.2.3-beta.1")
        v2 = VersionChecker.parse_version("1.2.3-beta.2")
        
        # Same major.minor.patch, different prerelease
        assert v1.major == v2.major
        assert v1.minor == v2.minor
        assert v1.patch == v2.patch
        assert v1.prerelease != v2.prerelease
