// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
package internal

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	coreconfig "github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/rs/zerolog"
)

// Opt-in: use ONLY a disposable, migrated PostgreSQL DB and dedicated Redis.
// All fixtures are zone-scoped. This runs the real STS listener and workers.
type liveSTS struct {
	s                                                       *Server
	base, zone, app, resource, source, target, edge, secret string
	client                                                  *http.Client
	upstream                                                *httptest.Server
}

func newLiveSTS(tb testing.TB) *liveSTS {
	tb.Helper()
	dsn, redisURL := os.Getenv("CARACAL_STS_TEST_DATABASE_URL"), os.Getenv("CARACAL_STS_TEST_REDIS_URL")
	if dsn == "" || redisURL == "" {
		tb.Skip("live STS requires disposable CARACAL_STS_TEST_DATABASE_URL and CARACAL_STS_TEST_REDIS_URL")
	}
	ctx := context.Background()
	db, err := newDB(ctx, dsn)
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(db.pool.Close)
	rdb, err := newRedis(redisURL)
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = rdb.c.Close() })
	key := signingZEK()
	rdb.SetStreamSigning(key, true)
	f := &liveSTS{zone: uuid.NewString(), app: uuid.NewString(), resource: uuid.NewString(), source: uuid.NewString(), target: uuid.NewString(), edge: uuid.NewString(), secret: "disposable-benchmark-credential", client: &http.Client{Timeout: 10 * time.Second}}
	tb.Cleanup(f.client.CloseIdleConnections)
	f.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		_, err := jwt.Parse(token, func(token *jwt.Token) (any, error) {
			keys, err := f.s.keys.getPublicKeysByZone(r.Context(), f.zone)
			if err != nil {
				return nil, err
			}
			return keys[fmt.Sprint(token.Header["kid"])], nil
		}, jwt.WithValidMethods([]string{"ES256"}), jwt.WithIssuer("https://sts.test"), jwt.WithAudience(f.resource), jwt.WithExpirationRequired())
		if err != nil {
			w.WriteHeader(401)
			return
		}
		_, _ = io.WriteString(w, "verified upstream")
	}))
	tb.Cleanup(f.upstream.Close)
	exec := func(sql string, args ...any) {
		tb.Helper()
		if _, err := db.pool.Exec(ctx, sql, args...); err != nil {
			tb.Fatal(err)
		}
	}
	// Immutable policy versions are intentionally not deleted. Remove the live
	// binding and mutable fixture state after shutdown; archive the zone. The
	// disposable database retains its append-only policy/audit evidence until
	// its owner drops it. This keeps repeated benchmark seeding equivalent.
	tb.Cleanup(func() {
		cleanupDB, err := newDB(context.Background(), dsn)
		if err != nil {
			tb.Error(err)
			return
		}
		defer cleanupDB.pool.Close()
		for _, sql := range []string{
			`DELETE FROM policy_set_bindings WHERE zone_id=$1`,
			`DELETE FROM delegation_edges WHERE zone_id=$1`,
			`DELETE FROM sessions WHERE zone_id=$1`,
			`DELETE FROM authority_records WHERE zone_id=$1`,
			`DELETE FROM resources WHERE zone_id=$1`,
			`DELETE FROM providers WHERE zone_id=$1`,
			`DELETE FROM applications WHERE zone_id=$1`,
			`DELETE FROM secrets WHERE zone_id=$1`,
			`UPDATE zones SET archived_at=now() WHERE id=$1`,
		} {
			_, err := cleanupDB.pool.Exec(context.Background(), sql, f.zone)
			if err != nil {
				tb.Error("fixture cleanup", err)
			}
		}
	})
	exec(`INSERT INTO zones(id,name,slug) VALUES($1,'STS test',$1)`, f.zone)
	hash, err := hashClientSecret(f.secret)
	if err != nil {
		tb.Fatal(err)
	}
	exec(`INSERT INTO applications(id,zone_id,name,registration_method,client_secret_hash) VALUES($1,$2,'STS test','managed',$3)`, f.app, f.zone, hash)
	provider := uuid.NewString()
	exec(`INSERT INTO providers(id,zone_id,name,identifier,provider_kind) VALUES($1,$2,'mandate',$1,'caracal_mandate')`, provider, f.zone)
	exec(`INSERT INTO resources(id,zone_id,name,identifier,upstream_url,credential_provider_id,scopes,operations,operation_enforcement) VALUES($1,$2,'STS test',$1,$3,$4,ARRAY['read','write','agent:lifecycle'],'[{"method":"GET","path":"/read","scope":"read"},{"method":"POST","path":"/write","scope":"write"}]','enforced')`, f.resource, f.zone, f.upstream.URL, provider)
	pid, pvid, psid, psvid := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := fmt.Sprintf("package caracal.authz\napp_ids := {\"app\":%q}\ngrants := {%q:{\"application\":\"app\",\"roles\":{\"worker\":[\"read\"]}}}\n", f.app, f.resource)
	manifest := fmt.Sprintf(`[{"policy_version_id":%q}]`, pvid)
	exec(`INSERT INTO policies(id,zone_id,name,created_by) VALUES($1,$2,'STS test','test')`, pid, f.zone)
	exec(`INSERT INTO policy_versions(id,policy_id,version,content,content_sha256,schema_version,created_by) VALUES($1,$2,1,$3,$4,'2026-05-20','test')`, pvid, pid, content, fmt.Sprintf("%x", sha256.Sum256([]byte(content))))
	exec(`INSERT INTO policy_sets(id,zone_id,name,created_by) VALUES($1,$2,'STS test','test')`, psid, f.zone)
	exec(`INSERT INTO policy_set_versions(id,policy_set_id,version,manifest_json,manifest_sha256,schema_version,created_by) VALUES($1,$2,1,$3,$4,'2026-05-20','test')`, psvid, psid, manifest, fmt.Sprintf("%x", sha256.Sum256([]byte(manifest))))
	exec(`INSERT INTO policy_set_bindings(zone_id,policy_set_id,active_version_id) VALUES($1,$2,$3)`, f.zone, psid, psvid)
	buf, err := newAuditBuffer(rdb, zerolog.Nop(), false, tb.TempDir(), &STSMetrics{})
	if err != nil {
		tb.Fatal(err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	port := strconv.Itoa(l.Addr().(*net.TCPAddr).Port)
	_ = l.Close()
	f.base = "http://127.0.0.1:" + port
	f.s = &Server{cfg: Config{Base: coreconfig.Base{Port: port}, IssuerURL: "https://sts.test", GatewayHMACKey: key, MintRateLimitPerMin: 1000000000, PrivateEgressHosts: []string{"127.0.0.1"}}, db: db, redis: rdb, keys: newKeyCache(db, testKeyring(key)), opa: newOPAEngine(db, zerolog.Nop()), auditBuffer: buf, metrics: &STSMetrics{}, approvals: newApprovalWatch(), consumersReady: make(chan struct{}), log: zerolog.Nop()}
	f.s.secretVerifier.configure(2)
	if err := f.s.opa.Reload(ctx, f.zone); err != nil {
		tb.Fatal(err)
	}
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- f.s.Run(runCtx) }()
	tb.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				tb.Error(err)
			}
		case <-time.After(15 * time.Second):
			tb.Error("STS shutdown timed out")
		}
	})
	for start := time.Now(); ; {
		resp, err := f.client.Get(f.base + "/ready")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				break
			}
		}
		if time.Since(start) > 5*time.Second {
			tb.Fatal("STS not ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	resp, status, err := f.exchange(f.bootstrapForm())
	if err != nil || status != 200 {
		tb.Fatalf("bootstrap status=%d err=%v", status, err)
	}
	claims := jwt.MapClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(resp.AccessToken, claims); err != nil {
		tb.Fatal(err)
	}
	sid := claimString(claims, "sid")
	for _, session := range []string{f.source, f.target} {
		exec(`INSERT INTO sessions(id,zone_id,application_id,subject_authority_record_id,labels) VALUES($1,$2,$3,$4,ARRAY['worker'])`, session, f.zone, f.app, sid)
	}
	exec(`INSERT INTO delegation_graph_epochs(zone_id,epoch) VALUES($1,1)`, f.zone)
	exec(`INSERT INTO delegation_edges(id,zone_id,source_session_id,target_session_id,issuer_application_id,receiver_application_id,resource_id,scopes,constraints_json,expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,ARRAY['read'],'{"max_hops":1,"ttl_seconds":600}',now()+interval '1 hour')`, f.edge, f.zone, f.source, f.target, f.app, f.resource)
	return f
}

func (f *liveSTS) bootstrapForm() url.Values {
	return url.Values{"grant_type": {tokenExchangeGrantType}, "zone_id": {f.zone}, "application_id": {f.app}, "client_secret": {f.secret}, "resource": {f.resource}, "scope": {"agent:lifecycle"}}
}
func (f *liveSTS) delegatedForm() url.Values {
	v := f.bootstrapForm()
	v.Set("scope", "read")
	v.Set("agent_session_id", f.target)
	v.Set("delegation_edge_id", f.edge)
	v.Set("ttl_seconds", "120")
	return v
}
func (f *liveSTS) exchange(v url.Values) (TokenResponse, int, error) {
	var out TokenResponse
	resp, err := f.client.PostForm(f.base+"/oauth/2/token", v)
	if err != nil {
		return out, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return out, resp.StatusCode, err
	}
	if resp.StatusCode != 200 {
		return out, resp.StatusCode, fmt.Errorf("exchange denied: %s", body)
	}
	err = json.Unmarshal(body, &out)
	return out, resp.StatusCode, err
}

func BenchmarkSTSExchangeLive(b *testing.B) {
	f := newLiveSTS(b)
	for _, mode := range []string{"bootstrap", "delegated"} {
		for _, n := range []int{1, 8, 32} {
			b.Run(mode+"/"+strconv.Itoa(n), func(b *testing.B) {
				form := f.bootstrapForm()
				if mode == "delegated" {
					form = f.delegatedForm()
				}
				b.ReportAllocs()
				b.ResetTimer()
				measureLive(b, n, func() error { _, _, err := f.exchange(form); return err })
			})
		}
	}
}
func BenchmarkSTSJWKSLive(b *testing.B) {
	f := newLiveSTS(b)
	for _, n := range []int{1, 8, 32} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			measureLive(b, n, func() error {
				r, e := f.client.Get(f.base + "/.well-known/jwks.json?zone_id=" + f.zone)
				if e != nil {
					return e
				}
				defer r.Body.Close()
				_, e = io.Copy(io.Discard, r.Body)
				if r.StatusCode != 200 {
					return fmt.Errorf("status %d", r.StatusCode)
				}
				return e
			})
		})
	}
}

