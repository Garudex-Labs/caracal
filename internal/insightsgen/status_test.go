// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package insightsgen

import (
	"context"
	"errors"
	"testing"

	"github.com/garudex-labs/caracal/internal/fernet"
)

func TestAvailability(t *testing.T) {
	cases := []struct {
		name       string
		settings   fakeSettings
		credsErr   error
		wantOK     bool
		wantReason string
	}{
		{
			name:       "no model configured",
			settings:   fakeSettings{},
			wantOK:     false,
			wantReason: "No model configured. Set insights.model_sections in admin settings.",
		},
		{
			name:     "non-anthropic model needs no AWS checks",
			settings: fakeSettings{"insights.model_sections": "openai/gpt-5"},
			wantOK:   true,
		},
		{
			name: "anthropic with direct api key skips AWS checks",
			settings: fakeSettings{
				"insights.model_sections": "anthropic/claude",
				"insights.api_key":        "sk-x",
			},
			wantOK: true,
		},
		{
			name:       "anthropic missing access key",
			settings:   fakeSettings{"insights.model_sections": "anthropic/claude"},
			wantOK:     false,
			wantReason: "AWS access key not configured. Set insights.aws_access_key_id in admin settings.",
		},
		{
			name: "anthropic missing secret key",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "",
			},
			wantOK:     false,
			wantReason: "AWS secret key not configured. Set insights.aws_secret_access_key in admin settings.",
		},
		{
			name: "invalid access key",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "s",
			},
			credsErr:   errors.New("api error InvalidClientTokenId: nope"),
			wantOK:     false,
			wantReason: "AWS access key is invalid. Update insights.aws_access_key_id in admin settings.",
		},
		{
			name: "invalid secret key",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "s",
			},
			credsErr:   errors.New("SignatureDoesNotMatch"),
			wantOK:     false,
			wantReason: "AWS secret key is invalid. Update insights.aws_secret_access_key in admin settings.",
		},
		{
			name: "expired credentials",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "s",
			},
			credsErr:   errors.New("ExpiredToken"),
			wantOK:     false,
			wantReason: "AWS credentials have expired. Update credentials in admin settings.",
		},
		{
			name: "other credential failure",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "s",
			},
			credsErr:   errors.New("dial tcp: timeout"),
			wantOK:     false,
			wantReason: "AWS credential check failed. Verify your access key and secret in admin settings.",
		},
		{
			name: "valid AWS credentials",
			settings: fakeSettings{
				"insights.model_sections":        "anthropic/claude",
				"insights.aws_access_key_id":     "AKIA",
				"insights.aws_secret_access_key": "s",
			},
			wantOK: true,
		},
	}
	for _, tc := range cases {
		e := &Engine{
			Config: &Config{Settings: tc.settings},
			checkCredentials: func(context.Context, string, string, string) error {
				return tc.credsErr
			},
		}
		ok, reason := e.Availability(context.Background())
		if ok != tc.wantOK || reason != tc.wantReason {
			t.Errorf("%s: got (%v, %q), want (%v, %q)", tc.name, ok, reason, tc.wantOK, tc.wantReason)
		}
	}
}

func TestAvailabilityDefaultsRegion(t *testing.T) {
	var gotRegion string
	e := &Engine{
		Config: &Config{Settings: fakeSettings{
			"insights.model_sections":        "anthropic/claude",
			"insights.aws_access_key_id":     "AKIA",
			"insights.aws_secret_access_key": "s",
		}},
		checkCredentials: func(_ context.Context, region, _, _ string) error {
			gotRegion = region
			return nil
		},
	}
	if ok, _ := e.Availability(context.Background()); !ok {
		t.Fatal("want available")
	}
	if gotRegion != "us-east-1" {
		t.Errorf("default region = %q", gotRegion)
	}

	e.Config.Settings = fakeSettings{
		"insights.model_sections":        "anthropic/claude",
		"insights.aws_access_key_id":     "AKIA",
		"insights.aws_secret_access_key": "s",
		"insights.aws_region":            "eu-west-1",
	}
	if ok, _ := e.Availability(context.Background()); !ok {
		t.Fatal("want available")
	}
	if gotRegion != "eu-west-1" {
		t.Errorf("configured region = %q", gotRegion)
	}
}

func TestConfigNilSafety(t *testing.T) {
	var c *Config
	ctx := context.Background()
	if c.String(ctx, "k", "fb") != "fb" || !c.Bool(ctx, "k", true) || c.Int(ctx, "k", 7) != 7 {
		t.Error("nil Config must return fallbacks")
	}
	empty := &Config{}
	if empty.String(ctx, "k", "fb") != "fb" {
		t.Error("Config without settings must return fallbacks")
	}
}

func TestConfigSecret(t *testing.T) {
	ctx := context.Background()
	key := fernet.DeriveKey("server-secret")
	token, err := fernet.Encrypt(key, []byte("hunter2"))
	if err != nil {
		t.Fatal(err)
	}

	c := &Config{Settings: fakeSettings{"plain": "value", "enc": "enc:" + token, "bad": "enc:garbage"}}
	if got := c.Secret(ctx, "plain"); got != "value" {
		t.Errorf("plain secret = %q", got)
	}
	// Encrypted values are unreadable without the key, which reads as unset.
	if got := c.Secret(ctx, "enc"); got != "" {
		t.Errorf("no key = %q", got)
	}
	c.SecretKey = key
	if got := c.Secret(ctx, "enc"); got != "hunter2" {
		t.Errorf("decrypted secret = %q", got)
	}
	if got := c.Secret(ctx, "bad"); got != "" {
		t.Errorf("undecryptable value = %q", got)
	}
	if got := c.Secret(ctx, "missing"); got != "" {
		t.Errorf("missing key = %q", got)
	}
}
