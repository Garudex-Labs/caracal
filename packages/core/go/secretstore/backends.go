// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// External SecretBackend read clients: Vault, Infisical, Azure Key Vault, AWS Secrets Manager, Google Secret Manager, and the custom REST contract.

package secretstore

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	requestTimeout  = 10 * time.Second
	tokenExpirySkew = time.Minute
)

var httpClient = &http.Client{Timeout: requestTimeout}

func requireEnv(name string) (string, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return "", fmt.Errorf("%s is required for the configured secret backend", name)
	}
	return value, nil
}

func statusError(operation string, status int) error {
	return fmt.Errorf("secret backend %s failed with status %d", operation, status)
}

// String-valued stores hold base64 payloads so arbitrary bytes survive every backend
// unchanged; the builtin backend stores raw bytes and never round-trips through this.
func decodeValue(value string) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, errors.New("secret backend returned an unexpected payload")
	}
	return decoded, nil
}

// FromEnv constructs the configured external backend. The builtin kind is rejected
// here because it is database-bound and constructed by the owning service.
func FromEnv(kind string) (Backend, error) {
	switch kind {
	case KindVault:
		return newVaultBackend()
	case KindInfisical:
		return newInfisicalBackend()
	case KindAzureKeyVault:
		return newAzureKeyVaultBackend()
	case KindAWSSecretsManager:
		return newAWSSecretsManagerBackend()
	case KindGCPSecretManager:
		return newGCPSecretManagerBackend()
	case KindCustom:
		return newCustomBackend()
	default:
		return nil, fmt.Errorf("secret backend %q is not an external backend", kind)
	}
}

type vaultBackend struct {
	addr      string
	token     string
	mount     string
	namespace string
}

func newVaultBackend() (Backend, error) {
	addr, err := requireEnv("CARACAL_VAULT_ADDR")
	if err != nil {
		return nil, err
	}
	token, err := requireEnv("CARACAL_VAULT_TOKEN")
	if err != nil {
		return nil, err
	}
	mount := strings.TrimSpace(os.Getenv("CARACAL_VAULT_MOUNT"))
	if mount == "" {
		mount = "secret"
	}
	return &vaultBackend{
		addr:      strings.TrimRight(addr, "/"),
		token:     token,
		mount:     mount,
		namespace: strings.TrimSpace(os.Getenv("CARACAL_VAULT_NAMESPACE")),
	}, nil
}

func (v *vaultBackend) Kind() string { return KindVault }