// In-process allocations/CPU include the real server and load generator; the
// PostgreSQL and Redis processes are external. Samples cover ALL requests.
func measureLive(b *testing.B, n int, call func() error) {
	lat := make([]int64, b.N)
	var next, fail atomic.Int64
	var wg sync.WaitGroup
	var errorOnce sync.Once
	var firstError string
	var before, after syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &before)
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	start := time.Now()
	for j := 0; j < n; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1) - 1)
				if i >= b.N {
					return
				}
				s := time.Now()
				if err := call(); err != nil {
					fail.Add(1)
					errorOnce.Do(func() { firstError = err.Error() })
				}
				lat[i] = time.Since(s).Nanoseconds()
			}
		}()
	}
	wg.Wait()
	elapsed := time.Since(start)
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &after)
	b.StopTimer()
	slices.Sort(lat)
	for _, q := range []struct {
		name string
		p    float64
	}{{"p50-ms", .5}, {"p95-ms", .95}, {"p99-ms", .99}} {
		b.ReportMetric(float64(lat[int(float64(len(lat)-1)*q.p)])/1e6, q.name)
	}
	b.ReportMetric(float64(b.N)/elapsed.Seconds(), "req/s")
	b.ReportMetric(float64(fail.Load())/float64(b.N)*100, "errors-%")
	cpu := func(r syscall.Rusage) float64 {
		return float64(r.Utime.Sec+r.Stime.Sec) + float64(r.Utime.Usec+r.Stime.Usec)/1e6
	}
	b.ReportMetric((cpu(after)-cpu(before))/elapsed.Seconds()*100, "cpu-%")
	runtime.ReadMemStats(&mem)
	b.ReportMetric(float64(mem.HeapAlloc)/1048576, "heap-MiB")
	b.ReportMetric(float64(after.Maxrss)/1024, "process-maxrss-MiB")
	if fail.Load() > 0 {
		b.Fatalf("%d/%d failed requests; first failure: %s", fail.Load(), b.N, firstError)
	}
}

