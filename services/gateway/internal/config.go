// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Gateway service configuration: ports, TLS, STS endpoint, SSRF allowlist, and limits.

package internal

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/shared/config"
)

const (
	defaultPort           = "8081"
	defaultMaxRequestSize = 10 * 1024 * 1024
	defaultReadHeader     = 5 * time.Second
	defaultReadTimeout    = 30 * time.Second
	defaultWriteTimeout   = 60 * time.Second
	defaultIdleTimeout    = 120 * time.Second
	defaultSTSTimeout     = 5 * time.Second
	defaultUpstreamTO     = 30 * time.Second
)

// Config holds gateway runtime configuration.
type Config struct {
	Port                   string
	LogLevel               string
	STSURL                 string
	STSTimeout             time.Duration
	UpstreamTimeout        time.Duration
	ReadHeaderTimeout      time.Duration
	ReadTimeout            time.Duration
	WriteTimeout           time.Duration
	IdleTimeout            time.Duration
	MaxRequestBytes        int64
	TLSCertFile            string
	TLSKeyFile             string
	InsecureHTTP           bool
	InsecureSTS            bool
	AllowPrivateUpstreams  bool
	UpstreamHostAllowlist  []string
	ResourceClientBindings map[string]string
	RedisURL               string
}

// loadConfig reads configuration from environment variables.
// It panics on missing required values or unsafe defaults.
func loadConfig() Config {
	cfg := Config{
		Port:                   config.Getenv("PORT", defaultPort),
		LogLevel:               config.Getenv("LOG_LEVEL", "info"),
		STSURL:                 config.MustGetenv("STS_URL"),
		STSTimeout:             durationEnv("STS_TIMEOUT", defaultSTSTimeout),
		UpstreamTimeout:        durationEnv("UPSTREAM_TIMEOUT", defaultUpstreamTO),
		ReadHeaderTimeout:      durationEnv("READ_HEADER_TIMEOUT", defaultReadHeader),
		ReadTimeout:            durationEnv("READ_TIMEOUT", defaultReadTimeout),
		WriteTimeout:           durationEnv("WRITE_TIMEOUT", defaultWriteTimeout),
		IdleTimeout:            durationEnv("IDLE_TIMEOUT", defaultIdleTimeout),
		MaxRequestBytes:        int64Env("MAX_REQUEST_BYTES", defaultMaxRequestSize),
		TLSCertFile:            config.Getenv("TLS_CERT_FILE", ""),
		TLSKeyFile:             config.Getenv("TLS_KEY_FILE", ""),
		InsecureHTTP:           boolEnv("INSECURE_HTTP", false),
		InsecureSTS:            boolEnv("INSECURE_STS", false),
		AllowPrivateUpstreams:  boolEnv("ALLOW_PRIVATE_UPSTREAMS", false),
		UpstreamHostAllowlist:  splitCSV(config.Getenv("UPSTREAM_HOST_ALLOWLIST", "")),
		ResourceClientBindings: parseBindings(config.MustGetenv("RESOURCE_CLIENT_BINDINGS")),
		RedisURL:               config.Getenv("REDIS_URL", ""),
	}
	if err := cfg.validate(); err != nil {
		panic("gateway config: " + err.Error())
	}
	return cfg
}

func (c Config) validate() error {
	u, err := url.Parse(c.STSURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("STS_URL must be an absolute URL")
	}
	switch u.Scheme {
	case "https":
	case "http":
		if !c.InsecureSTS {
			return fmt.Errorf("STS_URL must use https; set INSECURE_STS=true to override")
		}
	default:
		return fmt.Errorf("STS_URL scheme must be http or https")
	}
	if c.TLSCertFile == "" && c.TLSKeyFile == "" {
		if !c.InsecureHTTP {
			return fmt.Errorf("TLS_CERT_FILE/TLS_KEY_FILE required; set INSECURE_HTTP=true to run plaintext")
		}
	} else if c.TLSCertFile == "" || c.TLSKeyFile == "" {
		return fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must both be set")
	}
	if c.Port != defaultPort {
		return fmt.Errorf("PORT must be %s", defaultPort)
	}
	if c.MaxRequestBytes <= 0 {
		return fmt.Errorf("MAX_REQUEST_BYTES must be positive")
	}
	if len(c.ResourceClientBindings) == 0 {
		return fmt.Errorf("RESOURCE_CLIENT_BINDINGS must declare at least one resource=client_id pair")
	}
	return nil
}

// TLSEnabled reports whether HTTPS is configured.
func (c Config) TLSEnabled() bool { return c.TLSCertFile != "" && c.TLSKeyFile != "" }

// parseBindings parses RESOURCE_CLIENT_BINDINGS as a comma-separated list of
// `resource=client_id` pairs. The gateway derives the exchanging principal from
// this map; client-supplied client_id headers are never honored.
func parseBindings(s string) map[string]string {
	out := make(map[string]string)
	for _, pair := range strings.Split(s, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		eq := strings.IndexByte(pair, '=')
		if eq <= 0 || eq == len(pair)-1 {
			panic(fmt.Sprintf("RESOURCE_CLIENT_BINDINGS entry %q must be resource=client_id", pair))
		}
		resource := strings.TrimSpace(pair[:eq])
		clientID := strings.TrimSpace(pair[eq+1:])
		if resource == "" || clientID == "" {
			panic(fmt.Sprintf("RESOURCE_CLIENT_BINDINGS entry %q has empty resource or client_id", pair))
		}
		if _, dup := out[resource]; dup {
			panic(fmt.Sprintf("RESOURCE_CLIENT_BINDINGS resource %q declared more than once", resource))
		}
		out[resource] = clientID
	}
	return out
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, strings.ToLower(v))
		}
	}
	return out
}

func durationEnv(key string, fallback time.Duration) time.Duration {
	v := config.Getenv(key, "")
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		panic(fmt.Sprintf("invalid duration for %s: %q", key, v))
	}
	return d
}

func int64Env(key string, fallback int64) int64 {
	v := config.Getenv(key, "")
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil || n <= 0 {
		panic(fmt.Sprintf("invalid integer for %s: %q", key, v))
	}
	return n
}

func boolEnv(key string, fallback bool) bool {
	v := config.Getenv(key, "")
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		panic(fmt.Sprintf("invalid boolean for %s: %q", key, v))
	}
	return b
}