func (v *vaultBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.addr+"/v1/"+v.mount+"/data/"+ref, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("X-Vault-Token", v.token)
	if v.namespace != "" {
		req.Header.Set("X-Vault-Namespace", v.namespace)
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	var body struct {
		Data struct {
			Data struct {
				Value string `json:"value"`
			} `json:"data"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.Data.Data.Value == "" {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	value, err := decodeValue(body.Data.Data.Value)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

type infisicalBackend struct {
	baseURL     string
	token       string
	projectID   string
	environment string
	path        string
}

func newInfisicalBackend() (Backend, error) {
	token, err := requireEnv("CARACAL_INFISICAL_TOKEN")
	if err != nil {
		return nil, err
	}
	projectID, err := requireEnv("CARACAL_INFISICAL_PROJECT_ID")
	if err != nil {
		return nil, err
	}
	baseURL := strings.TrimSpace(os.Getenv("CARACAL_INFISICAL_URL"))
	if baseURL == "" {
		baseURL = "https://app.infisical.com"
	}
	environment := strings.TrimSpace(os.Getenv("CARACAL_INFISICAL_ENV"))
	if environment == "" {
		environment = "prod"
	}
	path := strings.TrimSpace(os.Getenv("CARACAL_INFISICAL_PATH"))
	if path == "" {
		path = "/"
	}
	return &infisicalBackend{
		baseURL:     strings.TrimRight(baseURL, "/"),
		token:       token,
		projectID:   projectID,
		environment: environment,
		path:        path,
	}, nil
}

func (i *infisicalBackend) Kind() string { return KindInfisical }

func (i *infisicalBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	name := strings.ReplaceAll(ref, "/", ".")
	query := url.Values{
		"workspaceId": {i.projectID},
		"environment": {i.environment},
		"secretPath":  {i.path},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, i.baseURL+"/api/v3/secrets/raw/"+name+"?"+query.Encode(), nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+i.token)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	var body struct {
		Secret struct {
			SecretValue string `json:"secretValue"`
		} `json:"secret"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.Secret.SecretValue == "" {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	value, err := decodeValue(body.Secret.SecretValue)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

type oauthTokenCache struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

func (c *oauthTokenCache) get(fetch func() (string, time.Duration, error)) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Now().Before(c.expiresAt) {
		return c.token, nil
	}
	token, ttl, err := fetch()
	if err != nil {
		return "", err
	}
	c.token = token
	c.expiresAt = time.Now().Add(ttl - tokenExpirySkew)
	return token, nil
}

type azureKeyVaultBackend struct {
	vaultURL     string
	tenantID     string
	clientID     string
	clientSecret string
	cache        oauthTokenCache
}

func newAzureKeyVaultBackend() (Backend, error) {
	vaultURL, err := requireEnv("CARACAL_AZURE_VAULT_URL")
	if err != nil {
		return nil, err
	}
	tenantID, err := requireEnv("CARACAL_AZURE_TENANT_ID")
	if err != nil {
		return nil, err
	}
	clientID, err := requireEnv("CARACAL_AZURE_CLIENT_ID")
	if err != nil {
		return nil, err
	}
	clientSecret, err := requireEnv("CARACAL_AZURE_CLIENT_SECRET")
	if err != nil {
		return nil, err
	}
	return &azureKeyVaultBackend{
		vaultURL:     strings.TrimRight(vaultURL, "/"),
		tenantID:     tenantID,
		clientID:     clientID,
		clientSecret: clientSecret,
	}, nil
}

func (a *azureKeyVaultBackend) Kind() string { return KindAzureKeyVault }

func (a *azureKeyVaultBackend) accessToken(ctx context.Context) (string, error) {
	return a.cache.get(func() (string, time.Duration, error) {
		form := url.Values{
			"grant_type":    {"client_credentials"},
			"client_id":     {a.clientID},
			"client_secret": {a.clientSecret},
			"scope":         {"https://vault.azure.net/.default"},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			"https://login.microsoftonline.com/"+a.tenantID+"/oauth2/v2.0/token",
			strings.NewReader(form.Encode()))
		if err != nil {
			return "", 0, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return fetchOAuthToken(req)
	})
}

func fetchOAuthToken(req *http.Request) (string, time.Duration, error) {
	res, err := httpClient.Do(req)
	if err != nil {
		return "", 0, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", 0, statusError("auth", res.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.AccessToken == "" {
		return "", 0, errors.New("secret backend auth returned no token")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	if ttl <= 0 {
		ttl = time.Hour
	}
	return body.AccessToken, ttl, nil
}

func (a *azureKeyVaultBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	token, err := a.accessToken(ctx)
	if err != nil {
		return nil, false, err
	}
	name := strings.ReplaceAll(ref, "/", "-")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.vaultURL+"/secrets/"+name+"?api-version=7.4", nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	var body struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.Value == "" {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	value, err := decodeValue(body.Value)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

type awsSecretsManagerBackend struct {
	region          string
	accessKeyID     string
	secretAccessKey string
	sessionToken    string
}

func newAWSSecretsManagerBackend() (Backend, error) {
	region := strings.TrimSpace(os.Getenv("CARACAL_AWS_REGION"))
	if region == "" {
		region = strings.TrimSpace(os.Getenv("AWS_REGION"))
	}
	if region == "" {
		return nil, errors.New("CARACAL_AWS_REGION or AWS_REGION is required for the configured secret backend")
	}
	accessKeyID, err := requireEnv("AWS_ACCESS_KEY_ID")
	if err != nil {
		return nil, err
	}
	secretAccessKey, err := requireEnv("AWS_SECRET_ACCESS_KEY")
	if err != nil {
		return nil, err
	}
	return &awsSecretsManagerBackend{
		region:          region,
		accessKeyID:     accessKeyID,
		secretAccessKey: secretAccessKey,
		sessionToken:    strings.TrimSpace(os.Getenv("AWS_SESSION_TOKEN")),
	}, nil
}

func (a *awsSecretsManagerBackend) Kind() string { return KindAWSSecretsManager }

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}

func (a *awsSecretsManagerBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	host := "secretsmanager." + a.region + ".amazonaws.com"
	payload, err := json.Marshal(map[string]string{"SecretId": ref})
	if err != nil {
		return nil, false, err
	}
	now := time.Now().UTC()
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	headers := map[string]string{
		"content-type": "application/x-amz-json-1.1",
		"host":         host,
		"x-amz-date":   amzDate,
		"x-amz-target": "secretsmanager.GetSecretValue",
	}
	if a.sessionToken != "" {
		headers["x-amz-security-token"] = a.sessionToken
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + headers[name] + "\n")
	}
	signedHeaders := strings.Join(names, ";")
	payloadHash := sha256.Sum256(payload)
	canonicalRequest := strings.Join([]string{
		"POST", "/", "", canonicalHeaders.String(), signedHeaders, hex.EncodeToString(payloadHash[:]),
	}, "\n")
	scope := dateStamp + "/" + a.region + "/secretsmanager/aws4_request"
	requestHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, hex.EncodeToString(requestHash[:])}, "\n")
	kDate := hmacSHA256([]byte("AWS4"+a.secretAccessKey), []byte(dateStamp))
	kRegion := hmacSHA256(kDate, []byte(a.region))
	kService := hmacSHA256(kRegion, []byte("secretsmanager"))
	kSigning := hmacSHA256(kService, []byte("aws4_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+host+"/", strings.NewReader(string(payload)))
	if err != nil {
		return nil, false, err
	}
	for name, value := range headers {
		if name != "host" {
			req.Header.Set(name, value)
		}
	}
	req.Header.Set("Authorization",
		"AWS4-HMAC-SHA256 Credential="+a.accessKeyID+"/"+scope+", SignedHeaders="+signedHeaders+", Signature="+signature)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	var body struct {
		Type         string `json:"__type"`
		SecretString string `json:"SecretString"`
	}
	if err := json.Unmarshal(raw, &body); err == nil && strings.Contains(body.Type, "ResourceNotFoundException") {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	if body.SecretString == "" {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	value, err := decodeValue(body.SecretString)
	if err != nil {
		return nil, false, err
	}
	return value, true, nil
}

type gcpSecretManagerBackend struct {
	project    string
	clientMail string
	privateKey *rsa.PrivateKey
	tokenURI   string
	cache      oauthTokenCache
}

func newGCPSecretManagerBackend() (Backend, error) {
	project, err := requireEnv("CARACAL_GCP_PROJECT")
	if err != nil {
		return nil, err
	}
	credentialsPath := strings.TrimSpace(os.Getenv("CARACAL_GCP_CREDENTIALS_FILE"))
	if credentialsPath == "" {
		credentialsPath = strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS"))
	}
	if credentialsPath == "" {
		return nil, errors.New("CARACAL_GCP_CREDENTIALS_FILE or GOOGLE_APPLICATION_CREDENTIALS is required for the configured secret backend")
	}
	raw, err := os.ReadFile(credentialsPath)
	if err != nil {
		return nil, fmt.Errorf("gcp credentials file: %w", err)
	}
	var account struct {
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if err := json.Unmarshal(raw, &account); err != nil || account.ClientEmail == "" || account.PrivateKey == "" {
		return nil, errors.New("GCP service account credentials file is missing client_email or private_key")
	}
	block, _ := pem.Decode([]byte(account.PrivateKey))
	if block == nil {
		return nil, errors.New("GCP service account private_key is not valid PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("gcp private key: %w", err)
	}
	rsaKey, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("GCP service account private_key is not an RSA key")
	}
	tokenURI := account.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}
	return &gcpSecretManagerBackend{
		project:    project,
		clientMail: account.ClientEmail,
		privateKey: rsaKey,
		tokenURI:   tokenURI,
	}, nil
}

func (g *gcpSecretManagerBackend) Kind() string { return KindGCPSecretManager }

func (g *gcpSecretManagerBackend) accessToken(ctx context.Context) (string, error) {
	return g.cache.get(func() (string, time.Duration, error) {
		now := time.Now().Unix()
		encode := func(part map[string]any) (string, error) {
			raw, err := json.Marshal(part)
			if err != nil {
				return "", err
			}
			return base64.RawURLEncoding.EncodeToString(raw), nil
		}
		header, err := encode(map[string]any{"alg": "RS256", "typ": "JWT"})
		if err != nil {
			return "", 0, err
		}
		claims, err := encode(map[string]any{
			"iss":   g.clientMail,
			"scope": "https://www.googleapis.com/auth/cloud-platform",
			"aud":   g.tokenURI,
			"iat":   now,
			"exp":   now + 3600,
		})
		if err != nil {
			return "", 0, err
		}
		signingInput := header + "." + claims
		digest := sha256.Sum256([]byte(signingInput))
		signature, err := rsa.SignPKCS1v15(nil, g.privateKey, crypto.SHA256, digest[:])
		if err != nil {
			return "", 0, err
		}
		form := url.Values{
			"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
			"assertion":  {signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.tokenURI, strings.NewReader(form.Encode()))
		if err != nil {
			return "", 0, err
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		return fetchOAuthToken(req)
	})
}

func (g *gcpSecretManagerBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	token, err := g.accessToken(ctx)
	if err != nil {
		return nil, false, err
	}
	name := strings.ReplaceAll(ref, "/", "-")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://secretmanager.googleapis.com/v1/projects/"+g.project+"/secrets/"+name+"/versions/latest:access", nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	var body struct {
		Payload struct {
			Data string `json:"data"`
		} `json:"payload"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil || body.Payload.Data == "" {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	value, err := base64.StdEncoding.DecodeString(body.Payload.Data)
	if err != nil {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	return value, true, nil
}

type customBackend struct {
	baseURL string
	token   string
}

func newCustomBackend() (Backend, error) {
	baseURL, err := requireEnv("CARACAL_CUSTOM_SECRETS_URL")
	if err != nil {
		return nil, err
	}
	token, err := requireEnv("CARACAL_CUSTOM_SECRETS_TOKEN")
	if err != nil {
		return nil, err
	}
	return &customBackend{baseURL: strings.TrimRight(baseURL, "/"), token: token}, nil
}

func (c *customBackend) Kind() string { return KindCustom }

func (c *customBackend) Get(ctx context.Context, ref string) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/secrets/"+ref, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, false, errors.New("secret backend unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, false, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, false, statusError("read", res.StatusCode)
	}
	value, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, false, errors.New("secret backend returned an unexpected payload")
	}
	return value, true, nil
}
