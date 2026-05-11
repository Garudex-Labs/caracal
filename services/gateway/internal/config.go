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

	"github.com/garudex-labs/caracal/core/config"
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
	Env                   string
	Port                  string
	LogLevel              string
	STSURL                string
	STSTimeout            time.Duration
	UpstreamTimeout       time.Duration
	ReadHeaderTimeout     time.Duration
	ReadTimeout           time.Duration
	WriteTimeout          time.Duration
	IdleTimeout           time.Duration
	MaxRequestBytes       int64
	TLSCertFile           string
	TLSKeyFile            string
	InsecureHTTP          bool
	InsecureSTS           bool
	AllowPrivateUpstreams bool
	UpstreamHostAllowlist []string
	DatabaseURL           string
	RedisURL              string
	JTIFailOpen           bool
}

// loadConfig reads configuration from environment variables.
// It panics on missing required values or unsafe defaults.
func loadConfig() Config {
	cfg := Config{
		Env:                   config.Getenv("CARACAL_ENV", "production"),
		Port:                  config.Getenv("PORT", defaultPort),
		LogLevel:              config.Getenv("LOG_LEVEL", "info"),
		STSURL:                config.MustGetenv("STS_URL"),
		STSTimeout:            durationEnv("STS_TIMEOUT", defaultSTSTimeout),
		UpstreamTimeout:       durationEnv("UPSTREAM_TIMEOUT", defaultUpstreamTO),
		ReadHeaderTimeout:     durationEnv("READ_HEADER_TIMEOUT", defaultReadHeader),
		ReadTimeout:           durationEnv("READ_TIMEOUT", defaultReadTimeout),
		WriteTimeout:          durationEnv("WRITE_TIMEOUT", defaultWriteTimeout),
		IdleTimeout:           durationEnv("IDLE_TIMEOUT", defaultIdleTimeout),
		MaxRequestBytes:       int64Env("MAX_REQUEST_BYTES", defaultMaxRequestSize),
		TLSCertFile:           config.Getenv("TLS_CERT_FILE", ""),
		TLSKeyFile:            config.Getenv("TLS_KEY_FILE", ""),
		InsecureHTTP:          boolEnv("INSECURE_HTTP", false),
		InsecureSTS:           boolEnv("INSECURE_STS", false),
		AllowPrivateUpstreams: boolEnv("ALLOW_PRIVATE_UPSTREAMS", false),
		UpstreamHostAllowlist: splitCSV(config.Getenv("UPSTREAM_HOST_ALLOWLIST", "")),
		DatabaseURL:           config.MustGetenv("DATABASE_URL"),
		RedisURL:              config.Getenv("REDIS_URL", ""),
		JTIFailOpen:           boolEnv("JTI_FAIL_OPEN", false),
	}
	if err := cfg.validate(); err != nil {
		panic("gateway config: " + err.Error())
	}
	return cfg
}

func (c Config) validate() error {
	switch c.Env {
	case "production", "dev":
	default:
		return fmt.Errorf("CARACAL_ENV must be production or dev")
	}
	if c.Env == "production" && (c.InsecureHTTP || c.InsecureSTS) {
		return fmt.Errorf("INSECURE_HTTP and INSECURE_STS are forbidden when CARACAL_ENV=production")
	}
	if c.Env == "production" && c.RedisURL == "" {
		return fmt.Errorf("REDIS_URL is required when CARACAL_ENV=production")
	}
	if c.Env == "production" && c.JTIFailOpen {
		return fmt.Errorf("JTI_FAIL_OPEN is forbidden when CARACAL_ENV=production")
	}
	if c.Env == "production" && c.AllowPrivateUpstreams && len(c.UpstreamHostAllowlist) == 0 {
		return fmt.Errorf("UPSTREAM_HOST_ALLOWLIST is required when ALLOW_PRIVATE_UPSTREAMS=true in production")
	}
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
	return nil
}

// TLSEnabled reports whether HTTPS is configured.
func (c Config) TLSEnabled() bool { return c.TLSCertFile != "" && c.TLSKeyFile != "" }

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
