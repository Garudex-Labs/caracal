// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Tamper-detection sweep: verifies per-zone hash chain integrity by recomputing
// content_sha256 + chain HMAC and checking continuity of prev_content_sha256.

package internal

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"sync/atomic"
	"time"

	"github.com/rs/zerolog"
)

type TamperSweeper struct {
	db            *PGWriter
	hmacKey       []byte
	log           zerolog.Logger
	retention     time.Duration
	rolling       time.Duration
	checkedTotal  atomic.Int64
	mismatchTotal atomic.Int64
	chainBreak    atomic.Int64
	hmacMismatch  atomic.Int64
	lastSweepUnix atomic.Int64
	lastFullUnix  atomic.Int64
}

func newTamperSweeper(db *PGWriter, key []byte, retention, rolling time.Duration, log zerolog.Logger) *TamperSweeper {
	return &TamperSweeper{db: db, hmacKey: key, log: log, retention: retention, rolling: rolling}
}

// Run performs a startup sweep covering the full retention window so an attacker
// cannot hide tampering older than the rolling cadence, then ticks hourly with a
// shorter overlap to catch fresh writes promptly.
func (s *TamperSweeper) Run(ctx context.Context) {
	s.sweep(ctx, s.retention, true)
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sweep(ctx, s.rolling, false)
		}
	}
}

func (s *TamperSweeper) sweep(ctx context.Context, lookback time.Duration, full bool) {
	until := time.Now().UTC()
	since := until.Add(-lookback)

	prevByZone := map[string]string{}
	prevSeqByZone := map[string]int64{}
	checked := 0
	mismatches := 0
	breaks := 0
	hmacFails := 0

	err := s.db.QuerySinceFn(ctx, since, until, true, func(r EventRow) error {
		checked++
		want := contentHash(r.Event)
		if want != r.ContentSHA256 {
			mismatches++
			s.log.Error().
				Str("event_id", r.Event.ID).
				Str("zone_id", r.Event.ZoneID).
				Int64("chain_seq", r.ChainSeq).
				Msg("tamper: content hash mismatch")
		}
		if prev, ok := prevByZone[r.Event.ZoneID]; ok {
			if r.PrevContentSHA256 != prev {
				breaks++
				s.log.Error().
					Str("zone_id", r.Event.ZoneID).
					Int64("chain_seq", r.ChainSeq).
					Int64("prev_seq", prevSeqByZone[r.Event.ZoneID]).
					Msg("tamper: chain break (prev hash mismatch)")
			}
		}
		if len(s.hmacKey) > 0 {
			mac := hmac.New(sha256.New, s.hmacKey)
			mac.Write([]byte(r.ContentSHA256))
			mac.Write([]byte{'|'})
			mac.Write([]byte(r.PrevContentSHA256))
			if hex.EncodeToString(mac.Sum(nil)) != r.ChainHMAC {
				hmacFails++
				s.log.Error().
					Str("event_id", r.Event.ID).
					Str("zone_id", r.Event.ZoneID).
					Msg("tamper: chain HMAC mismatch")
			}
		}
		prevByZone[r.Event.ZoneID] = r.ContentSHA256
		prevSeqByZone[r.Event.ZoneID] = r.ChainSeq
		return nil
	})
	if err != nil {
		s.log.Error().Err(err).Msg("tamper sweep query")
		return
	}
	s.checkedTotal.Add(int64(checked))
	s.mismatchTotal.Add(int64(mismatches))
	s.chainBreak.Add(int64(breaks))
	s.hmacMismatch.Add(int64(hmacFails))
	s.lastSweepUnix.Store(time.Now().Unix())
	if full {
		s.lastFullUnix.Store(time.Now().Unix())
	}
	level := s.log.Info()
	if mismatches > 0 || breaks > 0 || hmacFails > 0 {
		level = s.log.Error()
	}
	level.
		Bool("full", full).
		Dur("window", lookback).
		Int("checked", checked).
		Int("mismatches", mismatches).
		Int("chain_breaks", breaks).
		Int("hmac_failures", hmacFails).
		Msg("tamper sweep complete")
}