func BenchmarkSTSValidateLive(b *testing.B) {
	f := newLiveSTS(b)
	out, _, err := f.exchange(f.delegatedForm())
	if err != nil {
		b.Fatal(err)
	}
	for _, n := range []int{1, 8, 32} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			measureLive(b, n, func() error {
				_, err := f.s.validateSubjectTokenUse(context.Background(), out.AccessToken, f.zone, UseGateway)
				return err
			})
		})
	}
}

func BenchmarkSTSDependenciesLive(b *testing.B) {
	f := newLiveSTS(b)
	for _, name := range []string{"postgres-time", "postgres-keys", "redis-ping"} {
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			measureLive(b, 8, func() error {
				switch name {
				case "postgres-time":
					_, err := f.s.db.CurrentTime(context.Background())
					return err
				case "postgres-keys":
					_, err := f.s.db.GetZoneSigningKeySecrets(context.Background(), f.zone)
					return err
				default:
					return f.s.redis.Ping(context.Background())
				}
			})
		})
	}
}

// startLivePeer runs an independent STS instance against the same authoritative
// database and Redis, with its own pools, policy/key caches and audit spool.
func startLivePeer(tb testing.TB, f *liveSTS) (*liveSTS, func()) {
	tb.Helper()
	db, err := newDB(context.Background(), os.Getenv("CARACAL_STS_TEST_DATABASE_URL"))
	if err != nil {
		tb.Fatal(err)
	}
	rdb, err := newRedis(os.Getenv("CARACAL_STS_TEST_REDIS_URL"))
	if err != nil {
		db.pool.Close()
		tb.Fatal(err)
	}
	rdb.SetStreamSigning(signingZEK(), true)
	buf, err := newAuditBuffer(rdb, zerolog.Nop(), false, tb.TempDir(), &STSMetrics{})
	if err != nil {
		_ = rdb.c.Close()
		db.pool.Close()
		tb.Fatal(err)
	}
	peer := *f
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	_ = listener.Close()
	cfg := f.s.cfg
	cfg.Port = port
	peer.s = &Server{cfg: cfg, db: db, redis: rdb, keys: newKeyCache(db, testKeyring(signingZEK())), opa: newOPAEngine(db, zerolog.Nop()), auditBuffer: buf, metrics: &STSMetrics{}, approvals: newApprovalWatch(), consumersReady: make(chan struct{}), log: zerolog.Nop()}
	peer.s.secretVerifier.configure(2)
	peer.base = "http://127.0.0.1:" + port
	if err := peer.s.opa.Reload(context.Background(), f.zone); err != nil {
		tb.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- peer.s.Run(ctx) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			select {
			case err := <-done:
				if err != nil {
					tb.Error(err)
				}
			case <-time.After(15 * time.Second):
				tb.Error("peer shutdown timeout")
			}
			db.pool.Close()
			_ = rdb.c.Close()
		})
	}
	tb.Cleanup(stop)
	for start := time.Now(); ; {
		r, e := f.client.Get(peer.base + "/ready")
		if e == nil {
			_, _ = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
			if r.StatusCode == 200 {
				break
			}
		}
		if time.Since(start) > 5*time.Second {
			tb.Fatal("peer not ready")
		}
		time.Sleep(20 * time.Millisecond)
	}
	return &peer, stop
}

