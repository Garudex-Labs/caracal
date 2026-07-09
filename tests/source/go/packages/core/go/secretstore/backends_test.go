// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Unit tests for the external secret backend clients: Vault, Infisical, Azure, AWS, GCP, and custom, plus their auth flows.

package secretstore

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHTTPSBaseURL(t *testing.T) {
	if _, err := httpsBaseURL("NAME", "http://[::1"); err == nil {
		t.Error("malformed URLs must be rejected")
	}
	if _, err := httpsBaseURL("NAME", "http://vault.internal:8200"); err == nil {
		t.Error("plain http to a routable host must be rejected")
	}
	for _, raw := range []string{"http://localhost:8200", "http://127.0.0.1:8200", "http://[::1]:8200"} {
		if _, err := httpsBaseURL("NAME", raw); err != nil {
			t.Errorf("loopback %q must be allowed: %v", raw, err)
		}
	}
	base, err := httpsBaseURL("NAME", "https://vault.example/")
	if err != nil || base != "https://vault.example" {
		t.Errorf("trailing slashes must be trimmed: %q %v", base, err)
	}
}

func TestDecodeValueRejectsInvalidBase64(t *testing.T) {
	if _, err := decodeValue("!!!not-base64!!!"); err == nil {
		t.Error("invalid base64 payloads must be rejected")
	}
}

func TestBackendKinds(t *testing.T) {
	vault := httptest.NewServer(http.NotFoundHandler())
	defer vault.Close()
	t.Setenv("CARACAL_VAULT_ADDR", vault.URL)
	t.Setenv("CARACAL_VAULT_TOKEN", "tok")
	t.Setenv("CARACAL_INFISICAL_URL", vault.URL)
	t.Setenv("CARACAL_INFISICAL_TOKEN", "tok")
	t.Setenv("CARACAL_INFISICAL_PROJECT_ID", "proj")
	t.Setenv("CARACAL_AZURE_VAULT_URL", vault.URL)
	t.Setenv("CARACAL_AZURE_CLIENT_SECRET", "")
	t.Setenv("CARACAL_AWS_REGION", "eu-west-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "sk")
	t.Setenv("CARACAL_GCP_PROJECT", "proj")
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	t.Setenv("CARACAL_CUSTOM_SECRETS_URL", vault.URL)
	t.Setenv("CARACAL_CUSTOM_SECRETS_TOKEN", "tok")
	for _, kind := range []string{KindVault, KindInfisical, KindAzureKeyVault, KindAWSSecretsManager, KindGCPSecretManager, KindCustom} {
		backend, err := FromEnv(kind)
		if err != nil {
			t.Fatalf("FromEnv(%q): %v", kind, err)
		}
		if backend.Kind() != kind {
			t.Errorf("FromEnv(%q).Kind() = %q", kind, backend.Kind())
		}
	}
}

func TestVaultBackendErrorPaths(t *testing.T) {
	sawNamespace := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Vault-Namespace") == "team-a" {
			sawNamespace = true
		}
		switch r.URL.Path {
		case "/v1/kv/data/refs/bad-payload":
			w.Write([]byte(`{"data":{}}`))
		case "/v1/kv/data/refs/bad-base64":
			w.Write([]byte(`{"data":{"data":{"value":"%%%"}}}`))
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	t.Setenv("CARACAL_VAULT_ADDR", server.URL)
	t.Setenv("CARACAL_VAULT_TOKEN", "tok")
	t.Setenv("CARACAL_VAULT_MOUNT", "kv")
	t.Setenv("CARACAL_VAULT_NAMESPACE", "team-a")
	backend, err := FromEnv(KindVault)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := backend.Get(context.Background(), "refs/boom"); err == nil || !strings.Contains(err.Error(), "status 500") {
		t.Errorf("upstream 500 must surface a status error, got %v", err)
	}
	if _, _, err := backend.Get(context.Background(), "refs/bad-payload"); err == nil || !strings.Contains(err.Error(), "unexpected payload") {
		t.Errorf("missing value must surface a payload error, got %v", err)
	}
	if _, _, err := backend.Get(context.Background(), "refs/bad-base64"); err == nil || !strings.Contains(err.Error(), "unexpected payload") {
		t.Errorf("invalid base64 must surface a payload error, got %v", err)
	}
	if !sawNamespace {
		t.Error("the configured vault namespace header must be sent")
	}
}

func TestVaultBackendUnreachable(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	t.Setenv("CARACAL_VAULT_ADDR", server.URL)
	t.Setenv("CARACAL_VAULT_TOKEN", "tok")
	t.Setenv("CARACAL_VAULT_MOUNT", "")
	t.Setenv("CARACAL_VAULT_NAMESPACE", "")
	backend, err := FromEnv(KindVault)
	if err != nil {
		t.Fatal(err)
	}
	server.Close()
	if _, _, err := backend.Get(context.Background(), "ref"); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("connection failures must surface as unreachable, got %v", err)
	}
}

