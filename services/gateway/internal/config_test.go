// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Configuration validation tests.

package internal

import (
	"strings"
	"testing"
)

var gatewayAuditKey = make([]byte, 32)

func TestConfigValidateRuntimeRejectsHTTPSTSWithPublicHost(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "http://sts.example.com", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "https") {
		t.Errorf("expected https requirement, got %v", err)
	}
}

func TestConfigValidateRuntimeAcceptsInternalHTTPSTS(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "http://sts:8080", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k", AuditHMACKey: gatewayAuditKey}
	if err := c.validate(); err != nil {
		t.Errorf("internal docker host should be allowed, got %v", err)
	}
}

func TestConfigValidateDevAcceptsAnyHTTPSTS(t *testing.T) {
	c := Config{Mode: "dev", Port: "8081", STSURL: "http://sts.example.com", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err != nil {
		t.Errorf("dev mode should accept any STS_URL, got %v", err)
	}
}

func TestConfigValidateAllowsPlaintextListener(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k", AuditHMACKey: gatewayAuditKey}
	if err := c.validate(); err != nil {
		t.Errorf("plaintext listener should be allowed when certs unset, got %v", err)
	}
}

func TestConfigValidateTLSPair(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", TLSCertFile: "cert", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil {
		t.Error("partial TLS config should fail")
	}
}

func TestConfigValidateRejectsBadScheme(t *testing.T) {
	c := Config{Mode: "dev", Port: "8081", STSURL: "ftp://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil {
		t.Error("non-http scheme should fail")
	}
}

func TestConfigValidateMaxBytesPositive(t *testing.T) {
	c := Config{Mode: "dev", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 0, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil {
		t.Error("zero MaxRequestBytes should fail")
	}
}

func TestConfigValidateRejectsInvalidPort(t *testing.T) {
	c := Config{Mode: "dev", Port: "not-a-port", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "PORT") {
		t.Errorf("expected port validation, got %v", err)
	}
	c.Port = "70000"
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "PORT") {
		t.Errorf("expected out-of-range port to fail, got %v", err)
	}
}

func TestConfigValidateRejectsNonStandardPort(t *testing.T) {
	c := Config{Mode: "dev", Port: "9090", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "8081") {
		t.Errorf("nonstandard port should fail, got %v", err)
	}
}

func TestConfigValidateRuntimeRequiresRedis(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, StreamsHMACKey: "k"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "REDIS_URL") {
		t.Errorf("expected Redis requirement, got %v", err)
	}
}

func TestConfigValidateRuntimeRequiresStreamHMAC(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "STREAMS_HMAC_KEY") {
		t.Errorf("expected stream HMAC requirement, got %v", err)
	}
}

func TestConfigValidateRuntimeRequiresAuditHMAC(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "AUDIT_HMAC_KEY") {
		t.Errorf("expected audit HMAC requirement, got %v", err)
	}
}

func TestConfigValidateRuntimeRejectsJTIFailOpen(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k", JTIFailOpen: true}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "JTI_FAIL_OPEN") {
		t.Errorf("expected JTI fail-open rejection, got %v", err)
	}
}

func TestConfigValidateRuntimePrivateUpstreamsRequireAllowlist(t *testing.T) {
	c := Config{Mode: "runtime", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis", StreamsHMACKey: "k", AllowPrivateUpstreams: true}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "UPSTREAM_HOST_ALLOWLIST") {
		t.Errorf("expected private upstream allowlist requirement, got %v", err)
	}
}

func TestIsInternalHost(t *testing.T) {
	for _, h := range []string{"sts", "caracal-api", "localhost", "127.0.0.1", "::1"} {
		if !isInternalHost(h) {
			t.Errorf("%q should be internal", h)
		}
	}
	for _, h := range []string{"sts.example.com", "example.com", ""} {
		if isInternalHost(h) {
			t.Errorf("%q should not be internal", h)
		}
	}
}