// Full HTTP issuance after a cold client-proof cache (e.g. STS restart). Each
// benchmark operation is one batch, not one token. Use -benchtime=1x -count=3
// to compare synchronized bursts without hiding the memory-hard cold path.
func BenchmarkSTSColdExchangeLive(b *testing.B) {
	f := newLiveSTS(b)
	for _, n := range []int{1, 8, 32} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			samples := make([]int64, 0, b.N*n)
			var failures atomic.Int64
			var cpuBefore, cpuAfter syscall.Rusage
			_ = syscall.Getrusage(syscall.RUSAGE_SELF, &cpuBefore)
			b.ReportAllocs()
			b.ResetTimer()
			startAll := time.Now()
			for round := 0; round < b.N; round++ {
				f.s.secretVerifier.mu.Lock()
				f.s.secretVerifier.entries = nil
				f.s.secretVerifier.mu.Unlock()
				lat := make([]int64, n)
				start := make(chan struct{})
				var wg sync.WaitGroup
				for j := 0; j < n; j++ {
					wg.Add(1)
					go func(i int) {
						defer wg.Done()
						<-start
						t := time.Now()
						if _, _, err := f.exchange(f.bootstrapForm()); err != nil {
							failures.Add(1)
						}
						lat[i] = time.Since(t).Nanoseconds()
					}(j)
				}
				close(start)
				wg.Wait()
				samples = append(samples, lat...)
			}
			elapsed := time.Since(startAll)
			_ = syscall.Getrusage(syscall.RUSAGE_SELF, &cpuAfter)
			b.StopTimer()
			cpuSeconds := func(r syscall.Rusage) float64 {
				return float64(r.Utime.Sec+r.Stime.Sec) + float64(r.Utime.Usec+r.Stime.Usec)/1e6
			}
			b.ReportMetric((cpuSeconds(cpuAfter)-cpuSeconds(cpuBefore))/elapsed.Seconds()*100, "cpu-%")
			b.ReportMetric(float64(cpuAfter.Maxrss)/1024, "process-maxrss-MiB")
			var mem runtime.MemStats
			runtime.ReadMemStats(&mem)
			b.ReportMetric(float64(mem.HeapAlloc)/1048576, "heap-MiB")
			slices.Sort(samples)
			for _, q := range []struct {
				name string
				p    float64
			}{{"p50-ms", .5}, {"p95-ms", .95}, {"p99-ms", .99}} {
				b.ReportMetric(float64(samples[int(float64(len(samples)-1)*q.p)])/1e6, q.name)
			}
			b.ReportMetric(float64(n*b.N)/elapsed.Seconds(), "tokens/s")
			b.ReportMetric(float64(failures.Load())/float64(n*b.N)*100, "errors-%")
			if failures.Load() != 0 {
				b.Fatal("cold HTTP issuance failed")
			}
		})
	}
}
