// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package sessions implements acknowledged session delivery: cursor state,
// source reading, the ingest push protocol, and outbox draining.
package sessions

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/garudex-labs/caracal/internal/cli/outbox"
)

// ---------------------------------------------------------------------------
// Offset / cursor state
// ---------------------------------------------------------------------------

func caracalDir(home string) string {
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".caracal")
}

// CursorStatus reports byte offset, line count, finality, and validity for
// one local source in sync_state.json.
func CursorStatus(sessionID, home string) (offset, lineCount int64, finalized, valid bool) {
	stateFile := filepath.Join(caracalDir(home), "sync_state.json")
	blob, err := os.ReadFile(stateFile)
	if err != nil {
		return 0, 0, false, false
	}
	var data map[string]json.RawMessage
	if json.Unmarshal(blob, &data) != nil {
		return 0, 0, false, false
	}
	raw, ok := data[sessionID]
	if !ok {
		return 0, 0, false, false
	}
	var entry struct {
		Offset    *int64 `json:"offset"`
		LineCount *int64 `json:"line_count"`
		Finalized bool   `json:"finalized"`
	}
	if json.Unmarshal(raw, &entry) != nil || entry.Offset == nil || entry.LineCount == nil ||
		*entry.Offset < 0 || *entry.LineCount < 0 {
		return 0, 0, false, false
	}
	return *entry.Offset, *entry.LineCount, entry.Finalized, true
}

// WriteCursor persists the byte offset and line count for a session.
// Finality is sticky unless preserveFinalized is disabled by a repair.
func WriteCursor(sessionID string, offset, lineCount int64, finalized bool, home string, preserveFinalized bool) error {
	dir := caracalDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	stateFile := filepath.Join(dir, "sync_state.json")
	data := map[string]map[string]any{}
	if blob, err := os.ReadFile(stateFile); err == nil {
		_ = json.Unmarshal(blob, &data)
	}
	entry := map[string]any{"offset": offset, "line_count": lineCount}
	previous := data[sessionID]
	wasFinalized := false
	if previous != nil {
		wasFinalized, _ = previous["finalized"].(bool)
	}
	if finalized || (preserveFinalized && wasFinalized) {
		entry["finalized"] = true
	}
	data[sessionID] = entry
	blob, err := json.Marshal(data)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "sync_state")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(blob); err != nil {
		_ = tmp.Close()
		return err
	}
	_ = tmp.Close()
	return os.Rename(tmp.Name(), stateFile)
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

// ReadNewRecords reads complete non-empty records and their absolute
// end-byte offsets from a JSONL source starting at offset.
func ReadNewRecords(path string, offset int64) (lines []string, endOffsets []int64, bytesRead int64, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, 0, err
	}
	defer func() { _ = file.Close() }()
	if _, err := file.Seek(offset, 0); err != nil {
		return nil, nil, 0, err
	}
	raw := &bytes.Buffer{}
	if _, err := raw.ReadFrom(file); err != nil {
		return nil, nil, 0, err
	}
	data := raw.Bytes()
	if len(data) == 0 {
		return nil, nil, 0, nil
	}
	completeBytes := len(data)
	if !bytes.HasSuffix(data, []byte("\n")) {
		completeBytes = bytes.LastIndexByte(data, '\n') + 1
	}
	if completeBytes <= 0 {
		return nil, nil, 0, nil
	}
	absolute := offset
	rest := data[:completeBytes]
	for len(rest) > 0 {
		idx := bytes.IndexByte(rest, '\n')
		var encoded []byte
		if idx >= 0 {
			encoded = rest[:idx+1]
			rest = rest[idx+1:]
		} else {
			encoded = rest
			rest = nil
		}
		absolute += int64(len(encoded))
		line := strings.TrimRight(string(encoded), "\r\n")
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
			endOffsets = append(endOffsets, absolute)
		}
	}
	return lines, endOffsets, int64(completeBytes), nil
}

