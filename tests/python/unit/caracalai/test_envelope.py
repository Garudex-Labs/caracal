"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for W3C Trace Context and Baggage envelope encode/decode functions.
"""

from __future__ import annotations

import unittest

from caracalai.advanced import (
    BAGGAGE_AGENT_SESSION,
    BAGGAGE_DELEGATION_EDGE,
    BAGGAGE_HOP,
    HEADER_AUTHORIZATION,
    HEADER_BAGGAGE,
    HEADER_TRACEPARENT,
    MAX_HOP,
    Envelope,
    decode_envelope,
    encode_baggage,
    encode_envelope,
    from_headers,
    parse_baggage,
    parse_traceparent,
    to_headers,
)


class ParseTraceparentTests(unittest.TestCase):
    def test_returns_trace_id_from_valid_header(self) -> None:
        trace = "00-0123456789abcdef0123456789abcdef-0011223344556677-01"
        self.assertEqual(parse_traceparent(trace), "0123456789abcdef0123456789abcdef")

    def test_returns_none_for_invalid_format(self) -> None:
        self.assertIsNone(parse_traceparent("not-a-traceparent"))
        self.assertIsNone(parse_traceparent(""))

    def test_returns_none_for_all_zero_trace_id(self) -> None:
        zero = "00-" + "0" * 32 + "-0011223344556677-01"
        self.assertIsNone(parse_traceparent(zero))

    def test_strips_surrounding_whitespace(self) -> None:
        trace = "  00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01  "
        self.assertEqual(parse_traceparent(trace), "0123456789abcdef0123456789abcdef")


class EncodeBaggageTests(unittest.TestCase):
    def test_encodes_non_empty_entries(self) -> None:
        result = encode_baggage({BAGGAGE_HOP: "3", BAGGAGE_AGENT_SESSION: "sess1"})
        self.assertIn(f"{BAGGAGE_HOP}=3", result)
        self.assertIn(f"{BAGGAGE_AGENT_SESSION}=sess1", result)

    def test_skips_none_and_empty_string_values(self) -> None:
        result = encode_baggage({BAGGAGE_AGENT_SESSION: None, BAGGAGE_HOP: ""})
        self.assertEqual(result, "")

    def test_percent_encodes_special_characters(self) -> None:
        result = encode_baggage({BAGGAGE_AGENT_SESSION: "hello world"})
        self.assertIn("hello%20world", result)


class ParseBaggageTests(unittest.TestCase):
    def test_parses_comma_separated_key_value_pairs(self) -> None:
        bag = parse_baggage(f"{BAGGAGE_HOP}=2,{BAGGAGE_AGENT_SESSION}=sess9")
        self.assertEqual(bag[BAGGAGE_HOP], "2")
        self.assertEqual(bag[BAGGAGE_AGENT_SESSION], "sess9")

    def test_returns_empty_dict_for_none_or_empty_input(self) -> None:
        self.assertEqual(parse_baggage(None), {})
        self.assertEqual(parse_baggage(""), {})

    def test_strips_attribute_parameters_after_semicolon(self) -> None:
        bag = parse_baggage(f"{BAGGAGE_HOP}=5;ttl=3600")
        self.assertEqual(bag[BAGGAGE_HOP], "5")

    def test_decodes_percent_encoded_values(self) -> None:
        bag = parse_baggage(f"{BAGGAGE_AGENT_SESSION}=hello%20world")
        self.assertEqual(bag[BAGGAGE_AGENT_SESSION], "hello world")


class DecodeEnvelopeTests(unittest.TestCase):
    def test_extracts_bearer_token_from_authorization_header(self) -> None:
        def get(name: str) -> str | None:
            return {"authorization": "Bearer tok-1"}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.subject_token, "tok-1")

    def test_returns_none_subject_token_when_authorization_absent(self) -> None:
        env = decode_envelope(lambda _: None)
        self.assertIsNone(env.subject_token)

    def test_parses_agent_session_and_hop_from_baggage(self) -> None:
        baggage = f"{BAGGAGE_AGENT_SESSION}=sess-1,{BAGGAGE_HOP}=3"

        def get(name: str) -> str | None:
            return {HEADER_BAGGAGE: baggage}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.agent_session_id, "sess-1")
        self.assertEqual(env.hop, 3)

    def test_clamps_hop_to_max(self) -> None:
        baggage = f"{BAGGAGE_HOP}={MAX_HOP + 100}"

        def get(name: str) -> str | None:
            return {HEADER_BAGGAGE: baggage}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.hop, MAX_HOP)

    def test_defaults_hop_to_zero_for_invalid_value(self) -> None:
        baggage = f"{BAGGAGE_HOP}=not-a-number"

        def get(name: str) -> str | None:
            return {HEADER_BAGGAGE: baggage}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.hop, 0)


class EncodeDecodeRoundtripTests(unittest.TestCase):
    def test_round_trips_full_envelope_through_headers(self) -> None:
        env = Envelope(
            subject_token="tok",
            agent_session_id="agent-1",
            delegation_edge_id="edge-1",
            parent_edge_id="parent-1",
            session_id="sid-1",
            trace_id="a" * 32,
            hop=2,
        )
        headers = to_headers(env)
        self.assertEqual(headers[HEADER_AUTHORIZATION], "Bearer tok")
        self.assertIn(HEADER_TRACEPARENT, headers)
        self.assertIn(HEADER_BAGGAGE, headers)

        recovered = from_headers(headers)
        self.assertEqual(recovered.subject_token, "tok")
        self.assertEqual(recovered.agent_session_id, "agent-1")
        self.assertEqual(recovered.delegation_edge_id, "edge-1")
        self.assertEqual(recovered.parent_edge_id, "parent-1")
        self.assertEqual(recovered.session_id, "sid-1")
        self.assertEqual(recovered.hop, 2)

    def test_baggage_contains_only_hop_when_no_optional_fields_present(self) -> None:
        env = Envelope(subject_token="tok")
        out: dict[str, str] = {}
        encode_envelope(env, lambda n, v: out.__setitem__(n, v))
        bag = parse_baggage(out.get(HEADER_BAGGAGE))
        self.assertIn(BAGGAGE_HOP, bag)
        self.assertNotIn(BAGGAGE_AGENT_SESSION, bag)
        self.assertNotIn(BAGGAGE_DELEGATION_EDGE, bag)


if __name__ == "__main__":
    unittest.main()
