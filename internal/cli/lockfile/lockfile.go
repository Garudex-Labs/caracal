// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package lockfile records the installed registry state: agents and
// standalone components per harness, keyed by the normalized registry URL.
package lockfile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/config"
)

// LockVersion is the current schema version.
const LockVersion = 2

// Path returns the lockfile location.
func Path() string { return filepath.Join(config.Dir(), "lockfile.json") }

func lockPath() string { return filepath.Join(config.Dir(), "lockfile.lock") }

// NormalizeServerURL returns the stable registry key for a server URL.
func NormalizeServerURL(serverURL string) (string, error) {
	value := strings.TrimSpace(serverURL)
	if !strings.Contains(value, "://") {
		value = "http://" + value
	}
	parts, err := url.Parse(value)
	if err != nil || parts.Hostname() == "" {
		return "", fmt.Errorf("A configured server URL is required for lockfile operations")
	}
	scheme := strings.ToLower(parts.Scheme)
	host := strings.ToLower(parts.Hostname())
	port := parts.Port()
	defaultPort := (scheme == "http" && port == "80") || (scheme == "https" && port == "443")
	netloc := host
	if port != "" && !defaultPort {
		netloc = host + ":" + port
	}
	return scheme + "://" + netloc + strings.TrimRight(parts.Path, "/"), nil
}

// CurrentRegistryURL resolves the configured server to its registry key.
func CurrentRegistryURL() (string, error) {
	cfg, cerr := config.Load()
	if cerr != nil {
		return "", fmt.Errorf("%s", cerr.Message)
	}
	return NormalizeServerURL(config.Str(cfg, "server_url"))
}

// Entry is one installed agent or standalone component.
type Entry struct {
	Type          string           `json:"type,omitempty"`
	Name          string           `json:"name"`
	ID            string           `json:"id"`
	Version       *string          `json:"version"`
	PulledAt      string           `json:"pulled_at,omitempty"`
	InstalledAt   string           `json:"installed_at,omitempty"`
	Scope         string           `json:"scope"`
	Directory     string           `json:"directory,omitempty"`
	Components    []map[string]any `json:"components,omitempty"`
	Integrity     string           `json:"integrity,omitempty"`
	Namespace     string           `json:"namespace,omitempty"`
	Slug          string           `json:"slug,omitempty"`
	QualifiedName string           `json:"qualified_name,omitempty"`
	LocalName     string           `json:"local_name,omitempty"`
}

// Harness groups the entries of one harness.
type Harness struct {
	Agents     []Entry `json:"agents"`
	Standalone []Entry `json:"standalone"`
}

// Registry is one registry's installed state.
type Registry struct {
	ServerURL string              `json:"server_url"`
	Harnesses map[string]*Harness `json:"harnesses"`
}

// File is the complete multi-registry lockfile.
type File struct {
	LockVersion int                  `json:"lock_version"`
	UpdatedAt   string               `json:"updated_at"`
	Registries  map[string]*Registry `json:"registries"`
}

func emptyFile() *File {
	return &File{LockVersion: LockVersion, UpdatedAt: isoNow(), Registries: map[string]*Registry{}}
}

func isoNow() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000000+00:00")
}

// Read loads the lockfile, migrating a version 1 layout once.
func Read() (*File, error) {
	if err := migrateV1(""); err != nil {
		return nil, err
	}
	blob, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return emptyFile(), nil
		}
		return nil, fmt.Errorf("Cannot read %s: %w", Path(), err)
	}
	var data File
	if err := json.Unmarshal(blob, &data); err != nil {
		return nil, fmt.Errorf("Cannot read %s: %w", Path(), err)
	}
	if data.LockVersion != LockVersion || data.Registries == nil {
		return nil, fmt.Errorf("Unsupported lockfile version in %s", Path())
	}
	return &data, nil
}

