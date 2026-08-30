// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, globalIgnores } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores(["dist/**", "src/routeTree.gen.ts"]),
  // Syntax-level TS linting (no type information) keeps `pnpm lint` fast;
  // tsc --noEmit remains the type gate.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}", "mock/**/*.ts", "vite.config.ts"],
  })),
  {
    files: ["src/**/*.{ts,tsx}", "mock/**/*.ts", "vite.config.ts"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // The API layer's request bodies and registry payloads are deliberately
      // open; unused-vars stays an error with the standard underscore escape.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // TanStack Router file routes export the `Route` definition (plus lazy
    // component bindings), never fast-refreshable components, so the
    // react-refresh boundary rule does not apply to them.
    files: ["src/routes/**/*.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
]);

export default eslintConfig;
