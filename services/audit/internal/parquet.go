// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Hourly OCSF v1.7.0 Parquet export to S3, watermark-driven with catch-up.
// Windows are computed by ingested_at so late-arriving events still ship.

package internal

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/parquet-go/parquet-go"
	"github.com/rs/zerolog"
)

const (
	exportWatermarkName = "parquet-hourly"
	exportLockKey       = int64(0x4341524130303031) // "CARA0001"
	exportWriteBatch    = 1000
)

type ParquetExporter struct {
	pg        *PGWriter
	s3Client  *s3.Client
	bucket    string
	log       zerolog.Logger
	leader    *Leader
	onExport  func(events int64, durMs int64, failed bool)
	onBacklog func(hours int64)
}

func newParquetExporter(pg *PGWriter, cfg Config, leader *Leader, log zerolog.Logger) (*ParquetExporter, error) {
	if cfg.S3Bucket == "" {
		return &ParquetExporter{pg: pg, log: log, leader: leader}, nil
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(context.Background(),
		awsconfig.WithRegion(cfg.S3Region),
	)
	if err != nil {
		return nil, err
	}
	opts := []func(*s3.Options){}
	if cfg.S3Endpoint != "" {
		endpoint := cfg.S3Endpoint
		opts = append(opts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		})
	}
	return &ParquetExporter{
		pg:       pg,
		s3Client: s3.NewFromConfig(awsCfg, opts...),
		bucket:   cfg.S3Bucket,
		log:      log,
		leader:   leader,
	}, nil
}

func (e *ParquetExporter) Run(ctx context.Context) {
	e.tick(ctx)
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.tick(ctx)
		}
	}
}

func (e *ParquetExporter) tick(ctx context.Context) {
	if e.s3Client == nil {
		return
	}
	if e.leader != nil && !e.leader.Held() {
		return
	}
	target := time.Now().UTC().Truncate(time.Hour).Add(-time.Hour)
	wm, err := e.pg.LoadWatermark(ctx, exportWatermarkName)
	if err != nil {
		e.log.Error().Err(err).Msg("export: load watermark")
		return
	}
	var start time.Time
	if wm.IsZero() {
		start = target // fresh install: only export the most recent complete hour
	} else {
		start = wm.UTC().Add(time.Hour)
	}
	backlog := int64(0)
	if !start.After(target) {
		backlog = int64(target.Sub(start)/time.Hour) + 1
	}
	if e.onBacklog != nil {
		e.onBacklog(backlog)
	}
	for hour := start; !hour.After(target); hour = hour.Add(time.Hour) {
		if ctx.Err() != nil {
			return
		}
		t0 := time.Now()
		n, err := e.exportHour(ctx, hour)
		dur := time.Since(t0).Milliseconds()
		if e.onExport != nil {
			e.onExport(n, dur, err != nil)
		}
		if err != nil {
			e.log.Error().Err(err).Time("hour", hour).Msg("export hour failed; will retry next tick")
			return
		}
		if err := e.pg.SaveWatermark(ctx, exportWatermarkName, hour); err != nil {
			e.log.Error().Err(err).Time("hour", hour).Msg("save watermark")
			return
		}
		e.log.Info().Time("hour", hour).Int64("events", n).Int64("dur_ms", dur).Msg("export hour ok")
	}
}

func (e *ParquetExporter) exportHour(ctx context.Context, hour time.Time) (int64, error) {
	since := hour
	until := hour.Add(time.Hour)

	var buf bytes.Buffer
	writer := parquet.NewGenericWriter[OCSFEvent](&buf)
	batch := make([]OCSFEvent, 0, exportWriteBatch)
	var count int64
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		n, err := writer.Write(batch)
		count += int64(n)
		batch = batch[:0]
		return err
	}
	err := e.pg.QuerySinceFn(ctx, since, until, true, func(r EventRow) error {
		batch = append(batch, toOCSF(r.Event, r.ContentSHA256, r.ChainHMAC, r.ChainSeq))
		if len(batch) < exportWriteBatch {
			return nil
		}
		return flush()
	})
	if err != nil {
		return 0, err
	}
	if err := flush(); err != nil {
		return 0, err
	}
	if err := writer.Close(); err != nil {
		return 0, err
	}
	if count == 0 {
		return 0, nil
	}
	key := fmt.Sprintf("audit/%s/%s.parquet",
		hour.Format("2006/01/02"), hour.Format("2006-01-02T15"))
	_, err = e.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(e.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(buf.Bytes()),
		ContentType: aws.String("application/octet-stream"),
		IfNoneMatch: aws.String("*"),
	})
	if err != nil {
		if isS3PreconditionFailed(err) {
			e.log.Warn().Str("key", key).Msg("export: object already exists; skipping")
			return count, nil
		}
		return 0, err
	}
	return count, nil
}

func isS3PreconditionFailed(err error) bool {
	var apiErr smithy.APIError
	return errors.As(err, &apiErr) && apiErr.ErrorCode() == "PreconditionFailed"
}
