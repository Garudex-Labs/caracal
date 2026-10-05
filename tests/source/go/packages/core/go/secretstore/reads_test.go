// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs

package secretstore

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type backendRoundTrip func(*http.Request) (*http.Response, error)

func (f backendRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Intercept only the backend's HTTP transport: these tests exercise the real
// request construction, signing and response handling without cloud credentials.
func withBackendHTTP(t *testing.T, handler http.HandlerFunc) {
	t.Helper()
	old := httpClient
	httpClient = &http.Client{Transport: backendRoundTrip(func(req *http.Request) (*http.Response, error) {
		w := httptest.NewRecorder()
		handler(w, req)
		return w.Result(), nil
	})}
	t.Cleanup(func() { httpClient = old })
}

func TestAWSSecretReadSignsAndHandlesResponses(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("aws-secret"))
	status := http.StatusOK
	body := `{"SecretString":"` + payload + `"}`
	requests := 0
	withBackendHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Host != "secretsmanager.us-east-1.amazonaws.com" ||
			r.Header.Get("X-Amz-Target") != "secretsmanager.GetSecretValue" ||
			r.Header.Get("X-Amz-Security-Token") != "session-token" ||
			!strings.Contains(r.Header.Get("Authorization"), "Credential=AKID/") ||
			!strings.Contains(r.Header.Get("Authorization"), "Signature=") {
			t.Errorf("unsigned or misrouted AWS request: %s %s %#v", r.Method, r.URL, r.Header)
		}
		if requests == 1 {
			var secret struct {
				SecretID string `json:"SecretId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&secret); err != nil || secret.SecretID != "zones/z1/secret" {
				t.Errorf("secret identifier not sent: %+v, %v", secret, err)
			}
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
	a := &awsSecretsManagerBackend{region: "us-east-1", creds: &awsCredentials{
		accessKeyID: "AKID", secretAccessKey: "secret-key", sessionToken: "session-token",
	}}
	check := func(want []byte, found bool, errorText string) {
		t.Helper()
		got, ok, err := a.Get(context.Background(), "zones/z1/secret")
		if string(got) != string(want) || ok != found || (errorText == "" && err != nil) || (errorText != "" && (err == nil || !strings.Contains(err.Error(), errorText))) {
			t.Fatalf("Get = %q, %t, %v; want %q, %t, %q", got, ok, err, want, found, errorText)
		}
	}
	check([]byte("aws-secret"), true, "")
	status, body = http.StatusBadRequest, `{"__type":"ResourceNotFoundException"}`
	check(nil, false, "")
	status, body = http.StatusForbidden, `{}`
	check(nil, false, "status 403")
	status, body = http.StatusOK, `{}`
	check(nil, false, "unexpected payload")
	status, body = http.StatusOK, `{"SecretString":"%%%"}`
	check(nil, false, "unexpected payload")
	if requests != 5 {
		t.Fatalf("expected five independent backend reads, got %d", requests)
	}
}

func TestCloudSecretReadsValidateAuthorizationAndPayload(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("cloud-secret"))
	for _, tc := range []struct {
		name    string
		backend Backend
		host    string
		path    string
		valid   string
		invalid string
	}{
		{"azure", &azureKeyVaultBackend{vaultURL: "https://vault.example", cache: oauthTokenCache{token: "token", expiresAt: time.Now().Add(time.Hour)}}, "vault.example", "/secrets/zone-secret", `{"value":"` + payload + `"}`, `{"value":"%%%"}`},
		{"gcp", &gcpSecretManagerBackend{project: "proj", cache: oauthTokenCache{token: "token", expiresAt: time.Now().Add(time.Hour)}}, "secretmanager.googleapis.com", "/v1/projects/proj/secrets/zone-secret/versions/latest:access", `{"payload":{"data":"` + payload + `"}}`, `{"payload":{"data":"%%%"}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, body := http.StatusOK, tc.valid
			withBackendHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Host != tc.host || r.URL.Path != tc.path || r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer token" {
					t.Errorf("incorrect secret read: %s %s %#v", r.Method, r.URL, r.Header)
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte(body))
			})
			read := func(want []byte, found bool, errorText string) {
				t.Helper()
				got, ok, err := tc.backend.Get(context.Background(), "zone/secret")
				if string(got) != string(want) || ok != found || (errorText == "" && err != nil) || (errorText != "" && (err == nil || !strings.Contains(err.Error(), errorText))) {
					t.Fatalf("Get = %q, %t, %v; want %q, %t, %q", got, ok, err, want, found, errorText)
				}
			}
			read([]byte("cloud-secret"), true, "")
			status, body = http.StatusNotFound, ""
			read(nil, false, "")
			status, body = http.StatusForbidden, ""
			read(nil, false, "status 403")
			status, body = http.StatusOK, tc.invalid
			read(nil, false, "unexpected payload")
			status, body = http.StatusOK, `{}`
			read(nil, false, "unexpected payload")
		})
	}
}

