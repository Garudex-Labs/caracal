// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package harnessdata embeds the canonical harness registry. Keep this
// package dependency-free: typed parsing lives in internal/harness.
package harnessdata

import "embed"

// RegistryJSON is the raw contents of registry.json, the single source of
// truth for harness metadata across the CLI, server, and web (via the API).
//
//go:embed registry.json
var RegistryJSON []byte

// ModelsFS holds the per-harness model catalogs (harness_models/<name>.json),
// each listing the model identifiers a harness accepts.
//
//go:embed harness_models/*.json
var ModelsFS embed.FS

// LiteLLMCatalogJSON is the vendored LiteLLM model catalog snapshot backing
// the Insights model picker.
//
//go:embed litellm_model_catalog.json
var LiteLLMCatalogJSON []byte
