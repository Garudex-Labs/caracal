// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service bootstrap and lifecycle: consumer, exporter, tamper sweeper,
// retention rotator, leader lease, and HTTP probes/metrics.

package internal

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/garudex-labs/caracal/packages/core/go/logging"
	coremetrics "github.com/garudex-labs/caracal/packages/core/go/metrics"
	"github.com/garudex-labs/caracal/packages/core/go/telemetry"
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
	pg           auditServerStore
	redis        auditServerRedis
	log          zerolog.Logger

	inserts       atomic.Int64
	exportEvents  atomic.Int64
	exportErrors  atomic.Int64
	exportDurMs   atomic.Int64
	exportBacklog atomic.Int64
	consumerLag   atomic.Int64
	pelOldestAge  atomic.Int64
	dlqSize       atomic.Int64
	dlqOldestAge  atomic.Int64
}

type auditServerStore interface {
	Ping(context.Context) error
	Search(context.Context, SearchParams) ([]EventRow, error)
	RehashChains(context.Context, zerolog.Logger) error
}

type auditServerRedis interface {
	Ping(context.Context) *redis.StatusCmd
	XAdd(context.Context, *redis.XAddArgs) *redis.StringCmd
	XDel(context.Context, string, ...string) *redis.IntCmd
	XLen(context.Context, string) *redis.IntCmd
	XPending(context.Context, string, string) *redis.XPendingCmd
	XPendingExt(context.Context, *redis.XPendingExtArgs) *redis.XPendingExtCmd
	XRangeN(context.Context, string, string, string, int64) *redis.XMessageSliceCmd
}

