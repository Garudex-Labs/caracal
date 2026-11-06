// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
package internal

import (
	"context"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestKeyMaterialCacheTracksAuthoritativeMembershipAndEnvelope(t *testing.T) {
	keys, db, _ := signingKeyCache(t)
	peer := newKeyCache(db, testKeyring(signingZEK()))
	old, _, err := issueToken(context.Background(), IssueParams{ZoneID: "zone", Use: UseSession, TTL: time.Hour}, keys, "https://sts.test")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{keys: peer, cfg: Config{IssuerURL: "https://sts.test"}}
	if _, err := s.validateSubjectToken(context.Background(), old, "zone"); err != nil {
		t.Fatal(err)
	}
	first := db.secrets[0]
	second := sealedSecret(t, signingZEK(), "second", []byte(ecKeyPEM(t, elliptic.P256())))
	db.secrets = []SecretRow{second, first}
	fresh, _, err := issueToken(context.Background(), IssueParams{ZoneID: "zone", Use: UseSession, TTL: time.Hour}, keys, s.cfg.IssuerURL)
	if err != nil {
		t.Fatal(err)
	}
	// No invalidation message is delivered to the peer.
	for _, token := range []string{old, fresh} {
		if _, err := s.validateSubjectToken(context.Background(), token, "zone"); err != nil {
			t.Fatalf("active/grace signature: %v", err)
		}
	}
	db.secrets = []SecretRow{second}
	if _, err := s.validateSubjectToken(context.Background(), old, "zone"); err == nil {
		t.Fatal("retired key remained trusted")
	}
	db.secrets[0].Envelope = []byte("changed under the same kid")
	if _, _, err := keys.getKeyAndKid(context.Background(), "zone"); err == nil {
		t.Fatal("same kid hid replaced ciphertext")
	}
	if _, err := s.validateSubjectToken(context.Background(), fresh, "zone"); err == nil {
		t.Fatal("verification trusted cached tampered material")
	}
	db.secretsErr = errors.New("storage unavailable")
	if _, err := s.validateSubjectToken(context.Background(), fresh, "zone"); err == nil {
		t.Fatal("storage error must fail closed")
	}
}

func TestSigningKeyRequiresP256(t *testing.T) {
	db := &stubDB{secrets: []SecretRow{sealedSecret(t, signingZEK(), "wrong-curve", []byte(ecKeyPEM(t, elliptic.P384())))}}
	keys := newKeyCache(db, testKeyring(signingZEK()))
	if _, _, err := keys.getKeyAndKid(context.Background(), "zone"); err == nil {
		t.Fatal("ES256 cannot use P384")
	}
	if _, err := keys.getPublicKeysByZone(context.Background(), "zone"); err == nil {
		t.Fatal("JWKS must not label P384 as P256")
	}
}

func TestQueuedSecretVerificationRechecksSuccessfulPeer(t *testing.T) {
	hash, err := hashClientSecret("correct")
	if err != nil {
		t.Fatal(err)
	}
	var cache verifiedSecretCache
	cache.configure(1)
	held, ok := cache.acquireSlot(context.Background())
	if !ok {
		t.Fatal("slot")
	}
	result := make(chan bool, 1)
	go func() { result <- cache.verify(context.Background(), hash, "correct") }()
	// The worker cannot derive while its only slot is held. Verify with another
	// cache then copy the successful result, exactly as a completing peer would.
	var peer verifiedSecretCache
	if !peer.verify(context.Background(), hash, "correct") {
		t.Fatal("peer")
	}
	cache.mu.Lock()
	cache.entries = map[string]verifiedSecretEntry{hash: peer.entries[hash]}
	cache.mu.Unlock()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	<-held
	if !<-result {
		t.Fatal("queued correct credential rejected")
	}
	runtime.ReadMemStats(&after)
	if after.TotalAlloc-before.TotalAlloc > 8*1024*1024 {
		t.Fatal("queued hit ran a redundant 64 MiB derivation")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if cache.verify(ctx, hash, "correct") {
		t.Fatal("cancelled warm request authenticated")
	}
	if cache.verify(context.Background(), hash, "wrong") {
		t.Fatal("peer success admitted another secret")
	}
}

func TestMalformedArgonHashCannotReduceVerificationStrength(t *testing.T) {
	full, err := hashClientSecret("correct")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(full, "$")
	want, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	for _, short := range []string{parts[0] + "$" + parts[1] + "$" + base64.RawStdEncoding.EncodeToString(want[:1]), parts[0] + "$" + base64.RawStdEncoding.EncodeToString([]byte{1}) + "$" + parts[2]} {
		var cache verifiedSecretCache
		if cache.verify(context.Background(), short, "correct") {
			t.Fatal("noncanonical hash accepted")
		}
	}
}

func TestKeyCacheConcurrentReadAndInvalidation(t *testing.T) {
	keys, _, _ := signingKeyCache(t)
	var wg sync.WaitGroup
	for j := 0; j < 16; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				if _, _, err := keys.getKeyAndKid(context.Background(), "zone"); err != nil {
					t.Error(err)
				}
				if _, err := keys.getPublicKeysByZone(context.Background(), "zone"); err != nil {
					t.Error(err)
				}
				keys.Invalidate("zone")
			}
		}()
	}
	wg.Wait()
}