// HashSessionSource fingerprints complete records for final delivery audits.
func HashSessionSource(path string) (string, int64, error) {
	lines, _, _, err := ReadNewRecords(path, 0)
	if err != nil {
		return "", 0, err
	}
	hasher := sha256.New()
	for _, line := range lines {
		lineSum := sha256.Sum256([]byte(line))
		hasher.Write([]byte(hex.EncodeToString(lineSum[:])))
		hasher.Write([]byte("\n"))
	}
	return hex.EncodeToString(hasher.Sum(nil)), int64(len(lines)), nil
}

// ---------------------------------------------------------------------------
// Delivery configuration
// ---------------------------------------------------------------------------

// Config carries the bearer token used for acknowledged session delivery.
type Config struct {
	ServerURL    string
	AccessToken  string
	SessionToken string
	UserID       string
	OrgSlug      string
	ProjectSlug  string
	ConfigPath   string
}

// LoadConfig reads the delivery credentials, returning nil when the
// configuration is missing required fields.
func LoadConfig(home string) *Config {
	cfgFile := filepath.Join(caracalDir(home), "config.json")
	blob, err := os.ReadFile(cfgFile)
	if err != nil {
		return nil
	}
	var data map[string]any
	if json.Unmarshal(blob, &data) != nil {
		return nil
	}
	str := func(key string) string {
		s, _ := data[key].(string)
		return strings.TrimSpace(s)
	}
	serverURL := str("server_url")
	accessToken := str("access_token")
	sessionToken := str("session_token")
	if serverURL == "" || (accessToken == "" && sessionToken == "") {
		return nil
	}
	userID := ""
	if v, ok := data["user_id"]; ok {
		userID = strings.TrimSpace(fmt.Sprint(v))
	}
	return &Config{
		ServerURL:    serverURL,
		AccessToken:  accessToken,
		SessionToken: sessionToken,
		UserID:       userID,
		OrgSlug:      str("default_org"),
		ProjectSlug:  str("default_project"),
		ConfigPath:   cfgFile,
	}
}

func scopedDestination(cfg *Config) string {
	server := strings.TrimRight(cfg.ServerURL, "/")
	if server == "" || cfg.OrgSlug == "" || cfg.ProjectSlug == "" {
		return ""
	}
	return server + "#scope=" + url.QueryEscape(cfg.OrgSlug) + "/" + url.QueryEscape(cfg.ProjectSlug)
}

func setProjectScopeHeaders(req *http.Request, cfg *Config) {
	req.Header.Set("X-Caracal-Org", cfg.OrgSlug)
	req.Header.Set("X-Caracal-Project", cfg.ProjectSlug)
}

// ---------------------------------------------------------------------------
// HTTP posting
// ---------------------------------------------------------------------------

// ErrPermanentRejection marks a payload rejection retrying cannot resolve.
var ErrPermanentRejection = errors.New("server permanently rejected the payload")

// Acknowledgement is the server's delivery checkpoint response.
type Acknowledgement struct {
	AcknowledgedLine   int64
	AcknowledgedOffset int64
	RepairFromLine     *int64
}

