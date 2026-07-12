"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests release-source provenance matching for resumed PyPI publication.
"""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "verify_pypi_release", ROOT / "scripts" / "verifyPypiRelease.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load PyPI release verifier")
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class ReleaseProvenanceTests(unittest.TestCase):
    def test_accepts_signed_release_source_predicate(self) -> None:
        source_sha = "a" * 40
        release_tag = "v0.2.0-rc.2"
        results = [
            {
                "verificationResult": {
                    "signature": {
                        "certificate": {
                            "sourceRepositoryURI": VERIFY.REPOSITORY_URL,
                            "sourceRepositoryDigest": "workflow-commit",
                            "buildSignerURI": VERIFY.PUBLISHER_URI,
                        }
                    },
                    "statement": {
                        "predicate": {
                            "sourceRepositoryURI": VERIFY.REPOSITORY_URL,
                            "sourceRepositoryDigest": source_sha,
                            "sourceRepositoryRef": f"refs/tags/{release_tag}",
                        }
                    },
                }
            }
        ]

        self.assertTrue(
            VERIFY.has_release_source_provenance(results, source_sha, release_tag)
        )
        self.assertFalse(
            VERIFY.has_release_source_provenance(results, "b" * 40, release_tag)
        )
        results[0]["verificationResult"]["signature"]["certificate"][
            "buildSignerURI"
        ] = f"{VERIFY.REPOSITORY_URL}/.github/workflows/release.yml@refs/tags/{release_tag}"
        self.assertFalse(
            VERIFY.has_release_source_provenance(results, source_sha, release_tag)
        )


if __name__ == "__main__":
    unittest.main()
