// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Shared structured logger and per-request context for the authentication backend-for-frontend.

import { createLogger, type Logger } from '@caracalai/core'

export const logger: Logger = createLogger('caracal-auth')

export interface RequestContext {
  id: string
  log: Logger
}
