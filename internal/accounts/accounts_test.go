// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func dataURL(mime string, raw []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw)
}

func TestValidateAvatarDataURL(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 32)...)
	jpeg := append([]byte("\xff\xd8\xff"), make([]byte, 32)...)
	webp := append([]byte("RIFF\x00\x00\x00\x00WEBP"), make([]byte, 32)...)
	cases := []struct {
		name  string
		value string
		want  string
	}{
		{"valid png", dataURL("image/png", png), ""},
		{"valid jpeg", dataURL("image/jpeg", jpeg), ""},
		{"valid webp", dataURL("image/webp", webp), ""},
		{"oversized data url", "data:image/png;base64," + strings.Repeat("A", maxAvatarDataURLLen), "Image data too large"},
		{"not a data url", "https://example.com/a.png", "Avatar must be a base64 data URL"},
		{"disallowed mime", dataURL("image/gif", png), "Only PNG, JPEG, and WebP images are allowed"},
		{"broken base64", "data:image/png;base64,ab", "Invalid base64 data"},
		{"magic mismatch", dataURL("image/png", jpeg), "File content does not match declared type"},
		{"riff but not webp", dataURL("image/webp", append([]byte("RIFF\x00\x00\x00\x00WAVE"), make([]byte, 8)...)), "File content does not match declared type"},
	}
	for _, tc := range cases {
		if got := validateAvatarDataURL(tc.value); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
	// Oversized decoded payload trips the binary cap.
	big := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, maxAvatarBytes)...)
	if got := validateAvatarDataURL(dataURL("image/png", big)); got != "Image too large (max 2MB)" {
		t.Errorf("oversized binary: got %q", got)
	}
}

func TestLenientBase64(t *testing.T) {
	raw := []byte("hello world")
	encoded := base64.StdEncoding.EncodeToString(raw)
	// Characters outside the alphabet are discarded, not fatal.
	noisy := strings.ReplaceAll(encoded, "a", "a\n")
	got, err := lenientBase64(noisy)
	if err != nil || string(got) != string(raw) {
		t.Errorf("lenient decode = %q, %v", got, err)
	}
	if _, err := lenientBase64("ab"); err == nil {
		t.Error("truncated padding must fail")
	}
}

func TestWireProfileShape(t *testing.T) {
	created := time.Date(2026, 8, 29, 8, 0, 0, 123456000, time.UTC)
	blob, err := json.Marshal(wireProfile(&Profile{
		ID: "abc", Email: "e@x.io", Username: "acme", Name: "Acme", Role: "user",
		CreatedAt: created,
	}, "tenant"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"abc","email":"e@x.io","username":"acme","name":"Acme","role":"user","auth_context":"tenant","avatar_url":null,"created_at":"2026-08-29T08:00:00.123456Z"}`
	if string(blob) != want {
		t.Errorf("wire = %s", blob)
	}
}

func TestRateLimiter(t *testing.T) {
	var l rateLimiter
	if !l.allow("k", time.Minute) {
		t.Fatal("first request must pass")
	}
	if l.allow("k", time.Minute) {
		t.Fatal("second request within the window must block")
	}
	if !l.allow("other", time.Minute) {
		t.Fatal("distinct keys are independent")
	}
}
