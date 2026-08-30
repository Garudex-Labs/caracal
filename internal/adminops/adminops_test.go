// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/base64"
	"strings"
	"testing"
)

func svgURL(body string) string {
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(body))
}

func TestValidateBrandingLogo(t *testing.T) {
	cases := []struct {
		name, value, wantDetail string
	}{
		{"empty ok", "", ""},
		{"not data url", "http://x/logo.png", "Logo must be a base64 data URL (data:image/...;base64,...)"},
		{"bad mime", "data:image/tiff;base64,AAAA", "Unsupported image type: image/tiff. Allowed: PNG, SVG, ICO, JPEG, WEBP"},
		{"magic mismatch", "data:image/png;base64,AAAAAAAAAAAA", "File content does not match declared type image/png"},
		{"bad base64", "data:image/png;base64,!!!!", "File content does not match declared type image/png"},
		{"svg script", svgURL("<svg><script>alert(1)</script></svg>"), "SVG contains forbidden elements (script, foreignObject, iframe, etc.)"},
		{"svg event", svgURL(`<svg onload="x()"></svg>`), "SVG contains forbidden event handler attributes (onclick, onload, etc.)"},
		{"svg js href", svgURL(`<svg><a href="javascript:x()"/></svg>`), "SVG contains javascript: URLs"},
		{"svg external", svgURL(`<svg><image href="https://evil/x.png"/></svg>`), "SVG contains external resource references"},
		{"svg doctype", svgURL(`<!DOCTYPE svg><svg/>`), "SVG must not contain DOCTYPE or ENTITY declarations"},
		{"svg data image ok", svgURL(`<svg><image href="data:image/png;base64,AA"/></svg>`), ""},
		{"svg clean", svgURL(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`), ""},
	}
	for _, tc := range cases {
		detail, bad := validateBrandingLogo(tc.value)
		if tc.wantDetail == "" && bad {
			t.Errorf("%s: unexpected rejection %q", tc.name, detail)
		}
		if tc.wantDetail != "" && detail != tc.wantDetail {
			t.Errorf("%s: detail = %q, want %q", tc.name, detail, tc.wantDetail)
		}
	}
}

func TestValidateBrandingAppName(t *testing.T) {
	if detail, bad := validateBrandingAppName(strings.Repeat("x", 31)); !bad ||
		detail != "App name too long (31 chars). Maximum: 30" {
		t.Errorf("long name: %q", detail)
	}
	if detail, bad := validateBrandingAppName("<b>hi</b>"); !bad ||
		detail != "App name must not contain HTML tags" {
		t.Errorf("html: %q", detail)
	}
	if _, bad := validateBrandingAppName("Caracal \u200b"); !bad {
		t.Error("invisible characters accepted")
	}
	if _, bad := validateBrandingAppName("Caracal"); bad {
		t.Error("clean name rejected")
	}
}

func TestSettingLabel(t *testing.T) {
	cases := map[string]string{
		"insights.api_key":        "API Key",
		"deployment.frontend_url": "Frontend URL",
		"data.cache_ttl_default":  "Cache TTL Default",
		"resource.db_pool_size":   "DB Pool Size",
	}
	for key, want := range cases {
		if got := settingLabel(key); got != want {
			t.Errorf("settingLabel(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestTruthy(t *testing.T) {
	if !truthy("false") {
		t.Error("non-empty string must count as enabled, matching dynamic-typed bodies")
	}
	for _, v := range []any{false, "", float64(0), nil, []any{}, map[string]any{}} {
		if truthy(v) {
			t.Errorf("truthy(%#v) = true", v)
		}
	}
	if !truthy(true) || !truthy(float64(1)) {
		t.Error("plain enabled values rejected")
	}
}

func TestSchemaSectionsCoverEveryDefault(t *testing.T) {
	h := &Handler{external: map[string]string{}}
	covered := map[string]bool{}
	for _, sec := range h.schema() {
		for _, key := range sec["keys"].([]string) {
			covered[key] = true
		}
	}
	for _, e := range defaults {
		if !covered[e.key] {
			t.Errorf("default %q not covered by any section", e.key)
		}
	}
}
