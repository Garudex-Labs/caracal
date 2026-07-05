"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for canonical Caracal Python error serialization.
"""

import unittest

from caracalai_core.errors import CaracalError, ErrorCode


class CaracalErrorTests(unittest.TestCase):
    def test_string_and_json_include_optional_fields(self) -> None:
        err = CaracalError(
            ErrorCode.ACCESS_DENIED,
            "Denied",
            request_id="req-1",
            details={"scope": "calendar.read"},
        )

        self.assertEqual(str(err), "access_denied: Denied")
        self.assertEqual(
            err.to_json(),
            {
                "error": "access_denied",
                "error_description": "Denied",
                "requestId": "req-1",
                "details": {"scope": "calendar.read"},
            },
        )

    def test_json_omits_empty_optional_fields(self) -> None:
        self.assertEqual(
            CaracalError(ErrorCode.INTERNAL, "Boom").to_json(),
            {"error": "internal_error", "error_description": "Boom"},
        )


if __name__ == "__main__":
    unittest.main()
