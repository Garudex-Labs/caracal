"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Version compatibility checking for Caracal deployment architecture.

This module provides semantic version parsing and compatibility checking
between local and enterprise instances.
"""

import re
from dataclasses import dataclass
from enum import Enum
from typing import Optional

from caracal._version import __version__
from caracal.deployment.exceptions import VersionParseError, VersionIncompatibleError


class CompatibilityLevel(Enum):
    """Version compatibility levels."""
    COMPATIBLE = "compatible"  # Patch version difference - allow
    WARNING = "warning"  # Minor version difference - warn
    INCOMPATIBLE = "incompatible"  # Major version difference - block


@dataclass
class SemanticVersion:
    """Semantic version representation (major.minor.patch)."""
    major: int
    minor: int
    patch: int
    prerelease: Optional[str] = None
    build: Optional[str] = None
    
    def __str__(self) -> str:
        """String representation of version."""
        version = f"{self.major}.{self.minor}.{self.patch}"
        if self.prerelease:
            version += f"-{self.prerelease}"
        if self.build:
            version += f"+{self.build}"
        return version
    
    def __eq__(self, other) -> bool:
        """Check if versions are equal (ignoring build metadata)."""
        if not isinstance(other, SemanticVersion):
            return False
        return (
            self.major == other.major
            and self.minor == other.minor
            and self.patch == other.patch
            and self.prerelease == other.prerelease
        )
    
    def __lt__(self, other) -> bool:
        """Check if this version is less than another."""
        if not isinstance(other, SemanticVersion):
            return NotImplemented
        
        # Compare major, minor, patch
        if self.major != other.major:
            return self.major < other.major
        if self.minor != other.minor:
            return self.minor < other.minor
        if self.patch != other.patch:
            return self.patch < other.patch
        
        # Handle prerelease versions
        # Version without prerelease is greater than with prerelease
        if self.prerelease is None and other.prerelease is not None:
            return False
        if self.prerelease is not None and other.prerelease is None:
            return True
        if self.prerelease is not None and other.prerelease is not None:
            return self.prerelease < other.prerelease
        
        return False
    
    def __le__(self, other) -> bool:
        """Check if this version is less than or equal to another."""
        return self == other or self < other
    
    def __gt__(self, other) -> bool:
        """Check if this version is greater than another."""
        return not self <= other
    
    def __ge__(self, other) -> bool:
        """Check if this version is greater than or equal to another."""
        return not self < other


@dataclass
class VersionCompatibility:
    """Result of version compatibility check."""
    local_version: SemanticVersion
    remote_version: SemanticVersion
    compatibility_level: CompatibilityLevel
    message: str
    upgrade_instructions: Optional[str] = None


class VersionChecker:
    """Version compatibility checker for Caracal."""
    
    # Semantic version regex pattern
    # Matches: major.minor.patch[-prerelease][+build]
    VERSION_PATTERN = re.compile(
        r'^(?P<major>0|[1-9]\d*)\.(?P<minor>0|[1-9]\d*)\.(?P<patch>0|[1-9]\d*)'
        r'(?:-(?P<prerelease>(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)'
        r'(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?'
        r'(?:\+(?P<build>[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$'
    )
    
    def __init__(self):
        """Initialize version checker with local version."""
        self._local_version = self.parse_version(__version__)
    
    @classmethod
    def parse_version(cls, version_string: str) -> SemanticVersion:
        """
        Parse a semantic version string.
        
        Args:
            version_string: Version string to parse (e.g., "1.2.3", "1.2.3-beta.1")
        
        Returns:
            SemanticVersion object
        
        Raises:
            VersionParseError: If version string is invalid
        """
        if not version_string or not isinstance(version_string, str):
            raise VersionParseError(f"Invalid version string: {version_string}")
        
        # Strip whitespace
        version_string = version_string.strip()
        
        # Match against semantic version pattern
        match = cls.VERSION_PATTERN.match(version_string)
        if not match:
            raise VersionParseError(
                f"Invalid semantic version format: {version_string}. "
                f"Expected format: major.minor.patch[-prerelease][+build]"
            )
        
        try:
            return SemanticVersion(
                major=int(match.group('major')),
                minor=int(match.group('minor')),
                patch=int(match.group('patch')),
                prerelease=match.group('prerelease'),
                build=match.group('build')
            )
        except (ValueError, AttributeError) as e:
            raise VersionParseError(f"Failed to parse version {version_string}: {e}")
    
    def get_local_version(self) -> SemanticVersion:
        """
        Get the local Caracal version.
        
        Returns:
            Local semantic version
        """
        return self._local_version
    
    def check_compatibility(
        self,
        remote_version_string: str
    ) -> VersionCompatibility:
        """
        Check compatibility between local and remote versions.
        
        Compatibility rules:
        - Patch version differences: COMPATIBLE (allow)
        - Minor version differences: WARNING (warn but allow)
        - Major version differences: INCOMPATIBLE (block)
        
        Args:
            remote_version_string: Remote version string to check
        
        Returns:
            VersionCompatibility result
        
        Raises:
            VersionParseError: If remote version string is invalid
        """
        remote_version = self.parse_version(remote_version_string)
        
        # Check major version compatibility
        if self._local_version.major != remote_version.major:
            return VersionCompatibility(
                local_version=self._local_version,
                remote_version=remote_version,
                compatibility_level=CompatibilityLevel.INCOMPATIBLE,
                message=(
                    f"Major version mismatch: local {self._local_version} vs "
                    f"remote {remote_version}. Synchronization is blocked."
                ),
                upgrade_instructions=self._get_upgrade_instructions(
                    self._local_version,
                    remote_version
                )
            )
        
        # Check minor version compatibility
        if self._local_version.minor != remote_version.minor:
            return VersionCompatibility(
                local_version=self._local_version,
                remote_version=remote_version,
                compatibility_level=CompatibilityLevel.WARNING,
                message=(
                    f"Minor version mismatch: local {self._local_version} vs "
                    f"remote {remote_version}. Synchronization may have issues."
                ),
                upgrade_instructions=self._get_upgrade_instructions(
                    self._local_version,
                    remote_version
                )
            )
        
        # Patch version differences are compatible
        if self._local_version.patch != remote_version.patch:
            return VersionCompatibility(
                local_version=self._local_version,
                remote_version=remote_version,
                compatibility_level=CompatibilityLevel.COMPATIBLE,
                message=(
                    f"Patch version difference: local {self._local_version} vs "
                    f"remote {remote_version}. Synchronization is safe."
                )
            )
        
        # Exact version match
        return VersionCompatibility(
            local_version=self._local_version,
            remote_version=remote_version,
            compatibility_level=CompatibilityLevel.COMPATIBLE,
            message=f"Versions match: {self._local_version}"
        )
    
    def _get_upgrade_instructions(
        self,
        local: SemanticVersion,
        remote: SemanticVersion
    ) -> str:
        """
        Generate upgrade instructions based on version comparison.
        
        Args:
            local: Local version
            remote: Remote version
        
        Returns:
            Upgrade instructions string
        """
        if local < remote:
            return (
                f"Your local version ({local}) is older than the remote version ({remote}). "
                f"Please upgrade your local installation:\n"
                f"  pip install --upgrade caracal"
            )
        elif local > remote:
            return (
                f"Your local version ({local}) is newer than the remote version ({remote}). "
                f"Please ask your administrator to upgrade the enterprise instance."
            )
        else:
            return "Versions are compatible."
    
    def assert_compatible(self, remote_version_string: str) -> None:
        """
        Assert that versions are compatible, raising exception if not.
        
        Args:
            remote_version_string: Remote version string to check
        
        Raises:
            VersionIncompatibleError: If versions are incompatible
            VersionParseError: If remote version string is invalid
        """
        compatibility = self.check_compatibility(remote_version_string)
        
        if compatibility.compatibility_level == CompatibilityLevel.INCOMPATIBLE:
            raise VersionIncompatibleError(
                f"{compatibility.message}\n\n{compatibility.upgrade_instructions}"
            )
    
    def format_version_status(
        self,
        remote_version_string: Optional[str] = None
    ) -> str:
        """
        Format version status for display in status commands.
        
        Args:
            remote_version_string: Optional remote version string
        
        Returns:
            Formatted version status string
        """
        lines = [f"Local Version:  {self._local_version}"]
        
        if remote_version_string:
            try:
                remote_version = self.parse_version(remote_version_string)
                compatibility = self.check_compatibility(remote_version_string)
                
                lines.append(f"Remote Version: {remote_version}")
                lines.append(f"Compatibility:  {compatibility.compatibility_level.value}")
                
                if compatibility.compatibility_level != CompatibilityLevel.COMPATIBLE:
                    lines.append(f"\n{compatibility.message}")
                    if compatibility.upgrade_instructions:
                        lines.append(f"\n{compatibility.upgrade_instructions}")
            except VersionParseError as e:
                lines.append(f"Remote Version: {remote_version_string} (invalid)")
                lines.append(f"Error: {e}")
        else:
            lines.append("Remote Version: Not connected")
        
        return "\n".join(lines)


# Global version checker instance
_version_checker: Optional[VersionChecker] = None


def get_version_checker() -> VersionChecker:
    """
    Get the global version checker instance.
    
    Returns:
        VersionChecker instance
    """
    global _version_checker
    if _version_checker is None:
        _version_checker = VersionChecker()
    return _version_checker
