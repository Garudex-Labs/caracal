// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Workspace-wide lint rules for every TypeScript source the per-app configs do not already cover.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// apps/auth and apps/web carry their own configs because they need framework-specific plugins.
// Everything else is linted from here, so a workspace can never go unlinted by omitting a config.
const OWN_CONFIG = ['apps/auth/**', 'apps/web/**']

export default tseslint.config(
  {
    ignores: [
      ...OWN_CONFIG,
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'docs/**',
      'packages/engine/src/embedded.ts',
      'apps/web/src/routeTree.gen.ts',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, globals: globals.node, parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      // Control characters are matched deliberately: NUL is stripped before values reach
      // Postgres, and ANSI sequences are parsed for terminal styling.
      'no-control-regex': 'off',
      // Flags defensive initializers that a catch branch still relies on.
      'no-useless-assignment': 'off',
      // `outer` is the established name for the instance a returned closure binds to.
      '@typescript-eslint/no-this-alias': ['error', { allowedNames: ['outer'] }],
    },
  },
  {
    // Promise-safety needs type information. It is scoped to service and package sources rather
    // than the whole tree because those are the paths where a dropped promise silently skips
    // audit, outbox, or revocation work instead of failing the request.
    files: [
      'apps/api/src/**/*.ts',
      'apps/coordinator/src/**/*.ts',
      'apps/runtime/src/**/*.ts',
      'packages/*/src/**/*.ts',
      'packages/*/ts/src/**/*.ts',
      'packages/*/*/ts/src/**/*.ts',
    ],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },
)