func TestInfisicalBackendConstructorDefaults(t *testing.T) {
	t.Setenv("CARACAL_INFISICAL_TOKEN", "tok")
	t.Setenv("CARACAL_INFISICAL_PROJECT_ID", "proj-1")
	t.Setenv("CARACAL_INFISICAL_URL", "")
	t.Setenv("CARACAL_INFISICAL_ENV", "")
	t.Setenv("CARACAL_INFISICAL_PATH", "")
	backend, err := newInfisicalBackend()
	if err != nil {
		t.Fatal(err)
	}
	infisical := backend.(*infisicalBackend)
	if infisical.baseURL != "https://app.infisical.com" || infisical.environment != "prod" || infisical.path != "/" {
		t.Errorf("defaults not applied: %+v", infisical)
	}
	t.Setenv("CARACAL_INFISICAL_URL", "http://app.internal")
	if _, err := newInfisicalBackend(); err == nil {
		t.Error("plain http to a routable infisical host must be rejected")
	}
	t.Setenv("CARACAL_INFISICAL_URL", "https://infisical.example")
	t.Setenv("CARACAL_INFISICAL_PROJECT_ID", "")
	if _, err := newInfisicalBackend(); err == nil {
		t.Error("a missing project id must be rejected")
	}
}

func TestInfisicalBackendGet(t *testing.T) {
	payload := base64.StdEncoding.EncodeToString([]byte("infisical-secret"))
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		gotQuery = r.URL.Query()
		switch r.URL.Path {
		case "/api/v3/secrets/raw/zones.z1.providers.p1.secretConfig":
			w.Write([]byte(`{"secret":{"secretValue":"` + payload + `"}}`))
		case "/api/v3/secrets/raw/zones.z1.providers.bad.secretConfig":
			w.Write([]byte(`{"secret":{}}`))
		case "/api/v3/secrets/raw/zones.z1.providers.boom.secretConfig":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	t.Setenv("CARACAL_INFISICAL_URL", server.URL)
	t.Setenv("CARACAL_INFISICAL_TOKEN", "tok")
	t.Setenv("CARACAL_INFISICAL_PROJECT_ID", "proj-1")
	t.Setenv("CARACAL_INFISICAL_ENV", "staging")
	t.Setenv("CARACAL_INFISICAL_PATH", "/caracal")
	backend, err := FromEnv(KindInfisical)
	if err != nil {
		t.Fatal(err)
	}
	value, found, err := backend.Get(context.Background(), "zones/z1/providers/p1/secretConfig")
	if err != nil || !found || string(value) != "infisical-secret" {
		t.Fatalf("get: %q %v %v", value, found, err)
	}
	if gotQuery.Get("workspaceId") != "proj-1" || gotQuery.Get("environment") != "staging" || gotQuery.Get("secretPath") != "/caracal" {
		t.Errorf("project scoping query not sent: %v", gotQuery)
	}
	if _, found, err := backend.Get(context.Background(), "zones/z1/providers/gone/secretConfig"); found || err != nil {
		t.Fatalf("missing ref: %v %v", found, err)
	}
	if _, _, err := backend.Get(context.Background(), "zones/z1/providers/bad/secretConfig"); err == nil || !strings.Contains(err.Error(), "unexpected payload") {
		t.Errorf("empty secret value must surface a payload error, got %v", err)
	}
	if _, _, err := backend.Get(context.Background(), "zones/z1/providers/boom/secretConfig"); err == nil || !strings.Contains(err.Error(), "status 500") {
		t.Errorf("upstream 500 must surface a status error, got %v", err)
	}
}

func TestAzureKeyVaultBackendConstructor(t *testing.T) {
	t.Setenv("CARACAL_AZURE_VAULT_URL", "")
	if _, err := newAzureKeyVaultBackend(); err == nil {
		t.Error("a missing vault URL must be rejected")
	}
	t.Setenv("CARACAL_AZURE_VAULT_URL", "http://vault.azure.internal")
	if _, err := newAzureKeyVaultBackend(); err == nil {
		t.Error("plain http to a routable vault host must be rejected")
	}
	t.Setenv("CARACAL_AZURE_VAULT_URL", "https://vault.example")
	t.Setenv("CARACAL_AZURE_CLIENT_SECRET", "s3cret")
	t.Setenv("CARACAL_AZURE_TENANT_ID", "")
	if _, err := newAzureKeyVaultBackend(); err == nil {
		t.Error("a client secret without a tenant id must be rejected")
	}
	t.Setenv("CARACAL_AZURE_TENANT_ID", "tenant-1")
	t.Setenv("CARACAL_AZURE_CLIENT_ID", "")
	if _, err := newAzureKeyVaultBackend(); err == nil {
		t.Error("a client secret without a client id must be rejected")
	}
	t.Setenv("CARACAL_AZURE_CLIENT_ID", "client-1")
	backend, err := newAzureKeyVaultBackend()
	if err != nil {
		t.Fatal(err)
	}
	azure := backend.(*azureKeyVaultBackend)
	if azure.tenantID != "tenant-1" || azure.clientID != "client-1" || azure.clientSecret != "s3cret" {
		t.Errorf("client credential configuration not captured: %+v", azure)
	}
	t.Setenv("CARACAL_AZURE_CLIENT_SECRET", "")
	backend, err = newAzureKeyVaultBackend()
	if err != nil {
		t.Fatal(err)
	}
	if backend.(*azureKeyVaultBackend).clientSecret != "" {
		t.Error("without a client secret the backend must fall back to managed identity")
	}
}

func TestFetchOAuthToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/numeric":
			w.Write([]byte(`{"access_token":"tok-1","expires_in":1800}`))
		case "/string":
			w.Write([]byte(`{"access_token":"tok-2","expires_in":"900"}`))
		case "/none":
			w.Write([]byte(`{"access_token":"tok-3"}`))
		case "/empty":
			w.Write([]byte(`{}`))
		default:
			w.WriteHeader(http.StatusForbidden)
		}
	}))
	defer server.Close()
	request := func(path string) *http.Request {
		req, err := http.NewRequest(http.MethodGet, server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		return req
	}
	token, ttl, err := fetchOAuthToken(request("/numeric"))
	if err != nil || token != "tok-1" || ttl != 1800*time.Second {
		t.Errorf("numeric expires_in: %q %v %v", token, ttl, err)
	}
	token, ttl, err = fetchOAuthToken(request("/string"))
	if err != nil || token != "tok-2" || ttl != 900*time.Second {
		t.Errorf("string expires_in (IMDS shape): %q %v %v", token, ttl, err)
	}
	token, ttl, err = fetchOAuthToken(request("/none"))
	if err != nil || token != "tok-3" || ttl != time.Hour {
		t.Errorf("absent expires_in must default to an hour: %q %v %v", token, ttl, err)
	}
	if _, _, err := fetchOAuthToken(request("/empty")); err == nil || !strings.Contains(err.Error(), "no token") {
		t.Errorf("a response without a token must be rejected, got %v", err)
	}
	if _, _, err := fetchOAuthToken(request("/denied")); err == nil || !strings.Contains(err.Error(), "auth failed with status 403") {
		t.Errorf("a non-200 auth response must surface a status error, got %v", err)
	}
	server.Close()
	if _, _, err := fetchOAuthToken(request("/numeric")); err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Errorf("connection failures must surface as unreachable, got %v", err)
	}
}

