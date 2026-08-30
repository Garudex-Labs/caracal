// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/garudex-labs/caracal/internal/clickhouse"
)

const (
	profileDays        = 60
	maxProfileSessions = 300
	maxIDArray         = 150
	profileMaxAge      = 24 * time.Hour
)

// topicKeywords buckets assorted terms into coarse topics.
var topicKeywords = []struct {
	topic    string
	keywords []string
}{
	{"databases", []string{"postgres", "mysql", "sqlite", "mongo", "redis", "sql", "prisma", "database", "db"}},
	{"frontend", []string{"react", "vue", "svelte", "css", "tailwind", "browser", "figma", "ui"}},
	{"infrastructure", []string{"docker", "kubernetes", "k8s", "terraform", "aws", "gcp", "azure", "helm", "deploy"}},
	{"version-control", []string{"git", "github", "gitlab", "pr", "commit", "branch"}},
	{"testing", []string{"pytest", "jest", "vitest", "playwright", "test", "coverage"}},
	{"observability", []string{"grafana", "prometheus", "sentry", "datadog", "log", "trace", "metric"}},
	{"security", []string{"auth", "oauth", "saml", "secret", "vault", "crypto", "vulnerab"}},
	{"data-analytics", []string{"pandas", "spark", "airflow", "dbt", "warehouse", "analytic"}},
	{"productivity", []string{"slack", "notion", "jira", "linear", "calendar", "email"}},
}

var extensionToLanguage = map[string]string{
	".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
	".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java",
	".md": "Markdown", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".sh": "Shell",
	".css": "CSS", ".html": "HTML", ".c": "C", ".cpp": "C++", ".cs": "C#",
	".kt": "Kotlin", ".swift": "Swift",
}

// WorkProfile is a user's derived interests, most-used first, built from
// session metadata only - never prompt or transcript text.
type WorkProfile struct {
	Languages       []string `json:"languages"`
	Tools           []string `json:"tools"`
	McpServers      []string `json:"mcp_servers"`
	Topics          []string `json:"topics"`
	Harnesses       []string `json:"harnesses"`
	ErrorCategories []string `json:"error_categories"`
	SessionCount    int      `json:"-"`
}

func (p WorkProfile) isEmpty() bool {
	return len(p.Languages) == 0 && len(p.Tools) == 0 && len(p.McpServers) == 0 && len(p.Topics) == 0
}

func (p WorkProfile) searchSignals() string {
	tools := p.Tools
	if len(tools) > 10 {
		tools = tools[:10]
	}
	return buildSignalQuery(p.Topics, p.McpServers, p.Languages, tools, p.ErrorCategories)
}

// buildSignalQuery flattens signal collections into one search string,
// preserving order and dropping duplicates case-insensitively.
func buildSignalQuery(parts ...[]string) string {
	seen := map[string]bool{}
	out := []string{}
	for _, part := range parts {
		for _, item := range part {
			text := strings.TrimSpace(item)
			if text == "" || seen[strings.ToLower(text)] {
				continue
			}
			seen[strings.ToLower(text)] = true
			out = append(out, text)
		}
	}
	return strings.Join(out, " ")
}

// counter preserves first-seen order for ties, like the profile's ranking.
type counter struct {
	counts map[string]int
	order  []string
}

func newCounter() *counter { return &counter{counts: map[string]int{}} }

func (c *counter) add(key string, n int) {
	if _, seen := c.counts[key]; !seen {
		c.order = append(c.order, key)
	}
	c.counts[key] += n
}

func (c *counter) mostCommon(limit int) []string {
	keys := append([]string{}, c.order...)
	sort.SliceStable(keys, func(i, j int) bool { return c.counts[keys[i]] > c.counts[keys[j]] })
	if len(keys) > limit {
		keys = keys[:limit]
	}
	return keys
}

func (c *counter) keys() []string { return c.order }

// CHQuerier is the analytics-store surface the profile builder needs.
type CHQuerier interface {
	QueryJSON(ctx context.Context, sql string, settings clickhouse.Settings) ([]map[string]any, error)
}

var safeSessionID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// idArray renders session ids as an array literal; ids are rejected, not
// escaped, since parameters travel as HTTP query values.
func idArray(sessionIDs []string) string {
	safe := []string{}
	for _, sid := range sessionIDs {
		if safeSessionID.MatchString(sid) && len(safe) < maxIDArray {
			safe = append(safe, "'"+sid+"'")
		}
	}
	return "[" + strings.Join(safe, ",") + "]"
}

func chString(row map[string]any, key string) string {
	s, _ := row[key].(string)
	return s
}

func chInt(row map[string]any, key string) int {
	switch v := row[key].(type) {
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(v)
		return n
	}
	return 0
}

// mcpServerName extracts the server from an mcp__<server>__<tool> name.
func mcpServerName(toolName string) string {
	if !strings.HasPrefix(toolName, "mcp__") {
		return ""
	}
	parts := strings.Split(toolName, "__")
	if len(parts) >= 2 {
		return parts[1]
	}
	return ""
}

