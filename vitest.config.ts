// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Vitest workspace resolver configuration for TypeScript package sources.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      exclude: [
        'packages/core/ts/src/index.ts',
        'packages/identity/ts/src/index.ts',
        'packages/oauth/ts/src/index.ts',
        'packages/revocation/ts/src/index.ts',
        'packages/sdk/ts/src/index.ts',
        'packages/admin/ts/src/index.ts',
        'packages/engine/src/index.ts',
        'packages/transport/mcp/ts/src/index.ts',
        'packages/transport/a2a/ts/src/index.ts',
        'packages/connectors/redis/ts/src/index.ts',
        'packages/connectors/postgres/ts/src/index.ts',
        'packages/connectors/fastmcp/ts/src/index.ts',
        'packages/connectors/express/ts/src/index.ts',
        'packages/core/ts/src/json.ts',
        'packages/sdk/ts/src/json.ts',
        'packages/transport/mcp/ts/src/types.ts',
        'packages/transport/a2a/ts/src/types.ts',
        'packages/admin/ts/src/types.ts',
        'packages/identity/ts/src/scope.ts',
        'packages/revocation/ts/src/iface.ts',
        'apps/*/src/main.ts',
      ],
    },
  },
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: src('./apps/web/src/$1') },
      { find: /^react$/, replacement: src('./apps/web/node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: src('./apps/web/node_modules/react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: src('./apps/web/node_modules/react-dom/index.js') },
      { find: /^react-dom\/server$/, replacement: src('./apps/web/node_modules/react-dom/server.node.js') },
      { find: /^nodemailer$/, replacement: src('./apps/auth/node_modules/nodemailer/lib/nodemailer.js') },
      { find: /^@caracalai\/engine\/runtime-config$/, replacement: src('./packages/engine/src/runtimeConfig.ts') },
      { find: /^@caracalai\/engine\/commands$/, replacement: src('./packages/engine/src/commands.ts') },
      { find: /^@caracalai\/engine\/crash$/, replacement: src('./packages/engine/src/crash.ts') },
      { find: /^@caracalai\/engine\/scrubCwdEnv$/, replacement: src('./packages/engine/src/scrubCwdEnv.ts') },
      { find: /^@caracalai\/sdk\/advanced$/, replacement: src('./packages/sdk/ts/src/advanced.ts') },
      { find: /^@caracalai\/admin$/, replacement: src('./packages/admin/ts/src/index.ts') },
      { find: /^@caracalai\/admin-audit$/, replacement: src('./packages/adminAudit/ts/src/index.ts') },
      { find: /^@caracalai\/core$/, replacement: src('./packages/core/ts/src/index.ts') },
      { find: /^@caracalai\/engine$/, replacement: src('./packages/engine/src/index.ts') },
      { find: /^@caracalai\/identity$/, replacement: src('./packages/identity/ts/src/index.ts') },
      { find: /^@caracalai\/mcp-express$/, replacement: src('./packages/connectors/express/ts/src/index.ts') },
      { find: /^@caracalai\/mcp-fastmcp$/, replacement: src('./packages/connectors/fastmcp/ts/src/index.ts') },
      { find: /^@caracalai\/oauth$/, replacement: src('./packages/oauth/ts/src/index.ts') },
      { find: /^@caracalai\/revocation$/, replacement: src('./packages/revocation/ts/src/index.ts') },
      { find: /^@caracalai\/revocation-redis$/, replacement: src('./packages/connectors/redis/ts/src/index.ts') },
      { find: /^@caracalai\/sdk$/, replacement: src('./packages/sdk/ts/src/index.ts') },
      { find: /^@caracalai\/tokenstate-postgres$/, replacement: src('./packages/connectors/postgres/ts/src/index.ts') },
      { find: /^@caracalai\/transport-a2a$/, replacement: src('./packages/transport/a2a/ts/src/index.ts') },
      { find: /^@caracalai\/transport-mcp$/, replacement: src('./packages/transport/mcp/ts/src/index.ts') },
    ],
  },
})
