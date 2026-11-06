# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Regression tests for hash-lock and Python package constraint validation.

import importlib.util
import unittest
from pathlib import Path

from packaging.version import Version

ROOT = Path(__file__).resolve().parents[4]
SPEC = importlib.util.spec_from_file_location(
    "dependency_locks", ROOT / "scripts/checkPythonDependencies.py"
)
LOCKS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCKS)


class DependencyLockTests(unittest.TestCase):
    def test_repository_locks_satisfy_package_and_build_constraints(self):
        self.assertEqual(LOCKS.validate(), [])

    def test_accepts_multiline_hashes(self):
        text = (
            "example==1.2.3 \\\n    --hash=sha256:" + "a" * 64 + "\n    # via input\n"
        )
        self.assertEqual(LOCKS.read_lock(text), {"example": Version("1.2.3")})

    def test_rejects_missing_or_invalid_hashes(self):
        for text in ["example==1.2.3", "example==1.2.3 --hash=sha256:bad"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                LOCKS.read_lock(text)

    def test_rejects_unpinned_or_duplicate_requirements(self):
        digest = " --hash=sha256:" + "a" * 64
        for text in [
            "example>=1" + digest,
            "example==1.*" + digest,
            ("example==1" + digest + "\n") * 2,
        ]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                LOCKS.read_lock(text)

    def test_rejects_lock_below_package_minimum(self):
        self.assertEqual(
            len(
                LOCKS.check_requirements(
                    ["idna>=3.18"], {"idna": Version("3.17")}, "SDK"
                )
            ),
            1,
        )
        self.assertEqual(
            LOCKS.check_requirements(["idna>=3.18"], {"idna": Version("3.20")}, "SDK"),
            [],
        )


if __name__ == "__main__":
    unittest.main()
