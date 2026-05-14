// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service configuration.

package internal

import (
	"encoding/hex"

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
	} else if base.IsRuntime() {
		panic("AUDIT_HMAC_KEY: required when CARACAL_MODE=runtime")
	}
	retention := config.PositiveIntEnv("AUDIT_RETENTION_DAYS", 365)
	maxDeliv := config.PositiveInt64Env("AUDIT_MAX_DELIVERIES", 5)
	idleSecs := config.PositiveInt64Env("AUDIT_CLAIM_IDLE_SECS", 30)
	rolling := config.PositiveIntEnv("AUDIT_TAMPER_ROLLING_HOURS", 4)
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
