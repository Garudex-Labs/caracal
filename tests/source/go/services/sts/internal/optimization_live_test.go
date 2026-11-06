// Copyright (C) 2026 Garudex Labs. All Rights Reserved.
// Caracal, a product of Garudex Labs
package internal

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	corests "github.com/garudex-labs/caracal/packages/core/go/sts"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSTSLocalDeployment(t *testing.T) {
	f := newLiveSTS(t)
	db := f.s.db.(*DB)
	ctx := context.Background()
	execSQL := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	mint := func() string {
		t.Helper()
		out, status, err := f.exchange(f.delegatedForm())
		if err != nil || status != 200 {
			t.Fatalf("mint status=%d err=%v", status, err)
		}
		return out.AccessToken
	}
	token := mint()
	// Real exchange, real PostgreSQL lineage, real signature. Separate cache
	// instances intentionally receive no invalidation stream notification.
	peerInstance, stopPeer := startLivePeer(t, f)
	peer := peerInstance.s
	if _, err := peer.validateSubjectTokenUse(ctx, token, f.zone, UseGateway); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.keys.RotateZoneSigningKey(ctx, f.zone); err != nil {
		t.Fatal(err)
	}
	fresh := mint()
	peerIssued, status, err := peerInstance.exchange(f.delegatedForm())
	if err != nil || status != 200 {
		t.Fatalf("peer issuance status=%d err=%v", status, err)
	}
	if _, err := f.s.validateSubjectTokenUse(ctx, peerIssued.AccessToken, f.zone, UseGateway); err != nil {
		t.Fatal("peer signature not accepted", err)
	}
	for _, bearer := range []string{token, fresh} {
		if _, err := peer.validateSubjectTokenUse(ctx, bearer, f.zone, UseGateway); err != nil {
			t.Fatal("peer missed rotation", err)
		}
	}
	// Exercise the real SQL grace-period boundary, not just an in-memory TTL.
	current, err := db.GetZoneSigningKeySecret(ctx, f.zone)
	if err != nil {
		t.Fatal(err)
	}
	execSQL(`UPDATE secrets SET created_at=now()-interval '25 hours' WHERE id=$1`, current.ID)
	if _, err := peer.validateSubjectTokenUse(ctx, token, f.zone, UseGateway); err == nil {
		t.Fatal("expired signing-key grace window extended by cache")
	}
	execSQL(`UPDATE secrets SET created_at=now() WHERE id=$1`, current.ID)
	if _, err := f.s.keys.RotateZoneSigningKey(ctx, f.zone); err != nil {
		t.Fatal(err)
	}
	if _, err := peer.validateSubjectTokenUse(ctx, token, f.zone, UseGateway); err == nil {
		t.Fatal("peer trusted a removed rotation key")
	}
	stopPeer()
	peerInstance, _ = startLivePeer(t, f)
	if _, status, err := peerInstance.exchange(f.delegatedForm()); status != 200 || err != nil {
		t.Fatalf("STS restart failed: status=%d err=%v", status, err)
	}
	// Parallel legitimate duplicate requests receive fresh, unique JTIs. No token
	// responses are cached, and Redis enforces HMAC nonces across instances.
	var wg sync.WaitGroup
	var mu sync.Mutex
	jtis := map[string]bool{}
	for j := 0; j < 16; j++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out, _, err := f.exchange(f.delegatedForm())
			if err != nil {
				t.Error(err)
				return
			}
			claims := jwt.MapClaims{}
			if _, _, err := jwt.NewParser().ParseUnverified(out.AccessToken, claims); err != nil {
				t.Error(err)
				return
			}
			mu.Lock()
			defer mu.Unlock()
			id := claimString(claims, "jti")
			if jtis[id] || id == "" {
				t.Error("duplicate or empty jti")
			}
			jtis[id] = true
		}()
	}
	wg.Wait()
	v := f.delegatedForm()
	v.Set("scope", "write")
	if _, status, _ := f.exchange(v); status == 200 {
		t.Fatal("scope escalation")
	}
	v = f.delegatedForm()
	v.Set("agent_session_id", f.source)
	if _, status, _ := f.exchange(v); status == 200 {
		t.Fatal("forged target Session accepted")
	}
	// Credential rotation is visible immediately despite a warmed secret cache.
	oldHash, err := hashClientSecret("rotated-fixture")
	if err != nil {
		t.Fatal(err)
	}
	execSQL(`UPDATE applications SET client_secret_hash=$1 WHERE id=$2`, oldHash, f.app)
	if _, status, _ := f.exchange(f.delegatedForm()); status == 200 {
		t.Fatal("retired client secret accepted")
	}
	if _, status, _ := peerInstance.exchange(f.delegatedForm()); status == 200 {
		t.Fatal("peer accepted retired client secret")
	}
	f.secret = "rotated-fixture"
	_ = mint()
	if _, status, err := peerInstance.exchange(f.delegatedForm()); status != 200 || err != nil {
		t.Fatalf("peer did not pick up credential rotation: %d %v", status, err)
	}
	// Cross-application two-hop lineage: the root issuer differs from the
	// immediate issuer. Attribution must bind the immediate source correctly.
	rootApp, rootSession, rootSID, rootEdge := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	execSQL(`INSERT INTO applications(id,zone_id,name,registration_method) VALUES($1,$2,'root','managed')`, rootApp, f.zone)
	execSQL(`INSERT INTO authority_records(id,zone_id,session_type,subject_id,status,expires_at,authenticated_at) VALUES($1,$2,'application',$3,'active',now()+interval '1 hour',now())`, rootSID, f.zone, rootApp)
	execSQL(`INSERT INTO sessions(id,zone_id,application_id,subject_authority_record_id,labels) VALUES($1,$2,$3,$4,ARRAY['worker'])`, rootSession, f.zone, rootApp, rootSID)
	execSQL(`INSERT INTO delegation_edges(id,zone_id,source_session_id,target_session_id,issuer_application_id,receiver_application_id,resource_id,scopes,constraints_json,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY['read'],'{"max_hops":2}',now()+interval '1 hour')`, rootEdge, f.zone, rootSession, f.source, rootApp, f.app, f.resource)
	execSQL(`UPDATE delegation_edges SET parent_edge_id=$1,constraints_json='{"max_hops":2,"ttl_seconds":600}',edge_version=edge_version+1 WHERE id=$2`, rootEdge, f.edge)
	execSQL(`UPDATE delegation_graph_epochs SET epoch=epoch+1 WHERE zone_id=$1`, f.zone)
	_ = mint()
	t.Run("gateway", func(t *testing.T) { testLiveGateway(t, f, mint) })
	// Already-open requests wait at the same advisory lock as Coordinator changes.
	// Revoke while they wait, then release the lock: the transactional guard must
	// reject ALL stale pre-lock proofs instead of inserting new authority rows.
	tx, err := db.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "delegation:"+f.zone); err != nil {
		t.Fatal(err)
	}
	statuses := make(chan int, 8)
	for j := 0; j < 8; j++ {
		go func() { _, status, _ := f.exchange(f.delegatedForm()); statuses <- status }()
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no issuance reached graph lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := tx.Exec(ctx, `UPDATE delegation_edges SET status='revoked',revoked_at=now(),edge_version=edge_version+1 WHERE id=$1`, f.edge); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE delegation_graph_epochs SET epoch=epoch+1 WHERE zone_id=$1`, f.zone); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for j := 0; j < 8; j++ {
		if status := <-statuses; status == 200 || status == 0 {
			t.Fatalf("revocation-racing issuance status=%d", status)
		}
	}
	if _, status, _ := f.exchange(f.delegatedForm()); status == 200 {
		t.Fatal("revocation not honored")
	}
	// A fresh process-equivalent key cache neither inherits old membership nor
	// relies on Redis invalidation history after restart.
	restart := &Server{cfg: f.s.cfg, db: db, keys: newKeyCache(db, testKeyring(signingZEK()))}
	if _, err := restart.validateSubjectTokenUse(ctx, token, f.zone, UseGateway); err == nil {
		t.Fatal("restart trusted removed key")
	}
}

func testLiveGateway(t *testing.T, f *liveSTS, mint func() string) {
	binary := os.Getenv("CARACAL_STS_TEST_GATEWAY_BIN")
	if binary == "" {
		t.Skip("CARACAL_STS_TEST_GATEWAY_BIN not set; gateway subprocess not tested")
	}
	log, err := os.Create(filepath.Join(t.TempDir(), "gateway.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	_ = listener.Close()
	cmd := exec.Command(binary, "-test.run=^TestGatewaySTSDeploymentProcess$", "-test.timeout=120s")
	cmd.Stdout = log
	cmd.Stderr = log
	// Give the deployed Gateway the real DB/Redis plus explicit loopback egress
	// allowlisting for this fixture. No verifier or transport mocks.
	cmd.Env = append(os.Environ(), "CARACAL_GATEWAY_STS_TEST_PROCESS=1", "CARACAL_GATEWAY_TEST_PORT="+port, "CARACAL_MODE=dev", "PORT=8081", "STS_URL="+f.base, "DATABASE_URL="+os.Getenv("CARACAL_STS_TEST_DATABASE_URL"), "REDIS_URL="+os.Getenv("CARACAL_STS_TEST_REDIS_URL"), "STREAMS_HMAC_KEY="+hex.EncodeToString(signingZEK()), "AUDIT_HMAC_KEY="+hex.EncodeToString(signingZEK()), "GATEWAY_STS_HMAC_KEY="+hex.EncodeToString(signingZEK()), "CARACAL_ADMIN_TOKEN=test-admin", "UPSTREAM_HOST_ALLOWLIST=127.0.0.1", "AUDIT_REPLAY_DIR="+t.TempDir())
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Signal(os.Interrupt)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Error("gateway shutdown", err)
			}
		case <-time.After(18 * time.Second):
			_ = cmd.Process.Kill()
			t.Error("gateway shutdown timeout")
		}
	})
	base := "http://127.0.0.1:" + port
	for start := time.Now(); ; {
		r, e := f.client.Get(base + "/ready")
		if e == nil {
			_, _ = io.Copy(io.Discard, r.Body)
			_ = r.Body.Close()
			if r.StatusCode == 200 {
				break
			}
		}
		if time.Since(start) > 5*time.Second {
			body, _ := os.ReadFile(log.Name())
			t.Fatalf("gateway not ready: %s", body)
		}
		time.Sleep(20 * time.Millisecond)
	}
	request := func(token, method, path string) int {
		t.Helper()
		req, e := http.NewRequest(method, base+path, nil)
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Caracal-Resource", f.resource)
		r, e := f.client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		if r.StatusCode == 200 && !strings.Contains(string(body), "verified upstream") {
			t.Fatal("upstream did not verify issued resource mandate")
		}
		return r.StatusCode
	}
	bearer := mint()
	if status := request(bearer, "GET", "/read"); status != 200 {
		t.Fatalf("gateway authorization status=%d", status)
	}
	if status := request(bearer, "GET", "/read"); status == 200 {
		t.Fatal("gateway replay accepted")
	}
	if status := request(mint(), "POST", "/write"); status == 200 {
		t.Fatal("operation authority broadened")
	}
	parts := strings.Split(mint(), ".")
	parts[1] = parts[1][:len(parts[1])-1] + "A"
	if status := request(strings.Join(parts, "."), "GET", "/read"); status == 200 {
		t.Fatal("forged token accepted")
	}
	// A freshly minted bearer whose authority was revoked never reaches upstream.
	revoked := mint()
	claims := jwt.MapClaims{}
	_, _, err = jwt.NewParser().ParseUnverified(revoked, claims)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.s.db.RevokeAuthorityRecord(context.Background(), f.zone, claimString(claims, "sid"), "test"); err != nil {
		t.Fatal(err)
	}
	if status := request(revoked, "GET", "/read"); status == 200 {
		t.Fatal("revoked authority accepted through gateway")
	}
	expired := mint()
	claims = jwt.MapClaims{}
	_, _, err = jwt.NewParser().ParseUnverified(expired, claims)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.db.(*DB).pool.Exec(context.Background(), `UPDATE authority_records SET expires_at=now()-interval '1 second' WHERE id=$1`, claimString(claims, "sid")); err != nil {
		t.Fatal(err)
	}
	if status := request(expired, "GET", "/read"); status == 200 {
		t.Fatal("expired authority accepted through gateway")
	}
}

func TestSTSSharedNonceAndDependencyFailuresLive(t *testing.T) {
	f := newLiveSTS(t)
	ctx := context.Background()
	nonce := uuid.NewString()
	if err := f.s.consumeGatewayNonce(ctx, nonce); err != nil {
		t.Fatal(err)
	}
	peerInstance, _ := startLivePeer(t, f)
	if err := peerInstance.s.consumeGatewayNonce(ctx, nonce); err == nil {
		t.Fatal("nonce replay accepted on another instance")
	}
	// HMAC remains mandatory; duplicate body fields and altered signed bodies fail.
	out, _, err := f.exchange(f.delegatedForm())
	if err != nil {
		t.Fatal(err)
	}
	form := url.Values{"grant_type": {tokenExchangeGrantType}, "zone_id": {f.zone}, "application_id": {f.app}, "subject_token": {out.AccessToken}, "subject_token_type": {"urn:ietf:params:oauth:token-type:jwt"}, "resource": {f.resource}, "request_method": {"GET"}, "request_path": {"/read"}, "gateway_request_id": {"test-request"}}
	body := form.Encode()
	req, err := http.NewRequest("POST", f.base+"/oauth/2/token", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Request-Id", "test-request")
	now := time.Now().UTC()
	req.Header.Set(corests.GatewayTimestampHeader, fmt.Sprint(now.Unix()))
	req.Header.Set(corests.GatewayRequestHeader, nonce)
	req.Header.Set(corests.GatewaySignatureHeader, corests.SignGatewayExchange(signingZEK(), now, nonce, "POST", "/oauth/2/token", []byte(body)))
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("replayed signed gateway request accepted")
	}
	// Use dedicated failed clients, leaving fixture cleanup healthy. Real sockets
	// return errors, not fake database/Redis implementations.
	failedDB, err := newDB(ctx, "postgres://caracal@127.0.0.1:1/unavailable?sslmode=disable&connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer failedDB.pool.Close()
	failed := &Server{cfg: f.s.cfg, keys: newKeyCache(failedDB, testKeyring(signingZEK()))}
	if _, err := failed.validateSubjectTokenUse(ctx, out.AccessToken, f.zone, UseGateway); err == nil {
		t.Fatal("database socket outage admitted token")
	}
	badRedis, err := newRedis("redis://127.0.0.1:1?dial_timeout=100ms&read_timeout=100ms&write_timeout=100ms&max_retries=0")
	if err != nil {
		t.Fatal(err)
	}
	defer badRedis.c.Close()
	if err := (&Server{redis: badRedis}).consumeGatewayNonce(ctx, uuid.NewString()); err == nil {
		t.Fatal("redis outage admitted nonce")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err := f.s.keys.getKeyAndKid(canceled, f.zone); err == nil {
		t.Fatal("canceled storage request succeeded")
	}
}

func TestSTSGraphGuardUsesFreshSnapshotWithRepeatableReadDefault(t *testing.T) {
	f := newLiveSTS(t)
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(os.Getenv("CARACAL_STS_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	cfg.MinConns = 1
	cfg.ConnConfig.RuntimeParams["caracal.zone_id"] = "*"
	cfg.ConnConfig.RuntimeParams["default_transaction_isolation"] = "repeatable read"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	guardedDB := &DB{pool: pool}
	server := &Server{db: guardedDB}
	proof, _, apiErr := server.validateSessionReferences(ctx, f.zone, f.app, TokenExchangeRequest{SessionID: f.target, DelegationEdgeID: f.edge, Scope: "read"}, false, false)
	if apiErr != nil {
		t.Fatal(apiErr)
	}
	tx, err := f.s.db.(*DB).pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "delegation:"+f.zone); err != nil {
		t.Fatal(err)
	}
	record := &AuthorityRecord{ID: uuid.NewString(), ZoneID: f.zone, SessionType: "application", SubjectID: &f.app, Status: "active", ExpiresAt: time.Now().Add(time.Minute), AuthenticatedAt: time.Now()}
	result := make(chan error, 1)
	go func() { result <- guardedDB.InsertDelegatedAuthorityRecord(ctx, record, proof.issuance, nil) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var waiting int
		err := tx.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("guard did not reach advisory lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := tx.Exec(ctx, `UPDATE delegation_graph_epochs SET epoch=epoch+1 WHERE zone_id=$1`, f.zone); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, ErrDelegationChanged) {
		t.Fatalf("guard used stale transaction snapshot: %v", err)
	}
}