func TestPlatformIdentityTokensUseExpectedEndpointsAndCache(t *testing.T) {
	for _, tc := range []struct {
		name    string
		backend interface {
			accessToken(context.Context) (string, error)
		}
		host           string
		method         string
		metadataHeader string
	}{
		{"azure managed identity", &azureKeyVaultBackend{}, "169.254.169.254", http.MethodGet, "Metadata"},
		{"azure client credentials", &azureKeyVaultBackend{tenantID: "tenant", clientID: "app", clientSecret: "secret"}, "login.microsoftonline.com", http.MethodPost, ""},
		{"gcp workload identity", &gcpSecretManagerBackend{}, "metadata.google.internal", http.MethodGet, "Metadata-Flavor"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			withBackendHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Host != tc.host || r.Method != tc.method {
					t.Errorf("unexpected identity endpoint: %s %s", r.Method, r.URL)
				}
				if tc.metadataHeader != "" && r.Header.Get(tc.metadataHeader) == "" {
					t.Errorf("missing platform identity header %q", tc.metadataHeader)
				}
				if tc.name == "azure client credentials" {
					if r.URL.Path != "/tenant/oauth2/v2.0/token" || r.ParseForm() != nil ||
						r.PostForm.Get("grant_type") != "client_credentials" ||
						r.PostForm.Get("client_id") != "app" || r.PostForm.Get("client_secret") != "secret" {
						t.Errorf("client credentials not transmitted correctly: %s %v", r.URL, r.PostForm)
					}
				}
				_, _ = w.Write([]byte(`{"access_token":"platform-token","expires_in":"3600"}`))
			})
			for i := 0; i < 2; i++ {
				token, err := tc.backend.accessToken(context.Background())
				if err != nil || token != "platform-token" {
					t.Fatalf("token %d: %q, %v", i, token, err)
				}
			}
			if requests != 1 {
				t.Fatalf("fresh platform token should be cached, requests=%d", requests)
			}
		})
	}
}

func TestBackendTransportFailuresDoNotReturnSecrets(t *testing.T) {
	old := httpClient
	httpClient = &http.Client{Transport: backendRoundTrip(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("offline")
	})}
	t.Cleanup(func() { httpClient = old })
	for _, tc := range []struct {
		name    string
		backend Backend
	}{
		{"vault", &vaultBackend{addr: "https://vault.example", token: "token", mount: "secret"}},
		{"infisical", &infisicalBackend{baseURL: "https://infisical.example", token: "token", projectID: "project"}},
		{"azure", &azureKeyVaultBackend{vaultURL: "https://vault.example", cache: oauthTokenCache{token: "token", expiresAt: time.Now().Add(time.Hour)}}},
		{"aws", &awsSecretsManagerBackend{region: "us-east-1", creds: &awsCredentials{accessKeyID: "id", secretAccessKey: "secret"}}},
		{"gcp", &gcpSecretManagerBackend{project: "project", cache: oauthTokenCache{token: "token", expiresAt: time.Now().Add(time.Hour)}}},
		{"custom", &customBackend{baseURL: "https://custom.example", token: "token"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			value, found, err := tc.backend.Get(context.Background(), "ref")
			if value != nil || found || err == nil || !strings.Contains(err.Error(), "unreachable") {
				t.Fatalf("transport failure must not return a secret: %q, %t, %v", value, found, err)
			}
		})
	}
}