// migrateV1 assigns a version 1 lockfile to its configured registry.
func migrateV1(serverURL string) error {
	blob, err := os.ReadFile(Path())
	if err != nil {
		return nil
	}
	var probe struct {
		LockVersion int             `json:"lock_version"`
		Harnesses   json.RawMessage `json:"harnesses"`
	}
	if json.Unmarshal(blob, &probe) != nil || probe.LockVersion != 1 {
		return nil
	}
	registryURL := serverURL
	if registryURL == "" {
		registryURL, err = CurrentRegistryURL()
		if err != nil {
			return err
		}
	} else if registryURL, err = NormalizeServerURL(registryURL); err != nil {
		return err
	}
	harnesses := map[string]*Harness{}
	if len(probe.Harnesses) > 0 {
		_ = json.Unmarshal(probe.Harnesses, &harnesses)
	}
	return Write(&File{
		Registries: map[string]*Registry{
			registryURL: {ServerURL: registryURL, Harnesses: harnesses},
		},
	})
}

// MigrateV1 re-homes a version 1 lockfile under the given server URL.
func MigrateV1(serverURL string) error { return migrateV1(serverURL) }

// Write persists the lockfile atomically under the advisory lock.
func Write(data *File) error {
	data.UpdatedAt = isoNow()
	data.LockVersion = LockVersion
	if data.Registries == nil {
		data.Registries = map[string]*Registry{}
	}
	if err := os.MkdirAll(config.Dir(), 0o755); err != nil {
		return err
	}
	lockFile, err := os.OpenFile(lockPath(), os.O_WRONLY|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = lockFile.Close() }()
	if err := flockExclusive(lockFile); err != nil {
		return err
	}
	defer flockRelease(lockFile)

	blob, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := strings.TrimSuffix(Path(), ".json") + ".tmp"
	if err := os.WriteFile(tmpPath, append(blob, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmpPath, Path())
}

// ReadRegistry returns the lockfile plus the current registry section.
func ReadRegistry(create bool) (*File, *Registry, error) {
	data, err := Read()
	if err != nil {
		return nil, nil, err
	}
	serverURL, err := CurrentRegistryURL()
	if err != nil {
		return nil, nil, err
	}
	registry, ok := data.Registries[serverURL]
	if !ok {
		registry = &Registry{ServerURL: serverURL, Harnesses: map[string]*Harness{}}
		if create {
			data.Registries[serverURL] = registry
		}
	}
	if registry.Harnesses == nil {
		registry.Harnesses = map[string]*Harness{}
	}
	return data, registry, nil
}

func ensureHarness(registry *Registry, harness string) *Harness {
	section, ok := registry.Harnesses[harness]
	if !ok || section == nil {
		section = &Harness{Agents: []Entry{}, Standalone: []Entry{}}
		registry.Harnesses[harness] = section
	}
	if section.Agents == nil {
		section.Agents = []Entry{}
	}
	if section.Standalone == nil {
		section.Standalone = []Entry{}
	}
	return section
}

// LocalRegistryName uses the bare slug unless another installed namespace
// or registry already claims it.
func LocalRegistryName(harness, componentType, namespace, slug, scope, directory string) (string, error) {
	data, err := Read()
	if err != nil {
		return "", err
	}
	currentURL, err := CurrentRegistryURL()
	if err != nil {
		return "", err
	}
	type match struct {
		registryURL string
		entry       Entry
	}
	matches := []match{}
	for registryURL, registry := range data.Registries {
		if registry == nil {
			continue
		}
		section := registry.Harnesses[harness]
		if section == nil {
			continue
		}
		entries := section.Standalone
		if componentType == "agent" {
			entries = section.Agents
		}
		for _, entry := range entries {
			if componentType != "agent" && entry.Type != componentType {
				continue
			}
			if scope == "project" && directory != "" && entry.Directory != directory {
				continue
			}
			matches = append(matches, match{registryURL, entry})
		}
	}
	collision := false
	for _, m := range matches {
		if m.entry.Slug == slug && ((m.entry.Namespace != "" && m.entry.Namespace != namespace) || m.registryURL != currentURL) {
			collision = true
			break
		}
	}
	if !collision {
		return slug, nil
	}
	// Local names become harness config keys and on-disk names, where a dot
	// reads as a file extension.
	candidate := strings.ReplaceAll(namespace, ".", "-") + "-" + slug
	taken := false
	for _, m := range matches {
		if m.entry.LocalName == candidate {
			taken = true
			break
		}
	}
	if !taken {
		return candidate, nil
	}
	host := "registry"
	if parsed, err := url.Parse(currentURL); err == nil && parsed.Hostname() != "" {
		host = parsed.Hostname()
	}
	return strings.ReplaceAll(host, ".", "-") + "-" + candidate, nil
}

// UpsertAgent adds or replaces an agent entry.
func UpsertAgent(harness string, entry Entry) error {
	data, registry, err := ReadRegistry(true)
	if err != nil {
		return err
	}
	section := ensureHarness(registry, harness)
	entry.PulledAt = isoNow()
	if entry.Namespace != "" && entry.Slug != "" {
		entry.QualifiedName = entry.Namespace + "/" + entry.Slug
	}
	if idx := findAgent(section.Agents, entry.ID, entry.Scope, entry.Directory); idx >= 0 {
		section.Agents[idx] = entry
	} else {
		section.Agents = append(section.Agents, entry)
	}
	return Write(data)
}

// RemoveAgent deletes an agent entry, reporting whether it existed.
func RemoveAgent(harness, agentID, directory string) (bool, error) {
	data, registry, err := ReadRegistry(true)
	if err != nil {
		return false, err
	}
	section := ensureHarness(registry, harness)
	for i, agent := range section.Agents {
		if agent.ID == agentID {
			if directory != "" && agent.Directory != directory {
				continue
			}
			section.Agents = append(section.Agents[:i], section.Agents[i+1:]...)
			return true, Write(data)
		}
	}
	return false, nil
}

func findAgent(agents []Entry, agentID, scope, directory string) int {
	for i, agent := range agents {
		if agent.ID == agentID {
			if scope == "project" && directory != "" {
				if agent.Directory == directory {
					return i
				}
			} else if agent.Scope != "project" {
				return i
			}
		}
	}
	return -1
}

// UpsertStandalone adds or replaces a standalone component entry.
func UpsertStandalone(harness string, entry Entry) error {
	data, registry, err := ReadRegistry(true)
	if err != nil {
		return err
	}
	section := ensureHarness(registry, harness)
	entry.InstalledAt = isoNow()
	if entry.Namespace != "" && entry.Slug != "" {
		entry.QualifiedName = entry.Namespace + "/" + entry.Slug
	}
	if idx := findStandalone(section.Standalone, entry.Type, entry.ID, entry.Scope, entry.Directory); idx >= 0 {
		section.Standalone[idx] = entry
	} else {
		section.Standalone = append(section.Standalone, entry)
	}
	return Write(data)
}

// RemoveStandalone deletes a component entry, reporting whether it existed.
func RemoveStandalone(harness, componentType, componentID, directory string) (bool, error) {
	data, registry, err := ReadRegistry(true)
	if err != nil {
		return false, err
	}
	section := ensureHarness(registry, harness)
	for i, item := range section.Standalone {
		if item.Type == componentType && item.ID == componentID {
			if directory != "" && item.Directory != directory {
				continue
			}
			section.Standalone = append(section.Standalone[:i], section.Standalone[i+1:]...)
			return true, Write(data)
		}
	}
	return false, nil
}

func findStandalone(items []Entry, componentType, componentID, scope, directory string) int {
	for i, item := range items {
		if item.Type == componentType && item.ID == componentID {
			if scope == "project" && directory != "" {
				if item.Directory == directory {
					return i
				}
			} else if item.Scope != "project" {
				return i
			}
		}
	}
	return -1
}

// AgentForDirectory attributes a project directory to its pulled agent.
func AgentForDirectory(harness, directory string) (*Entry, error) {
	_, registry, err := ReadRegistry(false)
	if err != nil {
		return nil, err
	}
	section := registry.Harnesses[harness]
	if section == nil {
		return nil, nil
	}
	for i := range section.Agents {
		if section.Agents[i].Directory == directory {
			return &section.Agents[i], nil
		}
	}
	return nil, nil
}

// AgentByID finds a lockfile agent by identity, optionally per harness.
func AgentByID(agentID, harness string) (*Entry, error) {
	_, registry, err := ReadRegistry(false)
	if err != nil {
		return nil, err
	}
	for harnessName, section := range registry.Harnesses {
		if harness != "" && harnessName != harness {
			continue
		}
		if section == nil {
			continue
		}
		for i := range section.Agents {
			if section.Agents[i].ID == agentID {
				return &section.Agents[i], nil
			}
		}
	}
	return nil, nil
}

// AgentByName finds one harness agent by local name, name, or identity;
// ambiguity fails closed.
func AgentByName(name, harness, directory string) (*Entry, error) {
	_, registry, err := ReadRegistry(false)
	if err != nil {
		return nil, err
	}
	section := registry.Harnesses[harness]
	if section == nil {
		return nil, nil
	}
	matches := []Entry{}
	for _, agent := range section.Agents {
		if name == agent.LocalName || name == agent.Name || name == agent.ID {
			matches = append(matches, agent)
		}
	}
	if directory != "" {
		directoryMatches := []Entry{}
		for _, agent := range matches {
			if agent.Directory == directory {
				directoryMatches = append(directoryMatches, agent)
			}
		}
		if len(directoryMatches) == 1 {
			return &directoryMatches[0], nil
		}
		if len(directoryMatches) > 1 {
			return nil, nil
		}
	}
	userMatches := []Entry{}
	for _, agent := range matches {
		if agent.Scope != "project" {
			userMatches = append(userMatches, agent)
		}
	}
	if len(userMatches) == 1 {
		return &userMatches[0], nil
	}
	if len(userMatches) > 1 {
		return nil, nil
	}
	if len(matches) == 1 {
		return &matches[0], nil
	}
	return nil, nil
}

// AgentForSession finds the installed agent a session belongs to, searching
// every harness. A directory+name match wins outright; a name-only match
// prefers user-scoped installs; with no name the first directory match wins.
func AgentForSession(directory, name string) (*Entry, error) {
	_, registry, err := ReadRegistry(false)
	if err != nil {
		return nil, err
	}
	harnessNames := make([]string, 0, len(registry.Harnesses))
	for harnessName := range registry.Harnesses {
		harnessNames = append(harnessNames, harnessName)
	}
	sort.Strings(harnessNames)
	nameMatches := []Entry{}
	for _, harnessName := range harnessNames {
		section := registry.Harnesses[harnessName]
		if section == nil {
			continue
		}
		for i := range section.Agents {
			agent := section.Agents[i]
			sameDir := directory != "" && agent.Directory == directory
			sameName := name != "" && (agent.Name == name || agent.ID == name)
			if name != "" {
				if sameName && sameDir {
					return &agent, nil
				}
				if sameName {
					nameMatches = append(nameMatches, agent)
				}
			} else if sameDir {
				return &agent, nil
			}
		}
	}
	for i := range nameMatches {
		if nameMatches[i].Scope != "project" {
			return &nameMatches[i], nil
		}
	}
	if len(nameMatches) > 0 {
		return &nameMatches[0], nil
	}
	return nil, nil
}

// FlatEntry is one lockfile row with its harness and kind attached.
type FlatEntry struct {
	Entry
	Harness   string `json:"harness"`
	EntryType string `json:"entry_type"`
}

// AllEntries flattens the current registry's rows for version reporting.
func AllEntries(harness string) ([]FlatEntry, error) {
	data, err := Read()
	if err != nil {
		return nil, err
	}
	if len(data.Registries) == 0 {
		return []FlatEntry{}, nil
	}
	_, registry, err := ReadRegistry(false)
	if err != nil {
		return nil, err
	}
	entries := []FlatEntry{}
	for harnessName, section := range registry.Harnesses {
		if harness != "" && harnessName != harness {
			continue
		}
		if section == nil {
			continue
		}
		for _, agent := range section.Agents {
			entries = append(entries, FlatEntry{Entry: agent, Harness: harnessName, EntryType: "agent"})
		}
		for _, item := range section.Standalone {
			entries = append(entries, FlatEntry{Entry: item, Harness: harnessName, EntryType: "standalone"})
		}
	}
	return entries, nil
}

// ComputeIntegrity fingerprints file content for install records.
func ComputeIntegrity(content string) string {
	sum := sha256.Sum256([]byte(content))
	return "sha256-" + hex.EncodeToString(sum[:])
}
