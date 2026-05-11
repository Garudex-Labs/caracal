// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Configuration validation tests.

package internal

import (
	"strings"
	"testing"
)

func TestConfigValidateRejectsHTTPSTSWithoutOverride(t *testing.T) {
	c := Config{Env: "dev", Port: "8081", STSURL: "http://sts.local", InsecureHTTP: true, MaxRequestBytes: 1}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "https") {
		t.Errorf("expected https requirement, got %v", err)
	}
}

func TestConfigValidateAcceptsInsecureSTSWhenAcked(t *testing.T) {
	c := Config{Env: "dev", Port: "8081", STSURL: "http://sts.local", InsecureSTS: true, InsecureHTTP: true, MaxRequestBytes: 1}
	if err := c.validate(); err != nil {
		t.Errorf("acked override should pass, got %v", err)
	}
}

func TestConfigValidateRequiresTLSAck(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", MaxRequestBytes: 1, RedisURL: "redis://redis"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "INSECURE_HTTP") {
		t.Errorf("expected TLS ack requirement, got %v", err)
	}
}

func TestConfigValidateTLSPair(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", TLSCertFile: "cert", MaxRequestBytes: 1, RedisURL: "redis://redis"}
	if err := c.validate(); err == nil {
		t.Error("partial TLS config should fail")
	}
}

func TestConfigValidateRejectsBadScheme(t *testing.T) {
	c := Config{Env: "dev", Port: "8081", STSURL: "ftp://sts", InsecureHTTP: true, MaxRequestBytes: 1}
	if err := c.validate(); err == nil {
		t.Error("non-http scheme should fail")
	}
}

func TestConfigValidateMaxBytesPositive(t *testing.T) {
	c := Config{Env: "dev", Port: "8081", STSURL: "https://sts", InsecureHTTP: true, MaxRequestBytes: 0}
	if err := c.validate(); err == nil {
		t.Error("zero MaxRequestBytes should fail")
	}
}

func TestConfigValidateRejectsNonStandardPort(t *testing.T) {
	c := Config{Env: "dev", Port: "9090", STSURL: "https://sts", InsecureHTTP: true, MaxRequestBytes: 1}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "8081") {
		t.Errorf("expected port enforcement, got %v", err)
	}
}

func TestConfigValidateProductionRejectsInsecure(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", TLSCertFile: "c", TLSKeyFile: "k", InsecureHTTP: true, MaxRequestBytes: 1, RedisURL: "redis://redis"}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "forbidden") {
		t.Errorf("expected production reject, got %v", err)
	}
}

func TestConfigValidateProductionRequiresRedis(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", TLSCertFile: "c", TLSKeyFile: "k", MaxRequestBytes: 1}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "REDIS_URL") {
		t.Errorf("expected Redis requirement, got %v", err)
	}
}

func TestConfigValidateProductionRejectsJTIFailOpen(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", TLSCertFile: "c", TLSKeyFile: "k", MaxRequestBytes: 1, RedisURL: "redis://redis", JTIFailOpen: true}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "JTI_FAIL_OPEN") {
		t.Errorf("expected JTI fail-open rejection, got %v", err)
	}
}

func TestConfigValidateProductionPrivateUpstreamsRequireAllowlist(t *testing.T) {
	c := Config{Env: "production", Port: "8081", STSURL: "https://sts", TLSCertFile: "c", TLSKeyFile: "k", MaxRequestBytes: 1, RedisURL: "redis://redis", AllowPrivateUpstreams: true}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "UPSTREAM_HOST_ALLOWLIST") {
		t.Errorf("expected private upstream allowlist requirement, got %v", err)
	}
}

func TestConfigValidateRejectsUnknownEnv(t *testing.T) {
	c := Config{Env: "staging", Port: "8081", STSURL: "https://sts", TLSCertFile: "c", TLSKeyFile: "k", MaxRequestBytes: 1}
	if err := c.validate(); err == nil || !strings.Contains(err.Error(), "CARACAL_ENV") {
		t.Errorf("expected env reject, got %v", err)
	}
}

func TestSplitCSV(t *testing.T) {
	got := splitCSV("a, B ,c,, d ")
	want := []string{"a", "b", "c", "d"}
	if len(got) != len(want) {
		t.Fatalf("len mismatch: got %v", got)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("idx %d got %q want %q", i, got[i], want[i])
		}
	}
}
