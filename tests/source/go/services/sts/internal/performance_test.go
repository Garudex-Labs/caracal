// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
package internal

import (
	"context"
	"crypto/elliptic"
	"net"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"
)

// These component benchmarks deliberately exclude dependency latency. Live
// benchmarks below use PostgreSQL, Redis, HTTP and the production exchange path.
func benchmarkKeys(b *testing.B) *KeyCache {
	b.Helper()
	// Reuse the fixture builders without timing setup.
	zek := signingZEK()
	db := &stubDB{secrets: []SecretRow{sealedSecret(b, zek, "kid", []byte(ecKeyPEM(b, elliptic.P256())))}}
	return newKeyCache(db, testKeyring(zek))
}

func BenchmarkSTSIssue(b *testing.B) {
	keys := benchmarkKeys(b)
	params := IssueParams{ZoneID: "zone", AppID: "app", SubjectID: "app", Use: UseSession, AuthorityRecordID: "sid", RootAuthorityRecordID: "sid", Scopes: "read", Resources: []string{"resource://test"}, TTL: time.Hour}
	if _, _, err := issueToken(context.Background(), params, keys, "https://sts.test"); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, _, err := issueToken(context.Background(), params, keys, "https://sts.test"); err != nil {
				b.Error(err)
			}
		}
	})
}

func BenchmarkSTSValidate(b *testing.B) {
	keys := benchmarkKeys(b)
	s := &Server{keys: keys, cfg: Config{IssuerURL: "https://sts.test"}}
	token, _, err := issueToken(context.Background(), IssueParams{ZoneID: "zone", AppID: "app", SubjectID: "app", Use: UseSession, TTL: time.Hour}, keys, s.cfg.IssuerURL)
	if err != nil {
		b.Fatal(err)
	}
	if _, err := s.validateSubjectToken(context.Background(), token, "zone"); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := s.validateSubjectToken(context.Background(), token, "zone"); err != nil {
				b.Error(err)
			}
		}
	})
}

func BenchmarkSTSJWKS(b *testing.B) {
	keys := benchmarkKeys(b)
	s := &Server{keys: keys, db: keys.db, metrics: &STSMetrics{}}
	req := httptest.NewRequest("GET", "/.well-known/jwks.json?zone_id=zone", nil)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			w := httptest.NewRecorder()
			s.handleJWKS(w, req)
			if w.Code != 200 {
				b.Error(w.Code)
			}
		}
	})
}

func BenchmarkSTSSecretBurst(b *testing.B) {
	hash, err := hashClientSecret("benchmark-only-credential")
	if err != nil {
		b.Fatal(err)
	}
	for _, n := range []int{1, 8, 32} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				var cache verifiedSecretCache
				cache.configure(2)
				start := make(chan struct{})
				var wg sync.WaitGroup
				for j := 0; j < n; j++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						<-start
						if !cache.verify(context.Background(), hash, "benchmark-only-credential") {
							b.Error("verify")
						}
					}()
				}
				close(start)
				wg.Wait()
			}
		})
	}
}

// STS deliberately forbids loopback even when private egress is allowlisted.
// Bind a local RFC1918 interface for the real TLS transport tests instead of
// weakening that guard or replacing DialContext with an unsafe test dialer.
func privateTestHost(tb testing.TB) string {
	tb.Helper()
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		tb.Fatal(err)
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil && ip.IsPrivate() && !ip.IsLoopback() {
			return ip.String()
		}
	}
	tb.Skip("no local RFC1918 interface available for guarded TLS transport test")
	return ""
}
