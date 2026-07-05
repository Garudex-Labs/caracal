// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit server run/shutdown, lag polling, and environment bootstrap tests.

package internal

import (
	"context"
	"testing"
	"time"

	coreconfig "github.com/garudex-labs/caracal/packages/core/go/config"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
)

// blockingAuditRedis parks stream reads until the context ends so the consumer
// idles instead of spinning during server lifecycle tests.
type blockingAuditRedis struct {
	fakeAuditRedis
}

func (r *blockingAuditRedis) XReadGroup(ctx context.Context, _ *redis.XReadGroupArgs) *redis.XStreamSliceCmd {
	<-ctx.Done()
	return redis.NewXStreamSliceCmdResult(nil, ctx.Err())
}

func auditRunServer(t *testing.T) *Server {
	t.Helper()
	exporterLead := newLeader(&fakeStore{}, exporterLockKey, zerolog.Nop())
	retentLead := newLeader(&fakeStore{}, retentionLockKey, zerolog.Nop())
	store := &fakeLifecycleStore{}
	exporter, err := newParquetExporter(store, Config{}, exporterLead, zerolog.Nop())
	if err != nil {
		t.Fatalf("exporter: %v", err)
	}
	consumer := auditConsumer(&fakeAuditDB{}, &fakeAuditRedis{})
	consumer.redis = &blockingAuditRedis{}
	consumer.claimIdle = time.Hour
	return &Server{
		cfg:          Config{Base: coreconfig.Base{Port: "0"}},
		consumer:     consumer,
		exporter:     exporter,
		sweeper:      newTamperSweeper(store, nil, time.Hour, time.Hour, zerolog.Nop()),
		retention:    newRetention(store, retentLead, 30, zerolog.Nop()),
		exporterLead: exporterLead,
		retentLead:   retentLead,
		pg:           &fakeServerStore{},
		redis:        &fakeServerRedis{},
		log:          zerolog.Nop(),
	}
}

func TestAuditServerRunStartsAndStops(t *testing.T) {
	s := auditRunServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	time.Sleep(150 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not shut down")
	}
}

func TestAuditServerRunSurfacesListenFailure(t *testing.T) {
	s := auditRunServer(t)
	s.cfg.Port = "notaport"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Run with invalid port must fail")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not report listen failure")
	}
}

func TestPollConsumerLagStopsOnCancel(t *testing.T) {
	s := auditRunServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.pollConsumerLag(ctx)
}

func setAuditEnv(t *testing.T) {
	t.Helper()
	t.Setenv("CARACAL_MODE", "dev")
	t.Setenv("PORT", "9090")
	t.Setenv("DATABASE_URL", "postgres://caracal@127.0.0.1:1/caracal")
	t.Setenv("REDIS_URL", "redis://127.0.0.1:1/0")
	t.Setenv("AUDIT_HMAC_KEY", "")
}

func TestAuditNewBuildsServerWithLazyBackends(t *testing.T) {
	setAuditEnv(t)
	s, err := New(context.Background())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if s.consumer == nil || s.exporter == nil || s.pg == nil {
		t.Fatal("New must wire all components")
	}
}

func TestAuditNewRejectsWrongPort(t *testing.T) {
	setAuditEnv(t)
	t.Setenv("PORT", "8080")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must reject a non-audit port")
	}
}

func TestAuditNewRejectsBadDatabaseURL(t *testing.T) {
	setAuditEnv(t)
	t.Setenv("DATABASE_URL", "postgres://caracal@127.0.0.1:1/caracal?sslmode=bogus")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must reject an invalid database configuration")
	}
}

func TestAuditNewRejectsBadRedisURL(t *testing.T) {
	setAuditEnv(t)
	t.Setenv("REDIS_URL", "http://not-redis")
	if _, err := New(context.Background()); err == nil {
		t.Fatal("New must reject a non-redis URL")
	}
}
