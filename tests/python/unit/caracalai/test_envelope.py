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
    HEADER_TRACESTATE,
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
    def test_returns_trace_id_and_flags_from_valid_header(self) -> None:
        trace = "00-0123456789abcdef0123456789abcdef-0011223344556677-01"
        parsed = parse_traceparent(trace)
        assert parsed is not None
        self.assertEqual(parsed.trace_id, "0123456789abcdef0123456789abcdef")
        self.assertEqual(parsed.flags, "01")

    def test_accepts_future_versions_with_extra_fields(self) -> None:
        trace = "01-0123456789abcdef0123456789abcdef-0011223344556677-00-extra"
        parsed = parse_traceparent(trace)
        assert parsed is not None
        self.assertEqual(parsed.trace_id, "0123456789abcdef0123456789abcdef")
        self.assertEqual(parsed.flags, "00")

    def test_returns_none_for_invalid_format(self) -> None:
        self.assertIsNone(parse_traceparent("not-a-traceparent"))
        self.assertIsNone(parse_traceparent(""))
        self.assertIsNone(
            parse_traceparent("ff-0123456789abcdef0123456789abcdef-0011223344556677-01")
        )
        self.assertIsNone(
            parse_traceparent(
                "00-0123456789abcdef0123456789abcdef-0011223344556677-01-extra"
            )
        )

    def test_returns_none_for_all_zero_trace_id(self) -> None:
        zero = "00-" + "0" * 32 + "-0011223344556677-01"
        self.assertIsNone(parse_traceparent(zero))

    def test_strips_surrounding_whitespace(self) -> None:
        trace = "  00-0123456789abcdef0123456789abcdef-aabbccddeeff0011-01  "
        parsed = parse_traceparent(trace)
        assert parsed is not None
        self.assertEqual(parsed.trace_id, "0123456789abcdef0123456789abcdef")


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

    def test_encodes_keys_in_sorted_order(self) -> None:
        result = encode_baggage({"zeta": "1", "alpha": "2", "mid": "3"})
        self.assertEqual(result, "alpha=2,mid=3,zeta=1")


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

    def test_plus_stays_literal(self) -> None:
        bag = parse_baggage("k=a+b")
        self.assertEqual(bag["k"], "a+b")

    def test_discards_headers_above_size_limits(self) -> None:
        self.assertEqual(parse_baggage("k=" + "a" * 9000), {})
        oversized = ",".join(f"k{i}=v" for i in range(65))
        self.assertEqual(parse_baggage(oversized), {})


class DecodeEnvelopeTests(unittest.TestCase):
    def test_extracts_bearer_token_from_authorization_header(self) -> None:
        def get(name: str) -> str | None:
            return {"authorization": "Bearer tok-1"}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.subject_token, "tok-1")

    def test_bearer_scheme_is_case_insensitive_and_trimmed(self) -> None:
        def get(name: str) -> str | None:
            return {"authorization": "  bEaReR   tok-1  "}.get(name)

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
        self.assertEqual(env.session_id, "sess-1")
        self.assertEqual(env.hop, 3)

    def test_clamps_hop_to_max(self) -> None:
        baggage = f"{BAGGAGE_HOP}={MAX_HOP + 100}"

        def get(name: str) -> str | None:
            return {HEADER_BAGGAGE: baggage}.get(name)

        env = decode_envelope(get)
        self.assertEqual(env.hop, MAX_HOP)

    def test_defaults_hop_to_zero_for_invalid_value(self) -> None:
        for raw in ("not-a-number", "-1", "+3", "1.5", "1e2"):
            baggage = f"{BAGGAGE_HOP}={raw}"

            def get(name: str, baggage: str = baggage) -> str | None:
                return {HEADER_BAGGAGE: baggage}.get(name)

            env = decode_envelope(get)
            self.assertEqual(env.hop, 0, raw)

    def test_captures_third_party_baggage_and_trace_state(self) -> None:
        headers = {
            HEADER_BAGGAGE: f"tenant=hooli,{BAGGAGE_HOP}=1",
            HEADER_TRACESTATE: "vendor=value",
        }
        env = decode_envelope(lambda n: headers.get(n))
        self.assertEqual(env.baggage, {"tenant": "hooli"})
        self.assertEqual(env.trace_state, "vendor=value")


class EncodeDecodeRoundtripTests(unittest.TestCase):
    def test_round_trips_full_envelope_through_headers(self) -> None:
        env = Envelope(
            subject_token="tok",
            session_id="agent-1",
            delegation_id="edge-1",
            parent_delegation_id="parent-1",
            subject_authority_record_id="sid-1",
            trace_id="a" * 32,
            trace_flags="00",
            trace_state="vendor=value",
            baggage={"tenant": "hooli"},
            hop=2,
        )
        headers = to_headers(env)
        self.assertNotIn(HEADER_AUTHORIZATION, headers)
        self.assertIn(HEADER_TRACEPARENT, headers)
        self.assertIn(HEADER_BAGGAGE, headers)

        recovered = from_headers(headers)
        self.assertIsNone(recovered.subject_token)
        self.assertEqual(recovered.session_id, "agent-1")
        self.assertEqual(recovered.delegation_id, "edge-1")
        self.assertEqual(recovered.parent_delegation_id, "parent-1")
        self.assertEqual(recovered.subject_authority_record_id, "sid-1")
        self.assertEqual(recovered.trace_flags, "00")
        self.assertEqual(recovered.trace_state, "vendor=value")
        self.assertEqual(recovered.baggage, {"tenant": "hooli"})
        self.assertEqual(recovered.hop, 2)

    def test_encode_never_emits_authorization(self) -> None:
        env = Envelope(subject_token="tok", hop=1)
        out: dict[str, str] = {}
        encode_envelope(env, lambda n, v: out.__setitem__(n, v))
        self.assertNotIn(HEADER_AUTHORIZATION, out)

    def test_omits_baggage_for_root_envelope(self) -> None:
        env = Envelope(subject_token="tok")
        out: dict[str, str] = {}
        encode_envelope(env, lambda n, v: out.__setitem__(n, v))
        self.assertNotIn(HEADER_BAGGAGE, out)
        self.assertIn(HEADER_TRACEPARENT, out)

    def test_merge_preserves_existing_headers(self) -> None:
        existing = {
            HEADER_TRACEPARENT: "00-" + "a" * 31 + "b-" + "b" * 16 + "-01",
            HEADER_TRACESTATE: "otel=span",
            HEADER_BAGGAGE: f"tenant=hooli,{BAGGAGE_HOP}=9",
        }
        env = Envelope(
            session_id="sess",
            trace_id="0123456789abcdef0123456789abcdef",
            trace_state="caracal=ignored",
            hop=2,
        )
        encode_envelope(
            env,
            lambda n, v: existing.__setitem__(n, v),
            lambda n: existing.get(n),
        )
        self.assertEqual(
            existing[HEADER_TRACEPARENT], "00-" + "a" * 31 + "b-" + "b" * 16 + "-01"
        )
        self.assertEqual(existing[HEADER_TRACESTATE], "otel=span")
        bag = parse_baggage(existing[HEADER_BAGGAGE])
        self.assertEqual(bag["tenant"], "hooli")
        self.assertEqual(bag[BAGGAGE_AGENT_SESSION], "sess")
        self.assertEqual(bag[BAGGAGE_HOP], "2")
        self.assertNotIn(BAGGAGE_DELEGATION_EDGE, bag)


if __name__ == "__main__":
    unittest.main()
