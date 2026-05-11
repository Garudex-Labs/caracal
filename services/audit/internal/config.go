// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service configuration.

package internal

import (
	"encoding/hex"
	"strconv"

	"github.com/garudex-labs/caracal/core/config"
)

type Config struct {
	config.Base
	S3Endpoint         string
	S3Bucket           string
	S3Region           string
	HMACKey            []byte
	RetentionDays      int
	ConsumerName       string
	MaxDeliveries      int64
	ClaimIdleSecs      int64
	TamperRollingHours int
}

func loadConfig() Config {
	hexKey := config.Getenv("AUDIT_HMAC_KEY", "")
	var key []byte
	base := config.Load()
	if hexKey != "" {
		k, err := hex.DecodeString(hexKey)
		if err != nil {
			panic("AUDIT_HMAC_KEY: invalid hex: " + err.Error())
		}
		if len(k) < 32 {
			panic("AUDIT_HMAC_KEY: must be at least 32 bytes")
		}
		key = k
	} else if base.IsProduction() {
		panic("AUDIT_HMAC_KEY: required in production")
	}
	retention, _ := strconv.Atoi(config.Getenv("AUDIT_RETENTION_DAYS", "365"))
	if retention < 1 {
		retention = 365
	}
	maxDeliv, _ := strconv.ParseInt(config.Getenv("AUDIT_MAX_DELIVERIES", "5"), 10, 64)
	idleSecs, _ := strconv.ParseInt(config.Getenv("AUDIT_CLAIM_IDLE_SECS", "30"), 10, 64)
	rolling, _ := strconv.Atoi(config.Getenv("AUDIT_TAMPER_ROLLING_HOURS", "4"))
	if rolling < 1 {
		rolling = 4
	}
	return Config{
		Base:               base,
		S3Endpoint:         config.Getenv("AUDIT_EXPORT_S3_ENDPOINT", ""),
		S3Bucket:           config.Getenv("AUDIT_EXPORT_S3_BUCKET", ""),
		S3Region:           config.Getenv("AUDIT_EXPORT_S3_REGION", "us-east-1"),
		HMACKey:            key,
		RetentionDays:      retention,
		ConsumerName:       config.Getenv("HOSTNAME", "audit-worker-0"),
		MaxDeliveries:      maxDeliv,
		ClaimIdleSecs:      idleSecs,
		TamperRollingHours: rolling,
	}
}