func New(ctx context.Context) (*Server, error) {
	cfg, err := loadConfig()
	if err != nil {
		return nil, fmt.Errorf("config: %w", err)
	}
	log := logging.New("audit")

	db, err := newPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return nil, err
	}
	r := redis.NewClient(opts)

	pg := &PGWriter{db: db, auditHMACKey: cfg.AuditHMACKey}
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
		sweeper:      newTamperSweeper(pg, cfg.AuditHMACKey, time.Duration(cfg.RetentionDays)*24*time.Hour, time.Duration(cfg.TamperRollingHours)*time.Hour, log),
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
	exp.onBacklog = func(hours int64) { s.exportBacklog.Store(hours) }
	if len(cfg.AuditHMACKey) == 0 {
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
	g.Go(func() error {
		if err := s.pg.RehashChains(gctx, s.log); err != nil {
			s.log.Error().Err(err).Msg("audit chain rehash failed")
		}
		s.sweeper.Run(gctx)
		return nil
	})
	g.Go(func() error { s.retention.Run(gctx); return nil })
	g.Go(func() error { s.pollConsumerLag(gctx); return nil })

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("GET /metrics", s.handleMetrics)
	mux.HandleFunc("GET /metrics.json", s.handleMetricsJSON)
	mux.HandleFunc("GET /api/audit/search", s.handleSearch)
	mux.HandleFunc("GET /api/audit/dlq", s.handleDLQList)
	mux.HandleFunc("GET /api/audit/dlq/{id}", s.handleDLQDetail)
	mux.HandleFunc("POST /api/audit/dlq/replay", s.handleDLQReplay)

	srv := &http.Server{
		Addr:              ":" + s.cfg.Port,
		Handler:           telemetry.HTTPHandler("caracal.audit.http", mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
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
		writeReadyFailure(w, "consumer_unhealthy")
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	if !s.consumer.Healthy() {
		writeReadyFailure(w, "consumer_unhealthy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.pg.Ping(ctx); err != nil {
		s.log.Warn().Err(err).Msg("ready: pg unreachable")
		writeReadyFailure(w, "postgres_unreachable")
		return
	}
	if err := s.redis.Ping(ctx).Err(); err != nil {
		s.log.Warn().Err(err).Msg("ready: redis unreachable")
		writeReadyFailure(w, "redis_unreachable")
		return
	}
	if s.cfg.ReadyDLQMax > 0 && s.dlqSize.Load() > s.cfg.ReadyDLQMax {
		writeReadyFailure(w, "audit_dlq_threshold")
		return
	}
	if s.cfg.ReadyLagMax > 0 && s.consumerLag.Load() > s.cfg.ReadyLagMax {
		writeReadyFailure(w, "audit_lag_threshold")
		return
	}
	if s.cfg.ReadyPELOldestMax > 0 && s.pelOldestAge.Load() > s.cfg.ReadyPELOldestMax {
		writeReadyFailure(w, "audit_pel_oldest_threshold")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ready": true})
}

func (s *Server) metricsAuthorized(r *http.Request) bool {
	if s.cfg.MetricsBearer == "" {
		return !s.cfg.IsPublished()
	}
	auth := r.Header.Get("Authorization")
	expected := "Bearer " + s.cfg.MetricsBearer
	if len(auth) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(auth), []byte(expected)) == 1
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	snap := s.metricsSnapshot()
	w.Header().Set("Content-Type", coremetrics.ContentType)
	_, _ = w.Write([]byte(coremetrics.Render([]coremetrics.Sample{
		{Name: "caracal_audit_inserts_total", Help: "Audit events inserted into storage", Type: coremetrics.Counter, Value: float64(snap.InsertsTotal)},
		{Name: "caracal_audit_export_events_total", Help: "Audit events exported to archive storage", Type: coremetrics.Counter, Value: float64(snap.ExportEventsTotal)},
		{Name: "caracal_audit_export_errors_total", Help: "Audit export failures", Type: coremetrics.Counter, Value: float64(snap.ExportErrorsTotal)},
		{Name: "caracal_audit_export_duration_seconds", Help: "Most recent audit export duration", Type: coremetrics.Gauge, Value: float64(snap.ExportDurationMs) / 1000},
		{Name: "caracal_audit_export_backlog_hours", Help: "Completed audit hours waiting for Parquet export", Type: coremetrics.Gauge, Value: float64(snap.ExportBacklogHours)},
		{Name: "caracal_audit_consumer_lag", Help: "Audit stream pending entry count", Type: coremetrics.Gauge, Value: float64(snap.ConsumerLag)},
		{Name: "caracal_audit_consumer_pel_oldest_seconds", Help: "Oldest audit pending entry age", Type: coremetrics.Gauge, Value: float64(snap.ConsumerPELOldestSecs)},
		{Name: "caracal_audit_dlq_size", Help: "Audit dead-letter stream size", Type: coremetrics.Gauge, Value: float64(snap.DLQSize)},
		{Name: "caracal_audit_dlq_oldest_age_seconds", Help: "Oldest audit dead-letter event age", Type: coremetrics.Gauge, Value: float64(snap.DLQOldestAgeSecs)},
		{Name: "caracal_audit_parse_errors_total", Help: "Audit stream parse errors", Type: coremetrics.Counter, Value: float64(snap.ParseErrorsTotal)},
		{Name: "caracal_audit_dlq_total", Help: "Audit events moved to the dead-letter stream", Type: coremetrics.Counter, Value: float64(snap.DLQTotal)},
		{Name: "caracal_audit_retries_total", Help: "Audit event delivery retries", Type: coremetrics.Counter, Value: float64(snap.RetriesTotal)},
		{Name: "caracal_audit_hmac_failures_total", Help: "Audit producer HMAC verification failures", Type: coremetrics.Counter, Value: float64(snap.HMACFailuresTotal)},
		{Name: "caracal_audit_tamper_replay_total", Help: "Audit replayed events rejected as tamper attempts", Type: coremetrics.Counter, Value: float64(snap.TamperReplayTotal)},
		{Name: "caracal_audit_tamper_checked_total", Help: "Audit chain events checked for tamper evidence", Type: coremetrics.Counter, Value: float64(snap.TamperCheckedTotal)},
		{Name: "caracal_audit_tamper_mismatch_total", Help: "Audit chain hash mismatches detected", Type: coremetrics.Counter, Value: float64(snap.TamperMismatchTotal)},
		{Name: "caracal_audit_tamper_chain_breaks_total", Help: "Audit chain ordering breaks detected", Type: coremetrics.Counter, Value: float64(snap.TamperChainBreaks)},
		{Name: "caracal_audit_tamper_hmac_failures_total", Help: "Audit stored HMAC mismatches detected", Type: coremetrics.Counter, Value: float64(snap.TamperHMACFailures)},
		{Name: "caracal_audit_tamper_last_sweep_unix", Help: "Unix timestamp of the last audit tamper sweep", Type: coremetrics.Gauge, Value: float64(snap.TamperLastSweepUnix)},
		{Name: "caracal_audit_tamper_last_full_unix", Help: "Unix timestamp of the last full audit tamper sweep", Type: coremetrics.Gauge, Value: float64(snap.TamperLastFullUnix)},
		{Name: "caracal_audit_retention_created_total", Help: "Audit retention partitions created", Type: coremetrics.Counter, Value: float64(snap.RetentionCreatedTotal)},
		{Name: "caracal_audit_retention_dropped_total", Help: "Audit retention partitions dropped", Type: coremetrics.Counter, Value: float64(snap.RetentionDroppedTotal)},
		{Name: "caracal_audit_is_export_leader", Help: "Whether this Audit replica holds the export lease", Type: coremetrics.Gauge, Value: boolFloat(snap.IsExportLeader)},
		{Name: "caracal_audit_is_retention_leader", Help: "Whether this Audit replica holds the retention lease", Type: coremetrics.Gauge, Value: boolFloat(snap.IsRetentionLeader)},
		{Name: "caracal_audit_export_lease_transitions_total", Help: "Audit export leadership changes (acquisitions plus losses)", Type: coremetrics.Counter, Value: float64(snap.ExportLeaseChanges)},
		{Name: "caracal_audit_retention_lease_transitions_total", Help: "Audit retention leadership changes (acquisitions plus losses)", Type: coremetrics.Counter, Value: float64(snap.RetentionLeaseChanges)},
	})))
}

func (s *Server) handleMetricsJSON(w http.ResponseWriter, r *http.Request) {
	if !s.metricsAuthorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(s.metricsSnapshot())
}

// handleSearch serves GET /api/audit/search for operator forensics queries.
// The endpoint is disabled (404) when AUDIT_ADMIN_TOKEN is not configured.
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}

	q := r.URL.Query()
	zoneID := q.Get("zone_id")
	if zoneID == "" {
		http.Error(w, "zone_id is required", http.StatusBadRequest)
		return
	}

	now := time.Now().UTC()
	since := now.Add(-24 * time.Hour)
	until := now
	if s := q.Get("since"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			since = t.UTC()
		}
	}
	if u := q.Get("until"); u != "" {
		if t, err := time.Parse(time.RFC3339, u); err == nil {
			until = t.UTC()
		}
	}

	limit := 100
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 1000 {
		limit = 1000
	}

	var cursor int64
	if c := q.Get("cursor"); c != "" {
		cursor, _ = strconv.ParseInt(c, 10, 64)
	}

	params := SearchParams{
		ZoneID:    zoneID,
		Decision:  q.Get("decision"),
		RequestID: q.Get("request_id"),
		Since:     since,
		Until:     until,
		Limit:     limit,
		Cursor:    cursor,
	}
	results, err := s.pg.Search(r.Context(), params)
	if err != nil {
		s.log.Error().Err(err).Msg("audit search")
		http.Error(w, "search failed", http.StatusInternalServerError)
		return
	}

	nextCursor := ""
	if len(results) > 0 {
		nextCursor = strconv.FormatInt(results[len(results)-1].ChainSeq, 10)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"events":      results,
		"next_cursor": nextCursor,
	})
}

