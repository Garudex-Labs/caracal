// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package adminops

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"
)

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00")
}

const (
	maxLogoBytes  = 2 * 1024 * 1024
	maxDataURLLen = 3 * 1024 * 1024
	maxAppNameLen = 30
)

var allowedLogoMimes = map[string]bool{
	"image/png": true, "image/svg+xml": true, "image/x-icon": true,
	"image/vnd.microsoft.icon": true, "image/jpeg": true, "image/webp": true,
}

var magicBytes = map[string][][]byte{
	"image/png":                {[]byte("\x89PNG\r\n\x1a\n")},
	"image/jpeg":               {[]byte("\xff\xd8\xff")},
	"image/webp":               {[]byte("RIFF")},
	"image/x-icon":             {[]byte("\x00\x00\x01\x00"), []byte("\x00\x00\x02\x00")},
	"image/vnd.microsoft.icon": {[]byte("\x00\x00\x01\x00"), []byte("\x00\x00\x02\x00")},
}

var (
	dataURLRe        = regexp.MustCompile(`(?s)^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$`)
	svgDangerousTags = regexp.MustCompile(`(?i)<[\s/]*(script|foreignObject|iframe|embed|object|applet|meta|link|style|handler|set|animate|animateTransform|animateMotion)\b`)
	svgEventAttrs    = regexp.MustCompile(`(?i)\bon\w+\s*=`)
	svgJSHref        = regexp.MustCompile(`(?i)(?:href|xlink:href)[\s="']*javascript:`)
	svgExternalRef   = regexp.MustCompile(`(?i)(?:href|xlink:href|src|url)[\s="']*(?:https?://|//|data:)`)
	svgXMLDecl       = regexp.MustCompile(`(?i)<!(?:DOCTYPE|ENTITY)\b`)
	unsafeNameChars  = regexp.MustCompile("[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]")
)

// sanitizeSVG rejects SVGs that can execute code or make external requests.
func sanitizeSVG(raw []byte) (string, bool) {
	if !isValidUTF8(raw) {
		return "SVG contains invalid UTF-8", true
	}
	text := string(raw)
	if svgXMLDecl.MatchString(text) {
		return "SVG must not contain DOCTYPE or ENTITY declarations", true
	}
	if svgDangerousTags.MatchString(text) {
		return "SVG contains forbidden elements (script, foreignObject, iframe, etc.)", true
	}
	if svgEventAttrs.MatchString(text) {
		return "SVG contains forbidden event handler attributes (onclick, onload, etc.)", true
	}
	if svgJSHref.MatchString(text) {
		return "SVG contains javascript: URLs", true
	}
	// data:image/ embeds are allowed; every other external form is not.
	if hasExternalRef(text) {
		return "SVG contains external resource references", true
	}
	return "", false
}

func hasExternalRef(text string) bool {
	// data:image/ embeds are the one allowed data: form (the incumbent's
	// negative lookahead), so peek past each data: match before flagging.
	for _, loc := range svgExternalRef.FindAllStringIndex(text, -1) {
		match := text[loc[0]:loc[1]]
		if strings.HasSuffix(match, "data:") {
			if strings.HasPrefix(text[loc[1]:], "image/") {
				continue
			}
		}
		return true
	}
	return false
}

func isValidUTF8(raw []byte) bool {
	return strings.ToValidUTF8(string(raw), "\uFFFD") == string(raw)
}

func lenientB64(b64 string) ([]byte, error) {
	filtered := strings.Map(func(r rune) rune {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '+' || r == '/' || r == '=' {
			return r
		}
		return -1
	}, b64)
	if pad := len(filtered) % 4; pad != 0 {
		filtered = filtered[:len(filtered)-pad]
	}
	return base64.StdEncoding.DecodeString(filtered)
}

// validateBrandingLogo mirrors the data-URL, size, magic-byte, and SVG rules.
func validateBrandingLogo(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	if len(value) > maxDataURLLen {
		return "Image data too large", true
	}
	m := dataURLRe.FindStringSubmatch(value)
	if m == nil {
		return "Logo must be a base64 data URL (data:image/...;base64,...)", true
	}
	mime, b64 := m[1], m[2]
	if !allowedLogoMimes[mime] {
		return fmt.Sprintf("Unsupported image type: %s. Allowed: PNG, SVG, ICO, JPEG, WEBP", mime), true
	}
	// The incumbent decoder ignores non-alphabet characters (newlines in
	// pasted data URLs), so decode leniently.
	raw, err := lenientB64(b64)
	if err != nil {
		return "Invalid base64 data", true
	}
	if len(raw) > maxLogoBytes {
		sizeMB := float64(len(raw)) / (1024 * 1024)
		return fmt.Sprintf("Logo too large (%.1fMB). Maximum: %dMB", sizeMB, maxLogoBytes/(1024*1024)), true
	}
	if mime == "image/svg+xml" {
		return sanitizeSVG(raw)
	}
	if sigs, ok := magicBytes[mime]; ok {
		matched := false
		for _, sig := range sigs {
			if len(raw) >= len(sig) && string(raw[:len(sig)]) == string(sig) {
				matched = true
				break
			}
		}
		if !matched {
			return "File content does not match declared type " + mime, true
		}
		if mime == "image/webp" && (len(raw) < 12 || string(raw[8:12]) != "WEBP") {
			return "File content does not match declared type image/webp", true
		}
	}
	return "", false
}

func validateBrandingAppName(value string) (string, bool) {
	if n := len([]rune(value)); n > maxAppNameLen {
		return fmt.Sprintf("App name too long (%d chars). Maximum: %d", n, maxAppNameLen), true
	}
	if unsafeNameChars.MatchString(value) {
		return "App name contains forbidden control or invisible characters", true
	}
	if strings.Contains(value, "<") && strings.Contains(value, ">") {
		return "App name must not contain HTML tags", true
	}
	return "", false
}
