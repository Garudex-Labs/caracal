"""Unit tests for edition execution exclusivity enforcement."""

from unittest.mock import patch

import pytest

from caracal.deployment.edition import Edition, EditionManager
from caracal.deployment.exceptions import EditionDetectionError


@pytest.mark.unit
class TestEditionExecutionExclusivity:
    """Validate broker/gateway hard-cut exclusivity checks."""

    def setup_method(self) -> None:
        self.manager = EditionManager()
        self.manager.clear_cache()

    def test_enterprise_requires_gateway_url(self) -> None:
        with patch.object(EditionManager, "_auto_detect_edition", return_value=Edition.ENTERPRISE):
            with patch.object(EditionManager, "_resolve_gateway_url", return_value=None):
                with patch.object(EditionManager, "_has_local_provider_registry_entries", return_value=False):
                    with pytest.raises(EditionDetectionError, match="requires a configured gateway URL"):
                        self.manager.get_edition()

    def test_gateway_and_local_provider_registry_conflict(self) -> None:
        with patch.object(EditionManager, "_auto_detect_edition", return_value=Edition.ENTERPRISE):
            with patch.object(EditionManager, "_resolve_gateway_url", return_value="https://gateway.example"):
                with patch.object(EditionManager, "_has_local_provider_registry_entries", return_value=True):
                    with pytest.raises(EditionDetectionError, match="Execution exclusivity violation"):
                        self.manager.get_edition()

    def test_oss_local_registry_without_gateway_is_allowed(self) -> None:
        with patch.object(EditionManager, "_auto_detect_edition", return_value=Edition.OPENSOURCE):
            with patch.object(EditionManager, "_resolve_gateway_url", return_value=None):
                with patch.object(EditionManager, "_has_local_provider_registry_entries", return_value=True):
                    assert self.manager.get_edition() == Edition.OPENSOURCE