func TestOAuthTokenCache(t *testing.T) {
	cache := &oauthTokenCache{}
	calls := 0
	fetch := func() (string, time.Duration, error) {
		calls++
		return "tok", time.Hour, nil
	}
	for i := 0; i < 3; i++ {
		token, err := cache.get(fetch)
		if err != nil || token != "tok" {
			t.Fatalf("get %d: %q %v", i, token, err)
		}
	}
	if calls != 1 {
		t.Errorf("a live token must be reused, got %d fetches", calls)
	}
	expired := &oauthTokenCache{token: "stale", expiresAt: time.Now().Add(-time.Minute)}
	if token, err := expired.get(fetch); err != nil || token != "tok" {
		t.Errorf("an expired token must be refetched: %q %v", token, err)
	}
	failing := &oauthTokenCache{}
	if _, err := failing.get(func() (string, time.Duration, error) {
		return "", 0, os.ErrDeadlineExceeded
	}); err == nil {
		t.Error("fetch failures must propagate")
	}
}

func TestAWSSecretsManagerConstructor(t *testing.T) {
	for _, env := range []string{
		"CARACAL_AWS_REGION", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	} {
		t.Setenv(env, "")
	}
	if _, err := newAWSSecretsManagerBackend(); err == nil {
		t.Error("a missing region must be rejected")
	}
	t.Setenv("AWS_REGION", "us-east-1")
	if _, err := newAWSSecretsManagerBackend(); err == nil {
		t.Error("missing credentials must be rejected")
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	if _, err := newAWSSecretsManagerBackend(); err == nil {
		t.Error("an access key without its secret must be rejected")
	}
	t.Setenv("AWS_SECRET_ACCESS_KEY", "sk")
	t.Setenv("AWS_SESSION_TOKEN", "st")
	backend, err := newAWSSecretsManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	aws := backend.(*awsSecretsManagerBackend)
	if aws.region != "us-east-1" || aws.creds == nil || aws.creds.accessKeyID != "AKID" || aws.creds.sessionToken != "st" {
		t.Errorf("static credentials not captured: %+v", aws.creds)
	}
	creds, err := aws.credentials(context.Background())
	if err != nil || creds.secretAccessKey != "sk" {
		t.Errorf("static credentials must be served without a network call: %+v %v", creds, err)
	}
	t.Setenv("CARACAL_AWS_REGION", "eu-central-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/creds")
	backend, err = newAWSSecretsManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	aws = backend.(*awsSecretsManagerBackend)
	if aws.region != "eu-central-1" || aws.containerCredentialsURL != "http://169.254.170.2/v2/creds" {
		t.Errorf("relative container endpoint not derived: %q %q", aws.region, aws.containerCredentialsURL)
	}
}

func TestAWSContainerCredentials(t *testing.T) {
	requests := 0
	var gotAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		gotAuthorization = r.Header.Get("Authorization")
		w.Write([]byte(`{"AccessKeyId":"AKID","SecretAccessKey":"sk","Token":"st","Expiration":"` +
			time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
	}))
	defer server.Close()
	for _, env := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE"} {
		t.Setenv(env, "")
	}
	t.Setenv("CARACAL_AWS_REGION", "us-east-1")
	t.Setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", server.URL)
	t.Setenv("AWS_CONTAINER_AUTHORIZATION_TOKEN", "Bearer pod-token")
	backend, err := newAWSSecretsManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	aws := backend.(*awsSecretsManagerBackend)
	creds, err := aws.credentials(context.Background())
	if err != nil || creds.accessKeyID != "AKID" || creds.secretAccessKey != "sk" || creds.sessionToken != "st" {
		t.Fatalf("credentials: %+v %v", creds, err)
	}
	if gotAuthorization != "Bearer pod-token" {
		t.Errorf("the platform authorization token must be forwarded, got %q", gotAuthorization)
	}
	if _, err := aws.credentials(context.Background()); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Errorf("unexpired credentials must be reused, got %d endpoint reads", requests)
	}
}

