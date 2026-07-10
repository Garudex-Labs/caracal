// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// End-to-end scaffold exercising the STS token exchange round trip against a running stack.

package e2e_test

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSTSTokenExchangeAvailable(t *testing.T) {
	base := os.Getenv("CARACAL_STS_URL")
	if base == "" {
		t.Skip("CARACAL_STS_URL not set; skipping live STS exchange check")
	}
	client := &http.Client{Timeout: 5 * time.Second}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange")
	form.Set("subject_token", "invalid")
	form.Set("subject_token_type", "urn:ietf:params:oauth:token-type:jwt")
	req, err := http.NewRequest(http.MethodPost, base+"/oauth/2/token", bytes.NewBufferString(form.Encode()))
	if err != nil {
		t.Fatalf("build req: %v", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("post token: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("invalid subject_token unexpectedly accepted: %s", string(body))
	}
	if !strings.Contains(strings.ToLower(string(body)), "error") {
		t.Fatalf("expected error payload, got %s", string(body))
	}
}