func TestSubjectSignatureAndClaimGuardsWithWarmKeys(t *testing.T) {
	keys, _, pem := signingKeyCache(t)
	priv, err := jwt.ParseECPrivateKeyFromPEM([]byte(pem))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{keys: keys, cfg: Config{IssuerURL: "https://sts.test"}}
	for _, name := range []string{"valid", "expired", "future", "issuer", "audience", "zone", "use", "no-exp", "no-kid", "wrong-alg"} {
		t.Run(name, func(t *testing.T) {
			claims := jwt.MapClaims{"iss": s.cfg.IssuerURL, "aud": s.cfg.IssuerURL, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "zone_id": "zone", "use": UseSession}
			method := jwt.SigningMethod(jwt.SigningMethodES256)
			key := any(priv)
			switch name {
			case "expired":
				claims["exp"] = time.Now().Add(-2 * time.Minute).Unix()
			case "future":
				claims["iat"] = time.Now().Add(2 * time.Minute).Unix()
			case "issuer":
				claims["iss"] = "evil"
			case "audience":
				claims["aud"] = "resource"
			case "zone":
				claims["zone_id"] = "other"
			case "use":
				claims["use"] = UseResource
			case "no-exp":
				delete(claims, "exp")
			case "wrong-alg":
				method = jwt.SigningMethodHS256
				key = []byte("not-a-signing-key")
			}
			token := jwt.NewWithClaims(method, claims)
			if name != "no-kid" {
				token.Header["kid"] = "kid-active"
			}
			signed, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			_, err = s.validateSubjectToken(context.Background(), signed, "zone")
			if (err == nil) != (name == "valid") {
				t.Fatalf("validation error=%v", err)
			}
		})
	}
}

