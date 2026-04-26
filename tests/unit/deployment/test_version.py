"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SemanticVersion dataclass and VersionChecker parsing.
"""
import pytest

from caracal.deployment.version import (
    CompatibilityLevel,
    SemanticVersion,
    VersionChecker,
    VersionCompatibility,
)


@pytest.mark.unit
class TestSemanticVersion:
    def test_str_basic(self):
        v = SemanticVersion(1, 2, 3)
        assert str(v) == "1.2.3"

    def test_str_with_prerelease(self):
        v = SemanticVersion(1, 0, 0, prerelease="alpha.1")
        assert str(v) == "1.0.0-alpha.1"

    def test_str_with_build(self):
        v = SemanticVersion(1, 0, 0, build="001")
        assert str(v) == "1.0.0+001"

    def test_str_with_prerelease_and_build(self):
        v = SemanticVersion(1, 0, 0, prerelease="beta", build="exp.sha")
        assert str(v) == "1.0.0-beta+exp.sha"

    def test_eq_same_version(self):
        assert SemanticVersion(1, 2, 3) == SemanticVersion(1, 2, 3)

    def test_eq_different_patch(self):
        assert SemanticVersion(1, 2, 3) != SemanticVersion(1, 2, 4)

    def test_eq_ignores_build(self):
        a = SemanticVersion(1, 2, 3, build="abc")
        b = SemanticVersion(1, 2, 3, build="xyz")
        assert a == b

    def test_lt_major(self):
        assert SemanticVersion(1, 0, 0) < SemanticVersion(2, 0, 0)

    def test_lt_minor(self):
        assert SemanticVersion(1, 2, 0) < SemanticVersion(1, 3, 0)

    def test_lt_patch(self):
        assert SemanticVersion(1, 2, 3) < SemanticVersion(1, 2, 4)

    def test_not_lt_equal(self):
        assert not (SemanticVersion(1, 2, 3) < SemanticVersion(1, 2, 3))

    def test_lt_prerelease_less_than_release(self):
        pre = SemanticVersion(1, 0, 0, prerelease="alpha")
        release = SemanticVersion(1, 0, 0)
        assert pre < release

    def test_release_not_lt_prerelease(self):
        pre = SemanticVersion(1, 0, 0, prerelease="alpha")
        release = SemanticVersion(1, 0, 0)
        assert not (release < pre)

    def test_le(self):
        assert SemanticVersion(1, 2, 3) <= SemanticVersion(1, 2, 3)
        assert SemanticVersion(1, 2, 2) <= SemanticVersion(1, 2, 3)

    def test_gt(self):
        assert SemanticVersion(2, 0, 0) > SemanticVersion(1, 9, 9)

    def test_ge(self):
        assert SemanticVersion(1, 2, 3) >= SemanticVersion(1, 2, 3)
        assert SemanticVersion(1, 2, 4) >= SemanticVersion(1, 2, 3)

    def test_eq_non_semantic_version_returns_false(self):
        assert SemanticVersion(1, 2, 3) != "1.2.3"


@pytest.mark.unit
class TestVersionCheckerParseVersion:
    def test_basic_version(self):
        v = VersionChecker.parse_version("1.2.3")
        assert v.major == 1
        assert v.minor == 2
        assert v.patch == 3

    def test_prerelease_version(self):
        v = VersionChecker.parse_version("1.0.0-beta.1")
        assert v.prerelease == "beta.1"

    def test_build_version(self):
        v = VersionChecker.parse_version("1.0.0+build.001")
        assert v.build == "build.001"

    def test_strips_whitespace(self):
        v = VersionChecker.parse_version("  2.0.0  ")
        assert v.major == 2

    def test_empty_string_raises(self):
        from caracal.deployment.version import VersionParseError
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("")

    def test_none_raises(self):
        from caracal.deployment.version import VersionParseError
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version(None)  # type: ignore[arg-type]

    def test_invalid_format_raises(self):
        from caracal.deployment.version import VersionParseError
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("not-a-version")

    def test_partial_version_raises(self):
        from caracal.deployment.version import VersionParseError
        with pytest.raises(VersionParseError):
            VersionChecker.parse_version("1.2")


@pytest.mark.unit
class TestVersionCompatibilityDataclass:
    def test_fields_stored(self):
        vc = VersionCompatibility(
            local_version=SemanticVersion(1, 0, 0),
            remote_version=SemanticVersion(1, 0, 1),
            compatibility_level=CompatibilityLevel.COMPATIBLE,
            message="OK",
        )
        assert vc.message == "OK"
        assert vc.upgrade_instructions is None


@pytest.mark.unit
class TestCompatibilityLevelEnum:
    def test_values(self):
        assert CompatibilityLevel.COMPATIBLE.value == "compatible"
        assert CompatibilityLevel.WARNING.value == "warning"
        assert CompatibilityLevel.INCOMPATIBLE.value == "incompatible"
