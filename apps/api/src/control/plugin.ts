// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Fastify plugin that mounts the in-process Control invoke surface on the API when the control mode is enabled.

import type { FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { AdminClient } from '@caracalai/admin'
import { createLogger } from '@caracalai/core'
import type { ControlConfig } from '../config.js'
import type { RedisClient } from '../redis.js'
import { Authenticator } from './auth.js'
import { RedisSink } from './audit.js'
import { RateLimiter } from './ratelimit.js'
import { RedisReplay } from './replay.js'
import { fileGate } from './gate.js'
import { registerInvokeRoute } from './handler.js'

export interface ControlPluginOptions {
  cfg: ControlConfig
  redis: RedisClient
  auditHmacKey: Buffer | null
  controlLogLevel: string
  // The reserved Operator's application id, used to authorize its cross-zone governance. Null
  // until the system zone is provisioned, or when self-governance is disabled.
  resolvePlatformOperatorSubject?: () => string | null
}

const controlPluginImpl: FastifyPluginAsync<ControlPluginOptions> = async (app, opts) => {
  const { cfg, redis, auditHmacKey, controlLogLevel } = opts
  const log = createLogger('control', controlLogLevel as 'info')
  const auth = new Authenticator({ jwksUrl: cfg.jwksUrl, issuer: cfg.issuer, audience: cfg.audience })
  const replay = new RedisReplay(redis, cfg.replayTtlSec * 1000)
  const rate = new RateLimiter(cfg.rateCapacity, cfg.rateWindowSec * 1000)
  const admin = new AdminClient({ apiUrl: cfg.apiUrl, adminToken: cfg.apiToken })
  const sink = new RedisSink(redis, auditHmacKey ?? undefined, log)
  const gate = fileGate(cfg.gateFile)

  registerInvokeRoute(app, {
    auth,
    replay,
    rate,
    sink,
    ctx: { admin },
    gate,
    redis,
    ipRateLimitPerMin: cfg.ipRateLimitPerMin,
    resolvePlatformOperatorSubject: opts.resolvePlatformOperatorSubject,
  })
}

export const controlPlugin = fp(controlPluginImpl, { name: 'control' })
