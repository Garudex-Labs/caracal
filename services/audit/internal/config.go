// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Audit service configuration.

package internal

import (
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/garudex-labs/caracal/packages/core/go/config"
)

const auditPort = "9090"

type Config struct {
	config.Base
	S3Endpoint         string
	S3Bucket           string
	S3Region           string
	AuditHMACKey       []byte
	AdminToken         string
	MetricsBearer      string
	RetentionDays      int
	ConsumerName       string
	MaxDeliveries      int64
	ClaimIdleSecs      int64
	TamperRollingHours int
	ReadyDLQMax        int64
	ReadyLagMax        int64
	ReadyPELOldestMax  int64
}

func loadConfig() (Config, error) {
	config.ResolveFileSecrets("AUDIT_HMAC_KEY")
	config.ResolveFileSecrets("AUDIT_ADMIN_TOKEN")
	config.ResolveFileSecrets("METRICS_BEARER")
	hexKey := config.Getenv("AUDIT_HMAC_KEY", "")
	var key []byte
	base := config.Load()
	if base.Port != auditPort {
		return Config{}, fmt.Errorf("PORT must be %s for audit", auditPort)
	}
	if hexKey != "" {
		k, err := hex.DecodeString(hexKey)
		if err != nil {
			return Config{}, fmt.Errorf("AUDIT_HMAC_KEY: invalid hex: %w", err)
		}
		if len(k) < 32 {
			return Config{}, errors.New("AUDIT_HMAC_KEY: must be at least 32 bytes")
		}
		key = k
	} else if base.IsPublished() {
		return Config{}, errors.New("AUDIT_HMAC_KEY: required when CARACAL_MODE=rc or CARACAL_MODE=stable")
	}
	retention := config.IntEnv("AUDIT_RETENTION_DAYS", 365)
	maxDeliv := config.Int64Env("AUDIT_MAX_DELIVERIES", 8)
	idleSecs := config.Int64Env("AUDIT_CLAIM_IDLE_SECS", 30)
	rolling := config.IntEnv("AUDIT_TAMPER_ROLLING_HOURS", 4)
	readyDLQ := config.Int64Env("AUDIT_READY_DLQ_MAX", 0)
	readyLag := config.Int64Env("AUDIT_READY_LAG_MAX", 0)
	readyPEL := config.Int64Env("AUDIT_READY_PEL_OLDEST_SECS_MAX", 0)
	return Config{
		Base:               base,
		S3Endpoint:         config.Getenv("AUDIT_EXPORT_S3_ENDPOINT", ""),
		S3Bucket:           config.Getenv("AUDIT_EXPORT_S3_BUCKET", ""),
		S3Region:           config.Getenv("AUDIT_EXPORT_S3_REGION", "us-east-1"),
		AuditHMACKey:       key,
		AdminToken:         config.Getenv("AUDIT_ADMIN_TOKEN", ""),
		MetricsBearer:      config.Getenv("METRICS_BEARER", ""),
		RetentionDays:      retention,
		ConsumerName:       config.Getenv("HOSTNAME", "audit-worker-0"),
		MaxDeliveries:      maxDeliv,
		ClaimIdleSecs:      idleSecs,
		TamperRollingHours: rolling,
		ReadyDLQMax:        readyDLQ,
		ReadyLagMax:        readyLag,
		ReadyPELOldestMax:  readyPEL,
	}, nil
}