func (s *Server) handleDLQReplay(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			http.Error(w, "limit must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = n
	}
	if limit > 1000 {
		limit = 1000
	}

	summary, err := s.replayDLQ(r.Context(), int64(limit))
	if err != nil {
		s.log.Error().Err(err).Msg("audit dlq replay failed")
		http.Error(w, "dlq replay failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(summary)
}

func (s *Server) handleDLQList(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	limit := 100
	if l := r.URL.Query().Get("limit"); l != "" {
		n, err := strconv.Atoi(l)
		if err != nil || n <= 0 {
			http.Error(w, "limit must be a positive integer", http.StatusBadRequest)
			return
		}
		limit = n
	}
	if limit > 1000 {
		limit = 1000
	}
	start := r.URL.Query().Get("start")
	if start == "" {
		start = "-"
	}
	msgs, err := s.redis.XRangeN(r.Context(), auditDLQStream, start, "+", int64(limit)).Result()
	if err != nil {
		s.log.Error().Err(err).Msg("audit dlq list failed")
		http.Error(w, "dlq list failed", http.StatusInternalServerError)
		return
	}
	entries := make([]dlqEntry, 0, len(msgs))
	for _, msg := range msgs {
		entries = append(entries, dlqEntryFromMessage(msg, time.Now(), false))
	}
	nextCursor := ""
	if len(entries) > 0 {
		nextCursor = entries[len(entries)-1].ID
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"entries":     entries,
		"next_cursor": nextCursor,
	})
}

func (s *Server) handleDLQDetail(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeAdmin(w, r) {
		return
	}
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}
	msgs, err := s.redis.XRangeN(r.Context(), auditDLQStream, id, id, 1).Result()
	if err != nil {
		s.log.Error().Err(err).Str("id", id).Msg("audit dlq detail failed")
		http.Error(w, "dlq detail failed", http.StatusInternalServerError)
		return
	}
	if len(msgs) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(dlqEntryFromMessage(msgs[0], time.Now(), true))
}