func TestAWSContainerCredentialsTokenFileAndFailures(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("Bearer file-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var gotAuthorization string
	failing := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		if failing {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.Write([]byte(`{"AccessKeyId":"","SecretAccessKey":""}`))
	}))
	defer server.Close()
	for _, env := range []string{"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CONTAINER_AUTHORIZATION_TOKEN"} {
		t.Setenv(env, "")
	}
	t.Setenv("CARACAL_AWS_REGION", "us-east-1")
	t.Setenv("AWS_CONTAINER_CREDENTIALS_FULL_URI", server.URL)
	t.Setenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", tokenFile)
	backend, err := newAWSSecretsManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	aws := backend.(*awsSecretsManagerBackend)
	if _, err := aws.credentials(context.Background()); err == nil || !strings.Contains(err.Error(), "auth failed with status 403") {
		t.Errorf("a denied credentials read must surface a status error, got %v", err)
	}
	if gotAuthorization != "Bearer file-token" {
		t.Errorf("the token file contents must be forwarded, got %q", gotAuthorization)
	}
	failing = false
	if _, err := aws.credentials(context.Background()); err == nil || !strings.Contains(err.Error(), "no credentials") {
		t.Errorf("a response without keys must be rejected, got %v", err)
	}
	t.Setenv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", filepath.Join(t.TempDir(), "missing"))
	if _, err := aws.credentials(context.Background()); err == nil || !strings.Contains(err.Error(), "token file") {
		t.Errorf("an unreadable token file must be rejected, got %v", err)
	}
}