func refreshAccessToken(serverURL, sessionToken, configPath string) string {
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(serverURL, "/")+"/api/auth/tenant-token", nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return ""
	}
	var data struct {
		AccessToken string `json:"token"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.AccessToken == "" {
		return ""
	}
	if blob, err := os.ReadFile(configPath); err == nil {
		var cfg map[string]any
		if json.Unmarshal(blob, &cfg) == nil {
			cfg["access_token"] = data.AccessToken
			if out, err := json.MarshalIndent(cfg, "", "  "); err == nil {
				_ = os.WriteFile(configPath, out, 0o600)
			}
		}
	}
	return data.AccessToken
}

// PostToServerAck delivers one session batch and returns the server
// acknowledgement, nil for retryable failures, or a permanent rejection.
func PostToServerAck(cfg *Config, payload map[string]any) (*Acknowledgement, error) {
	if cfg == nil || cfg.OrgSlug == "" || cfg.ProjectSlug == "" {
		return nil, nil
	}
	target := strings.TrimRight(cfg.ServerURL, "/") + "/api/v1/ingest/session"
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, nil
	}
	client := &http.Client{Timeout: 10 * time.Second}
	if cfg.SessionToken != "" && cfg.ConfigPath != "" {
		cfg.AccessToken = refreshAccessToken(cfg.ServerURL, cfg.SessionToken, cfg.ConfigPath)
		if cfg.AccessToken == "" {
			return nil, nil
		}
	}
	send := func(token string) (*http.Response, error) {
		req, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		setProjectScopeHeaders(req, cfg)
		return client.Do(req)
	}
	resp, err := send(cfg.AccessToken)
	if err != nil {
		return nil, nil
	}
	if resp.StatusCode == http.StatusUnauthorized && cfg.SessionToken != "" && cfg.ConfigPath != "" {
		_ = resp.Body.Close()
		if newToken := refreshAccessToken(cfg.ServerURL, cfg.SessionToken, cfg.ConfigPath); newToken != "" {
			cfg.AccessToken = newToken
			resp, err = send(newToken)
			if err != nil {
				return nil, nil
			}
		} else {
			return nil, nil
		}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		switch resp.StatusCode {
		case 400, 409, 413, 415, 422:
			return nil, fmt.Errorf("%w with status %d", ErrPermanentRejection, resp.StatusCode)
		}
		return nil, nil
	}
	var data struct {
		AcknowledgedLine   *int64 `json:"acknowledged_line"`
		AcknowledgedOffset *int64 `json:"acknowledged_offset"`
		RepairFromLine     *int64 `json:"repair_from_line"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.AcknowledgedLine == nil {
		return nil, nil
	}
	ack := &Acknowledgement{AcknowledgedLine: *data.AcknowledgedLine, RepairFromLine: data.RepairFromLine}
	if data.AcknowledgedOffset != nil {
		ack.AcknowledgedOffset = *data.AcknowledgedOffset
	}
	return ack, nil
}