func (s *Server) authorizeAdmin(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		http.NotFound(w, r)
		return false
	}
	auth := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(auth), []byte(s.cfg.AdminToken)) != 1 {
		w.Header().Set("WWW-Authenticate", `Bearer realm="caracal-audit"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

type dlqReplaySummary struct {
	Scanned  int64 `json:"scanned"`
	Replayed int64 `json:"replayed"`
	Skipped  int64 `json:"skipped"`
}

type dlqEntry struct {
	ID          string            `json:"id"`
	SourceID    string            `json:"source_id,omitempty"`
	Reason      string            `json:"reason"`
	ReceivedAt  string            `json:"received_at,omitempty"`
	AgeSeconds  int64             `json:"age_seconds"`
	Replayable  bool              `json:"replayable"`
	EventID     string            `json:"event_id,omitempty"`
	ZoneID      string            `json:"zone_id,omitempty"`
	EventType   string            `json:"event_type,omitempty"`
	RequestID   string            `json:"request_id,omitempty"`
	Decision    string            `json:"decision,omitempty"`
	SourceSig   string            `json:"source_sig,omitempty"`
	SourceEvent *AuditEvent       `json:"source_event,omitempty"`
	Fields      map[string]string `json:"fields,omitempty"`
}

func dlqEntryFromMessage(msg redis.XMessage, now time.Time, includeDetail bool) dlqEntry {
	fields := make(map[string]string)
	for key, value := range msg.Values {
		if s, ok := value.(string); ok {
			fields[key] = s
		}
	}
	entry := dlqEntry{
		ID:         msg.ID,
		SourceID:   fields["src_id"],
		Reason:     fields["reason"],
		ReceivedAt: millisStringToRFC3339(fields["received_at"]),
		AgeSeconds: redisIDAgeSeconds(msg.ID, now),
		Replayable: dlqReplayableReason(fields["reason"]) && strings.TrimSpace(fields["src_data"]) != "",
		SourceSig:  fields["src_sig"],
	}
	if raw := fields["src_data"]; raw != "" {
		var ev AuditEvent
		if err := json.Unmarshal([]byte(raw), &ev); err == nil {
			entry.EventID = ev.ID
			entry.ZoneID = ev.ZoneID
			entry.EventType = ev.EventType
			entry.RequestID = ev.RequestID
			entry.Decision = ev.Decision
			if includeDetail {
				entry.SourceEvent = &ev
			}
		}
	}
	if includeDetail {
		entry.Fields = fields
	}
	return entry
}

func millisStringToRFC3339(raw string) string {
	if raw == "" {
		return ""
	}
	millis, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || millis <= 0 {
		return raw
	}
	return time.UnixMilli(millis).UTC().Format(time.RFC3339)
}

func (s *Server) replayDLQ(ctx context.Context, limit int64) (dlqReplaySummary, error) {
	var summary dlqReplaySummary
	if s.redis == nil {
		return summary, errors.New("redis unavailable")
	}
	msgs, err := s.redis.XRangeN(ctx, auditDLQStream, "-", "+", limit).Result()
	if err != nil {
		return summary, err
	}
	for _, msg := range msgs {
		summary.Scanned++
		fields, ok := dlqReplayFields(msg.Values)
		if !ok {
			summary.Skipped++
			continue
		}
		if err := s.redis.XAdd(ctx, &redis.XAddArgs{Stream: auditStream, Values: fields}).Err(); err != nil {
			return summary, err
		}
		if err := s.redis.XDel(ctx, auditDLQStream, msg.ID).Err(); err != nil {
			return summary, err
		}
		summary.Replayed++
	}
	return summary, nil
}

func dlqReplayFields(values map[string]any) (map[string]any, bool) {
	reason, _ := values["reason"].(string)
	if !dlqReplayableReason(reason) {
		return nil, false
	}
	data, ok := values["src_data"].(string)
	if !ok || strings.TrimSpace(data) == "" {
		return nil, false
	}
	fields := map[string]any{"data": data}
	if sig, ok := values["src_sig"].(string); ok && strings.TrimSpace(sig) != "" {
		fields["sig"] = sig
	}
	return fields, true
}

func dlqReplayableReason(reason string) bool {
	return strings.HasPrefix(reason, "transient_exceeded_max_deliveries:") ||
		strings.HasPrefix(reason, "pg_permanent_error:")
}

type auditMetricsSnapshot struct {
	InsertsTotal          int64 `json:"inserts_total"`
	ExportEventsTotal     int64 `json:"export_events_total"`
	ExportErrorsTotal     int64 `json:"export_errors_total"`
	ExportDurationMs      int64 `json:"export_duration_ms"`
	ExportBacklogHours    int64 `json:"export_backlog_hours"`
	ConsumerLag           int64 `json:"consumer_lag"`
	ConsumerPELOldestSecs int64 `json:"consumer_pel_oldest_secs"`
	DLQSize               int64 `json:"dlq_size"`
	DLQOldestAgeSecs      int64 `json:"dlq_oldest_age_secs"`
	ParseErrorsTotal      int64 `json:"parse_errors_total"`
	DLQTotal              int64 `json:"dlq_total"`
	RetriesTotal          int64 `json:"retries_total"`
	HMACFailuresTotal     int64 `json:"hmac_failures_total"`
	TamperReplayTotal     int64 `json:"tamper_replay_total"`
	TamperCheckedTotal    int64 `json:"tamper_checked_total"`
	TamperMismatchTotal   int64 `json:"tamper_mismatch_total"`
	TamperChainBreaks     int64 `json:"tamper_chain_breaks"`
	TamperHMACFailures    int64 `json:"tamper_hmac_failures"`
	TamperLastSweepUnix   int64 `json:"tamper_last_sweep_unix"`
	TamperLastFullUnix    int64 `json:"tamper_last_full_unix"`
	RetentionCreatedTotal int64 `json:"retention_created_total"`
	RetentionDroppedTotal int64 `json:"retention_dropped_total"`
	IsExportLeader        bool  `json:"is_export_leader"`
	IsRetentionLeader     bool  `json:"is_retention_leader"`
	ExportLeaseChanges    int64 `json:"export_lease_changes_total"`
	RetentionLeaseChanges int64 `json:"retention_lease_changes_total"`
}

func (s *Server) metricsSnapshot() auditMetricsSnapshot {
	return auditMetricsSnapshot{
		InsertsTotal:          s.inserts.Load(),
		ExportEventsTotal:     s.exportEvents.Load(),
		ExportErrorsTotal:     s.exportErrors.Load(),
		ExportDurationMs:      s.exportDurMs.Load(),
		ExportBacklogHours:    s.exportBacklog.Load(),
		ConsumerLag:           s.consumerLag.Load(),
		ConsumerPELOldestSecs: s.pelOldestAge.Load(),
		DLQSize:               s.dlqSize.Load(),
		DLQOldestAgeSecs:      s.dlqOldestAge.Load(),
		ParseErrorsTotal:      s.consumer.parseErrors.Load(),
		DLQTotal:              s.consumer.dlqTotal.Load(),
		RetriesTotal:          s.consumer.retriesTotal.Load(),
		HMACFailuresTotal:     s.consumer.hmacFailTotal.Load(),
		TamperReplayTotal:     s.consumer.tamperReplay.Load(),
		TamperCheckedTotal:    s.sweeper.checkedTotal.Load(),
		TamperMismatchTotal:   s.sweeper.mismatchTotal.Load(),
		TamperChainBreaks:     s.sweeper.chainBreak.Load(),
		TamperHMACFailures:    s.sweeper.hmacMismatch.Load(),
		TamperLastSweepUnix:   s.sweeper.lastSweepUnix.Load(),
		TamperLastFullUnix:    s.sweeper.lastFullUnix.Load(),
		RetentionCreatedTotal: s.retention.createdTotal.Load(),
		RetentionDroppedTotal: s.retention.droppedTotal.Load(),
		IsExportLeader:        s.exporterLead.Held(),
		IsRetentionLeader:     s.retentLead.Held(),
		ExportLeaseChanges:    s.exporterLead.Transitions(),
		RetentionLeaseChanges: s.retentLead.Transitions(),
	}
}

func boolFloat(value bool) float64 {
	if value {
		return 1
	}
	return 0
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
			s.pollDLQ(ctx)
		}
	}
}

func (s *Server) pollDLQ(ctx context.Context) {
	size, err := s.redis.XLen(ctx, auditDLQStream).Result()
	if err != nil {
		s.log.Warn().Err(err).Msg("dlq size poll")
		return
	}
	s.dlqSize.Store(size)
	msgs, err := s.redis.XRangeN(ctx, auditDLQStream, "-", "+", 1).Result()
	if err != nil || len(msgs) == 0 {
		s.dlqOldestAge.Store(0)
		return
	}
	s.dlqOldestAge.Store(redisIDAgeSeconds(msgs[0].ID, time.Now()))
}

func redisIDAgeSeconds(id string, now time.Time) int64 {
	ms, _, ok := strings.Cut(id, "-")
	if !ok {
		return 0
	}
	unixMs, err := strconv.ParseInt(ms, 10, 64)
	if err != nil || unixMs <= 0 {
		return 0
	}
	age := now.Sub(time.UnixMilli(unixMs))
	if age < 0 {
		return 0
	}
	return int64(age / time.Second)
}

func writeReadyFailure(w http.ResponseWriter, reason string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusServiceUnavailable)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":     false,
		"ready":  false,
		"reason": reason,
	})
}