func TestHMACSHA256(t *testing.T) {
	// RFC 4231 test case 2.
	got := hex.EncodeToString(hmacSHA256([]byte("Jefe"), []byte("what do ya want for nothing?")))
	want := "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
	if got != want {
		t.Errorf("hmacSHA256 = %s, want %s", got, want)
	}
}

func writeGCPCredentials(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sa.json")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func gcpServiceAccountJSON(t *testing.T, key *rsa.PrivateKey, tokenURI string) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	account := map[string]string{
		"client_email": "sa@proj.iam.gserviceaccount.example",
		"private_key":  pemKey,
	}
	if tokenURI != "" {
		account["token_uri"] = tokenURI
	}
	raw, err := json.Marshal(account)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestGCPSecretManagerConstructor(t *testing.T) {
	t.Setenv("CARACAL_GCP_PROJECT", "")
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", "")
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
	if _, err := newGCPSecretManagerBackend(); err == nil {
		t.Error("a missing project must be rejected")
	}
	t.Setenv("CARACAL_GCP_PROJECT", "proj-1")
	backend, err := newGCPSecretManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	if backend.(*gcpSecretManagerBackend).privateKey != nil {
		t.Error("without a credentials file the backend must use the metadata server flow")
	}
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", filepath.Join(t.TempDir(), "missing.json"))
	if _, err := newGCPSecretManagerBackend(); err == nil || !strings.Contains(err.Error(), "credentials file") {
		t.Errorf("an unreadable credentials file must be rejected, got %v", err)
	}
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", writeGCPCredentials(t, `{"client_email":"sa@example"}`))
	if _, err := newGCPSecretManagerBackend(); err == nil || !strings.Contains(err.Error(), "client_email or private_key") {
		t.Errorf("a credentials file without a key must be rejected, got %v", err)
	}
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", writeGCPCredentials(t, `{"client_email":"sa@example","private_key":"not-pem"}`))
	if _, err := newGCPSecretManagerBackend(); err == nil || !strings.Contains(err.Error(), "not valid PEM") {
		t.Errorf("a non-PEM key must be rejected, got %v", err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ecDER, err := x509.MarshalPKCS8PrivateKey(ecKey)
	if err != nil {
		t.Fatal(err)
	}
	ecPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: ecDER}))
	ecJSON, err := json.Marshal(map[string]string{"client_email": "sa@example", "private_key": ecPEM})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", writeGCPCredentials(t, string(ecJSON)))
	if _, err := newGCPSecretManagerBackend(); err == nil || !strings.Contains(err.Error(), "not an RSA key") {
		t.Errorf("a non-RSA key must be rejected, got %v", err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", writeGCPCredentials(t, gcpServiceAccountJSON(t, rsaKey, "")))
	backend, err = newGCPSecretManagerBackend()
	if err != nil {
		t.Fatal(err)
	}
	gcp := backend.(*gcpSecretManagerBackend)
	if gcp.tokenURI != "https://oauth2.googleapis.com/token" || gcp.clientMail != "sa@proj.iam.gserviceaccount.example" {
		t.Errorf("service account fields not captured: %q %q", gcp.tokenURI, gcp.clientMail)
	}
}

func TestGCPServiceAccountTokenFlow(t *testing.T) {
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tokenRequests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tokenRequests++
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.PostForm.Get("grant_type") != "urn:ietf:params:oauth:grant-type:jwt-bearer" {
			t.Errorf("unexpected grant type %q", r.PostForm.Get("grant_type"))
		}
		parts := strings.Split(r.PostForm.Get("assertion"), ".")
		if len(parts) != 3 {
			t.Fatalf("assertion is not a JWT: %q", r.PostForm.Get("assertion"))
		}
		claimsRaw, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Fatal(err)
		}
		var claims struct {
			Iss   string `json:"iss"`
			Scope string `json:"scope"`
			Aud   string `json:"aud"`
		}
		if err := json.Unmarshal(claimsRaw, &claims); err != nil {
			t.Fatal(err)
		}
		if claims.Iss != "sa@proj.iam.gserviceaccount.example" || claims.Scope != "https://www.googleapis.com/auth/cloud-platform" {
			t.Errorf("unexpected claims: %+v", claims)
		}
		signature, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err := rsa.VerifyPKCS1v15(&rsaKey.PublicKey, crypto.SHA256, digest[:], signature); err != nil {
			t.Errorf("assertion signature must verify with the service account key: %v", err)
		}
		w.Write([]byte(`{"access_token":"gcp-token","expires_in":3600}`))
	}))
	defer server.Close()
	t.Setenv("CARACAL_GCP_PROJECT", "proj-1")
	t.Setenv("CARACAL_GCP_CREDENTIALS_FILE", writeGCPCredentials(t, gcpServiceAccountJSON(t, rsaKey, server.URL)))
	backend, err := FromEnv(KindGCPSecretManager)
	if err != nil {
		t.Fatal(err)
	}
	gcp := backend.(*gcpSecretManagerBackend)
	token, err := gcp.accessToken(context.Background())
	if err != nil || token != "gcp-token" {
		t.Fatalf("access token: %q %v", token, err)
	}
	if token, err := gcp.accessToken(context.Background()); err != nil || token != "gcp-token" {
		t.Fatalf("cached access token: %q %v", token, err)
	}
	if tokenRequests != 1 {
		t.Errorf("a live token must be reused, got %d token requests", tokenRequests)
	}
}