// ServerCheckpoint fetches the authenticated contiguous checkpoint for one
// session source; absence and failure both return nil.
func ServerCheckpoint(cfg *Config, harness, sessionID string) *Acknowledgement {
	if cfg == nil || cfg.OrgSlug == "" || cfg.ProjectSlug == "" {
		return nil
	}
	if cfg.SessionToken != "" && cfg.ConfigPath != "" {
		cfg.AccessToken = refreshAccessToken(cfg.ServerURL, cfg.SessionToken, cfg.ConfigPath)
		if cfg.AccessToken == "" {
			return nil
		}
	}
	target := strings.TrimRight(cfg.ServerURL, "/") + "/api/v1/ingest/session/checkpoint?" +
		url.Values{"session_id": {sessionID}, "harness": {harness}}.Encode()
	client := &http.Client{Timeout: 5 * time.Second}
	send := func(token string) (*http.Response, error) {
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		setProjectScopeHeaders(req, cfg)
		return client.Do(req)
	}
	resp, err := send(cfg.AccessToken)
	if err != nil {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized && cfg.SessionToken != "" && cfg.ConfigPath != "" {
		_ = resp.Body.Close()
		newToken := refreshAccessToken(cfg.ServerURL, cfg.SessionToken, cfg.ConfigPath)
		if newToken == "" {
			return nil
		}
		cfg.AccessToken = newToken
		if resp, err = send(newToken); err != nil {
			return nil
		}
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 300 {
		return nil
	}
	var data struct {
		AcknowledgedLine   *int64 `json:"acknowledged_line"`
		AcknowledgedOffset *int64 `json:"acknowledged_offset"`
	}
	if json.NewDecoder(resp.Body).Decode(&data) != nil || data.AcknowledgedLine == nil {
		return nil
	}
	ack := &Acknowledgement{AcknowledgedLine: *data.AcknowledgedLine}
	if data.AcknowledgedOffset != nil {
		ack.AcknowledgedOffset = *data.AcknowledgedOffset
	}
	return ack
}

// LogError appends a single-line entry to the delivery log, best effort.
func LogError(message, home string) {
	dir := caracalDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	file, err := os.OpenFile(filepath.Join(dir, "sync.log"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = file.Close() }()
	ts := time.Now().Format("2006-01-02T15:04:05")
	_, _ = fmt.Fprintf(file, "%s %s\n", ts, message) // best-effort local log
}

// Rejection identifies one permanently rejected batch.
type Rejection struct {
	Harness    string
	SessionID  string
	StatusCode int
}

// Repair identifies one server-directed cursor rewind.
type Repair struct {
	Harness   string
	SessionID string
}

// DrainOptions inject seams for testing and shared-state overrides.
type DrainOptions struct {
	Home   string
	DBPath string
	Post   func(cfg *Config, payload map[string]any) (*Acknowledgement, error)
}

// DrainOutbox delivers durable batches for the configured server and user
// until the queue empties or delivery blocks. It reports whether the
// outbox fully drained.
func DrainOutbox(cfg *Config, opts DrainOptions, rejections *[]Rejection, repairs *[]Repair) (bool, error) {
	destination := scopedDestination(cfg)
	if destination == "" || cfg.UserID == "" {
		return false, nil
	}
	post := opts.Post
	if post == nil {
		post = PostToServerAck
	}
	store, err := outbox.Open(opts.DBPath)
	if err != nil {
		return false, err
	}
	defer func() { _ = store.Close() }()

	for {
		items, err := store.Pending(destination, cfg.UserID, 1)
		if err != nil {
			return false, err
		}
		if len(items) == 0 {
			return true, nil
		}
		item := items[0]
		ack, err := post(cfg, item.Payload)
		if err != nil && errors.Is(err, ErrPermanentRejection) {
			quarantinePath, qerr := store.Quarantine(item, err.Error())
			if qerr != nil {
				return false, qerr
			}
			if rejections != nil {
				status := 0
				// Unmatched text just leaves status 0 (unknown).
				_, _ = fmt.Sscanf(err.Error(), "server permanently rejected the payload with status %d", &status)
				if status == 0 {
					_, _ = fmt.Sscanf(err.Error(), "%*s with status %d", &status)
				}
				*rejections = append(*rejections, Rejection{Harness: item.Harness, SessionID: item.SessionID, StatusCode: status})
			}
			LogError(fmt.Sprintf("quarantined rejected %s session %s batch at %s",
				item.Harness, item.SessionID, quarantinePath), opts.Home)
			continue
		}
		if ack == nil {
			if err := store.RecordAttempt(item.ID); err != nil {
				return false, err
			}
			return false, nil
		}
		if ack.RepairFromLine != nil {
			// The server rewound the checkpoint; realign and re-read locally.
			if err := WriteCursor(item.CheckpointKey, ack.AcknowledgedOffset, *ack.RepairFromLine,
				false, opts.Home, false); err != nil {
				return false, err
			}
			if err := store.AcceptItem(item.ID); err != nil {
				return false, err
			}
			if repairs != nil {
				*repairs = append(*repairs, Repair{Harness: item.Harness, SessionID: item.SessionID})
			}
			return false, nil
		}
		if ack.AcknowledgedLine < item.EndLine {
			return false, nil
		}
		offset := ack.AcknowledgedOffset
		if offset <= 0 {
			offset = item.EndOffset
		}
		if err := WriteCursor(item.CheckpointKey, offset, ack.AcknowledgedLine+1,
			item.Final, opts.Home, true); err != nil {
			return false, err
		}
		if _, err := store.Acknowledge(destination, cfg.UserID, item.Harness, item.SessionID,
			ack.AcknowledgedLine, item.EndLine < item.StartLine); err != nil {
			return false, err
		}
	}
}
