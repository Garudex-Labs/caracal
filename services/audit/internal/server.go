// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service bootstrap and lifecycle: consumer, exporter, tamper sweeper,
// retention rotator, leader lease, and HTTP probes/metrics.

package internal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/garudex-labs/caracal/shared/logging"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"golang.org/x/sync/errgroup"
)

const (
	exporterLockKey  = int64(0x4341524130303031) // exporter / parquet
	retentionLockKey = int64(0x4341524130303032) // retention rotator
)

type Server struct {
	cfg          Config
	consumer     *Consumer
	exporter     *ParquetExporter
	sweeper      *TamperSweeper
	retention    *Retention
	exporterLead *Leader
	retentLead   *Leader
	pg           *PGWriter
	redis        *redis.Client
	log          zerolog.Logger

	inserts      atomic.Int64
	exportEvents atomic.Int64
	exportErrors atomic.Int64
	exportDurMs  atomic.Int64
	consumerLag  atomic.Int64
	pelOldestAge atomic.Int64
}

func New(ctx context.Context) (*Server, error) {
	cfg := loadConfig()
	log := logging.New("audit")

	db, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}
	r := redis.NewClient(opts)

	pg := &PGWriter{db: db, hmacKey: cfg.HMACKey}
	exportLead := newLeader(pg, exporterLockKey, log)
	retentLead := newLeader(pg, retentionLockKey, log)

	exp, err := newParquetExporter(pg, cfg, exportLead, log)
	if err != nil {
		return nil, err
	}
	s := &Server{
		cfg:          cfg,
		consumer:     newConsumer(pg, r, log, cfg),
		exporter:     exp,
		sweeper:      newTamperSweeper(pg, cfg.HMACKey, time.Duration(cfg.RetentionDays)*24*time.Hour, time.Duration(cfg.TamperRollingHours)*time.Hour, log),
		retention:    newRetention(pg, retentLead, cfg.RetentionDays, log),
		exporterLead: exportLead,
		retentLead:   retentLead,
		pg:           pg,
		redis:        r,
		log:          log,
	}
	pg.onInsert = func() { s.inserts.Add(1) }
	exp.onExport = func(events int64, durMs int64, failed bool) {
		s.exportEvents.Add(events)
		s.exportDurMs.Store(durMs)
		if failed {
			s.exportErrors.Add(1)
		}
	}
	if len(cfg.HMACKey) == 0 {
		log.Warn().Msg("AUDIT_HMAC_KEY not set: chain HMAC disabled and producer signatures not verified")
	}
	return s, nil
}

func (s *Server) Run(ctx context.Context) error {
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error { s.exporterLead.Run(gctx); return nil })
	g.Go(func() error { s.retentLead.Run(gctx); return nil })
	g.Go(func() error { s.consumer.Run(gctx); return nil })
	g.Go(func() error { s.exporter.Run(gctx); return nil })
	g.Go(func() error { s.sweeper.Run(gctx); return nil })
	g.Go(func() error { s.retention.Run(gctx); return nil })
	g.Go(func() error { s.pollConsumerLag(gctx); return nil })

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)

	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	g.Go(func() error {
		s.log.Info().Str("port", s.cfg.Port).Msg("listening")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	g.Go(func() error {
		<-gctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	})

	return g.Wait()
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	if !s.consumer.Healthy() {
		http.Error(w, "consumer unhealthy", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pg.Ping(ctx); err != nil {
		http.Error(w, "pg unreachable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	if err := s.redis.Ping(ctx).Err(); err != nil {
		http.Error(w, "redis unreachable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"inserts_total":            s.inserts.Load(),
		"export_events_total":      s.exportEvents.Load(),
		"export_errors_total":      s.exportErrors.Load(),
		"export_duration_ms":       s.exportDurMs.Load(),
		"consumer_lag":             s.consumerLag.Load(),
		"consumer_pel_oldest_secs": s.pelOldestAge.Load(),
		"parse_errors_total":       s.consumer.parseErrors.Load(),
		"dlq_total":                s.consumer.dlqTotal.Load(),
		"retries_total":            s.consumer.retriesTotal.Load(),
		"hmac_failures_total":      s.consumer.hmacFailTotal.Load(),
		"tamper_replay_total":      s.consumer.tamperReplay.Load(),
		"tamper_checked_total":     s.sweeper.checkedTotal.Load(),
		"tamper_mismatch_total":    s.sweeper.mismatchTotal.Load(),
		"tamper_chain_breaks":      s.sweeper.chainBreak.Load(),
		"tamper_hmac_failures":     s.sweeper.hmacMismatch.Load(),
		"tamper_last_sweep_unix":   s.sweeper.lastSweepUnix.Load(),
		"tamper_last_full_unix":    s.sweeper.lastFullUnix.Load(),
		"retention_created_total":  s.retention.createdTotal.Load(),
		"retention_dropped_total":  s.retention.droppedTotal.Load(),
		"is_export_leader":         s.exporterLead.Held(),
		"is_retention_leader":      s.retentLead.Held(),
	})
}

func (s *Server) pollConsumerLag(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			info, err := s.redis.XPending(ctx, auditStream, consumerGroup).Result()
			if err != nil {
				s.log.Warn().Err(err).Msg("xpending poll")
				continue
			}
			s.consumerLag.Store(info.Count)

			ext, err := s.redis.XPendingExt(ctx, &redis.XPendingExtArgs{
				Stream: auditStream,
				Group:  consumerGroup,
				Start:  "-",
				End:    "+",
				Count:  1,
			}).Result()
			if err == nil && len(ext) > 0 {
				s.pelOldestAge.Store(int64(ext[0].Idle / time.Second))
			} else {
				s.pelOldestAge.Store(0)
			}
		}
	}
}
