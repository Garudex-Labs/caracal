// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package harnessgen renders agent installations into harness-specific
// configuration: one adapter per harness, shared context builders, and the
// registry data as the single source of paths and keys.
package harnessgen

import (
	"bytes"
	"encoding/json"

	"github.com/garudex-labs/caracal/internal/harness"
)

// Agent is the composition input: identity, latest-version delegates, and
// ordered component links.
type Agent struct {
	ID                   string
	Name                 string
	Slug                 string
	Description          string
	Prompt               string
	ModelName            string
	ModelsByHarness      map[string]any
	ExternalMcps         []any
	RequiredCapabilities []any
	Components           []ComponentLink
}

// ItemSlug is the agent's stable identity: slug when set, name otherwise.
func (a *Agent) ItemSlug() string {
	if a.Slug != "" {
		return a.Slug
	}
	return a.Name
}

// ComponentLink is one ordered component reference.
type ComponentLink struct {
	Type           string
	ID             string
	OrderIndex     int64
	ConfigOverride map[string]any
}

// Listing carries one component listing's fields (latest-version delegates
// resolved), keyed by column name.
type Listing map[string]any

func (l Listing) str(key string) string {
	s, _ := l[key].(string)
	return s
}

func (l Listing) strOr(key, fallback string) string {
	if s, ok := l[key].(string); ok && s != "" {
		return s
	}
	return fallback
}

func (l Listing) dict(key string) map[string]any {
	d, _ := l[key].(map[string]any)
	return d
}

func (l Listing) list(key string) []any {
	v, _ := l[key].([]any)
	return v
}

// ItemSlug mirrors the registry item identity rule.
func (l Listing) ItemSlug() string {
	if s := l.str("slug"); s != "" {
		return s
	}
	return l.str("name")
}

// Request bundles everything one generation run needs.
type Request struct {
	Agent          *Agent
	Harness        string
	CaracalURL     string
	McpListings    map[string]Listing
	SkillListings  map[string]Listing
	HookListings   map[string]Listing
	PromptListings map[string]Listing
	ComponentNames map[string]string
	EnvValues      map[string]map[string]string
	HeaderValues   map[string]map[string]string
	Options        map[string]any
	Platform       string
	// ResolvedModel and ModelWarnings come from the model resolver.
	ResolvedModel string
	ModelWarnings []string
}

// Config is an insertion-ordered string-keyed map; harness config keys flow
// into rendered file content, where ordering is part of the output.
type Config struct {
	keys []string
	m    map[string]any
}

func NewConfig() *Config { return &Config{m: map[string]any{}} }

func (o *Config) Set(key string, value any) {
	if _, ok := o.m[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.m[key] = value
}

func (o *Config) Get(key string) (any, bool) {
	v, ok := o.m[key]
	return v, ok
}

func (o *Config) Keys() []string { return o.keys }

func (o *Config) Len() int { return len(o.keys) }

// StoredJSON renders the config the way it is persisted: key order kept,
// separators padded with a space.
func (o *Config) StoredJSON() (string, error) {
	blob, err := o.MarshalJSON()
	if err != nil {
		return "", err
	}
	return respaceJSON(blob), nil
}

func (o *Config) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		kb, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(kb)
		buf.WriteByte(':')
		vb, err := json.Marshal(o.m[k])
		if err != nil {
			return nil, err
		}
		buf.Write(vb)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// specOf returns the harness spec; generation requires a known harness.
func specOf(name string) (*harness.Spec, bool) {
	return registry().Spec(name)
}

var loadedRegistry *harness.Registry

func registry() *harness.Registry {
	if loadedRegistry == nil {
		loadedRegistry = harness.MustLoad()
	}
	return loadedRegistry
}

// Delete removes a key, preserving the order of the others.
func (o *Config) Delete(key string) {
	if _, ok := o.m[key]; !ok {
		return
	}
	delete(o.m, key)
	for i, k := range o.keys {
		if k == key {
			o.keys = append(o.keys[:i], o.keys[i+1:]...)
			break
		}
	}
}