func TestProviderTransportReusesConnectionsWithoutCredentialCrossover(t *testing.T) {
	var accepted atomic.Int64
	var oversized atomic.Bool
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client, secret, ok := r.BasicAuth()
		if !ok || client != "client" || (secret != "first" && secret != "rotated") {
			t.Error("request credential mismatch")
		}
		_, _ = io.Copy(io.Discard, r.Body)
		_ = r.Body.Close()
		_, _ = io.WriteString(w, `{"access_token":"fixture","token_type":"Bearer","expires_in":60}`)
		if oversized.Load() {
			_, _ = io.WriteString(w, strings.Repeat(" ", providerMaxBodyBytes+1))
		}
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			accepted.Add(1)
		}
	}
	privateHost := privateTestHost(t)
	_ = server.Listener.Close()
	listener, err := net.Listen("tcp", net.JoinHostPort(privateHost, "0"))
	if err != nil {
		t.Fatal(err)
	}
	server.Listener = listener
	server.StartTLS()
	defer server.Close()
	s := &Server{cfg: Config{PrivateEgressHosts: []string{privateHost}}}
	s.providerHTTPOnce.Do(func() {
		s.providerHTTPClient = safeHTTPClient(time.Second, s.cfg.PrivateEgressHosts)
		transport := s.providerHTTPClient.Transport.(*http.Transport)
		roots := x509.NewCertPool()
		roots.AddCert(server.Certificate())
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12, ServerName: server.Certificate().DNSNames[0]}
	})
	defer s.providerHTTPClient.CloseIdleConnections()
	endpoint, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"first", "rotated"} {
		if _, err := s.refreshProviderToken(context.Background(), "provider", endpoint, url.Values{"grant_type": {"client_credentials"}}, "client", secret, "client_secret_basic", "", "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if accepted.Load() != 1 {
		t.Fatalf("expected one reused TLS connection, got %d", accepted.Load())
	}
	oversized.Store(true)
	if _, err := s.refreshProviderToken(context.Background(), "provider", endpoint, url.Values{}, "client", "rotated", "client_secret_basic", "", "", ""); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatal("oversized provider response accepted", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.refreshProviderToken(ctx, "provider", endpoint, url.Values{}, "client", "rotated", "client_secret_basic", "", "", ""); err == nil {
		t.Fatal("cancelled provider request succeeded")
	}
}

func TestMultiHopChainBindsImmediateIssuerAndSessionContinuity(t *testing.T) {
	now := time.Now()
	root := &DelegationEdge{ID: "root", ZoneID: "zone", SourceSessionID: "root-session", TargetSessionID: "source", IssuerAppID: "root-app", ReceiverAppID: "app", Status: "active", ExpiresAt: now.Add(time.Hour)}
	leaf := &DelegationEdge{ID: "leaf", ZoneID: "zone", SourceSessionID: "source", TargetSessionID: "target", IssuerAppID: "app", ReceiverAppID: "receiver", Status: "active", ExpiresAt: now.Add(time.Hour)}
	s := &Server{db: &stubDB{edgesMap: map[string]*DelegationEdge{"root": root}}}
	source, target := &Session{ID: "source", ApplicationID: "app"}, &Session{ID: "target", ApplicationID: "receiver"}
	chain, _, err := s.buildDelegationChain(context.Background(), []string{"root", "leaf"}, leaf, source, target, now)
	if err != nil || len(chain) != 3 || chain[0].AppID != "root-app" {
		t.Fatalf("valid multi-hop path rejected: %v", err)
	}
	root.TargetSessionID = "other-session"
	if _, _, err := s.buildDelegationChain(context.Background(), []string{"root", "leaf"}, leaf, source, target, now); err == nil {
		t.Fatal("same-application session discontinuity accepted")
	}
}

func TestKeyMaterialCachesAreBounded(t *testing.T) {
	keys, _, _ := signingKeyCache(t)
	for i := 0; i < keyCacheMaxZones; i++ {
		zone := fmt.Sprint(i)
		keys.entries[zone] = &zoneCacheEntry{}
		keys.pubKeysCache[zone] = &publicKeysCacheEntry{}
	}
	if _, _, err := keys.getKeyAndKid(context.Background(), "new-zone"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.getPublicKeysByZone(context.Background(), "new-zone"); err != nil {
		t.Fatal(err)
	}
	if len(keys.entries) > keyCacheMaxZones || len(keys.pubKeysCache) > keyCacheMaxZones {
		t.Fatal("key material cache exceeded its bound")
	}
}

func TestGatewayMandateRequiresReplayIdentifier(t *testing.T) {
	keys, _, pem := signingKeyCache(t)
	priv, err := jwt.ParseECPrivateKeyFromPEM([]byte(pem))
	if err != nil {
		t.Fatal(err)
	}
	claims := jwt.MapClaims{"iss": "https://sts.test", "aud": "https://sts.test", "exp": time.Now().Add(time.Hour).Unix(), "zone_id": "zone", "use": UseGateway}
	token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
	token.Header["kid"] = "kid-active"
	signed, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{keys: keys, cfg: Config{IssuerURL: "https://sts.test"}}
	if _, err := s.validateSubjectTokenUse(context.Background(), signed, "zone", UseGateway); err == nil {
		t.Fatal("one-shot gateway token with no replay identifier accepted")
	}
}

func TestSubjectJWKSRejectsWeakRSAKeys(t *testing.T) {
	weak := new(big.Int).Lsh(big.NewInt(1), 1023)
	weak.Add(weak, big.NewInt(1))
	if _, err := rsaPublicKeyFromJWK(subjectJWK{N: base64.RawURLEncoding.EncodeToString(weak.Bytes()), E: "AQAB"}); err == nil {
		t.Fatal("weak 1024-bit federation key accepted")
	}
	strong := new(big.Int).Lsh(big.NewInt(1), 2047)
	strong.Add(strong, big.NewInt(1))
	if _, err := rsaPublicKeyFromJWK(subjectJWK{N: base64.RawURLEncoding.EncodeToString(strong.Bytes()), E: "BA"}); err == nil {
		t.Fatal("even RSA exponent accepted")
	}
}