// BuildProfile computes a fresh profile from the user's own sessions. The
// aggregate table carries the user-id bloom filter, so sessions resolve
// there first and events are fetched by session id.
func (s *Store) BuildProfile(ctx context.Context, userID uuid.UUID, projectID string) (*WorkProfile, error) {
	since := time.Now().UTC().Add(-profileDays * 24 * time.Hour).Format("2006-01-02 15:04:05")
	sessionRows, err := s.CH.QueryJSON(ctx, `
		SELECT session_id, anyLast(harness) AS harness
		FROM session_stats_agg FINAL
		WHERE user_id = {uid:String}
		  AND project_id = {pid:String}
		  AND last_event_time >= {since:String}
		GROUP BY session_id
		ORDER BY max(last_event_time) DESC
		LIMIT {limit:UInt32}
		FORMAT JSON`,
		clickhouse.Settings{
			"param_uid": userID.String(), "param_pid": projectID,
			"param_since": since, "param_limit": fmt.Sprint(maxProfileSessions),
		})
	if err != nil || len(sessionRows) == 0 {
		return &WorkProfile{}, err
	}
	sessionIDs := []string{}
	harnesses := newCounter()
	for _, row := range sessionRows {
		if sid := chString(row, "session_id"); sid != "" {
			sessionIDs = append(sessionIDs, sid)
		}
		if h := chString(row, "harness"); h != "" {
			harnesses.add(h, 1)
		}
	}
	if len(sessionIDs) == 0 {
		return &WorkProfile{}, nil
	}

	toolRows, _ := s.CH.QueryJSON(ctx, `
		SELECT tool_name, count() AS uses
		FROM session_events
		WHERE session_id IN (`+idArray(sessionIDs)+`)
		  AND tool_name IS NOT NULL
		  AND tool_name != ''
		GROUP BY tool_name
		ORDER BY uses DESC
		LIMIT 200
		FORMAT JSON`, nil)
	tools, mcpServers := newCounter(), newCounter()
	for _, row := range toolRows {
		name := chString(row, "tool_name")
		if name == "" {
			continue
		}
		uses := chInt(row, "uses")
		if server := mcpServerName(name); server != "" {
			mcpServers.add(server, uses)
		} else {
			tools.add(name, uses)
		}
	}

	previewRows, _ := s.CH.QueryJSON(ctx, `
		SELECT content_preview
		FROM session_events
		WHERE session_id IN (`+idArray(sessionIDs)+`)
		  AND event_type = 'tool_call'
		  AND content_preview != ''
		LIMIT 5000
		FORMAT JSON`, nil)
	languages := newCounter()
	for _, row := range previewRows {
		preview := chString(row, "content_preview")
		for extension, language := range extensionToLanguage {
			if strings.Contains(preview, extension) {
				languages.add(language, 1)
			}
		}
	}

	topics := newCounter()
	topicTerms := append(append(append([]string{}, mcpServers.keys()...), tools.keys()...), languages.keys()...)
	for _, term := range topicTerms {
		lowered := strings.ToLower(term)
		for _, bucket := range topicKeywords {
			for _, keyword := range bucket.keywords {
				if strings.Contains(lowered, keyword) {
					topics.add(bucket.topic, 1)
					break
				}
			}
		}
	}

	return &WorkProfile{
		Languages:       languages.mostCommon(8),
		Tools:           tools.mostCommon(15),
		McpServers:      mcpServers.mostCommon(10),
		Topics:          topics.mostCommon(6),
		Harnesses:       harnesses.mostCommon(5),
		ErrorCategories: []string{},
		SessionCount:    len(sessionIDs),
	}, nil
}

// GetOrBuildProfile returns the cached profile, recomputing when stale;
// caching keeps the recommendations endpoint cheap enough for page load.
func (s *Store) GetOrBuildProfile(ctx context.Context, userID uuid.UUID, projectID string, force bool) (*WorkProfile, error) {
	var blob []byte
	var sessionCount int
	var computedAt *time.Time
	err := s.DB.QueryRow(ctx,
		"SELECT profile, session_count, computed_at FROM user_work_profiles WHERE user_id = $1",
		userID).Scan(&blob, &sessionCount, &computedAt)
	exists := !errors.Is(err, pgx.ErrNoRows)
	if err != nil && exists {
		return nil, err
	}
	if exists && !force && computedAt != nil && time.Since(*computedAt) < profileMaxAge {
		profile := &WorkProfile{}
		if json.Unmarshal(blob, profile) == nil {
			profile.SessionCount = sessionCount
			return profile, nil
		}
	}
	profile, err := s.BuildProfile(ctx, userID, projectID)
	if err != nil {
		return &WorkProfile{}, nil
	}
	stored, err := json.Marshal(profile)
	if err != nil {
		return profile, nil
	}
	// Persistence failures degrade to an uncached profile, never an error.
	if exists {
		_, _ = s.DB.Exec(ctx,
			"UPDATE user_work_profiles SET profile = $1::json, session_count = $2, computed_at = now() WHERE user_id = $3",
			string(stored), profile.SessionCount, userID)
	} else {
		_, _ = s.DB.Exec(ctx,
			`INSERT INTO user_work_profiles (id, user_id, profile, session_count, computed_at)
			 VALUES (gen_random_uuid(), $1, $2::json, $3, now())
			 ON CONFLICT (user_id) DO UPDATE SET profile = EXCLUDED.profile,
			   session_count = EXCLUDED.session_count, computed_at = EXCLUDED.computed_at`,
			userID, string(stored), profile.SessionCount)
	}
	return profile, nil
}
