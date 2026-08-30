// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package agents

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
)

type downloadStats struct {
	Total          int64            `json:"total"`
	TotalDownloads int64            `json:"total_downloads"`
	UniqueUsers    int64            `json:"unique_users"`
	Recent7d       int64            `json:"recent_7d"`
	Sources        map[string]int64 `json:"sources"`
}

// DownloadStats aggregates install counts for one agent.
func (s *Store) DownloadStats(ctx context.Context, agentID string) (*downloadStats, error) {
	stats := &downloadStats{Sources: map[string]int64{}}
	err := s.DB.QueryRow(ctx, `SELECT
		count(*),
		count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL),
		count(*) FILTER (WHERE installed_at >= now() - interval '7 days')
		FROM agent_download_records WHERE agent_id = $1`, agentID).
		Scan(&stats.Total, &stats.UniqueUsers, &stats.Recent7d)
	if err != nil {
		return nil, err
	}
	stats.TotalDownloads = stats.Total
	rows, err := s.DB.Query(ctx, `SELECT source, count(*) FROM agent_download_records
		WHERE agent_id = $1 GROUP BY source`, agentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var source string
		var count int64
		if err := rows.Scan(&source, &count); err != nil {
			return nil, err
		}
		stats.Sources[source] = count
	}
	return stats, rows.Err()
}

var semverRE = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`)

func parseSemver(version string) (major, minor, patch int, ok bool) {
	m := semverRE.FindStringSubmatch(version)
	if m == nil {
		return 0, 0, 0, false
	}
	var err1, err2, err3 error
	major, err1 = strconv.Atoi(m[1])
	minor, err2 = strconv.Atoi(m[2])
	patch, err3 = strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil {
		// Digit runs beyond int range are not comparable versions.
		return 0, 0, 0, false
	}
	return major, minor, patch, true
}

func semverLess(a, b [3]int) bool {
	if a[0] != b[0] {
		return a[0] < b[0]
	}
	if a[1] != b[1] {
		return a[1] < b[1]
	}
	return a[2] < b[2]
}

func bumpVersion(current, bumpType string) string {
	major, minor, patch, ok := parseSemver(current)
	if !ok {
		return "1.0.0"
	}
	switch bumpType {
	case "major":
		return fmt.Sprintf("%d.0.0", major+1)
	case "minor":
		return fmt.Sprintf("%d.%d.0", major, minor+1)
	default:
		return fmt.Sprintf("%d.%d.%d", major, minor, patch+1)
	}
}

type versionSuggestions struct {
	Current     string `json:"current"`
	Suggestions struct {
		Patch string `json:"patch"`
		Minor string `json:"minor"`
		Major string `json:"major"`
	} `json:"suggestions"`
}

// SuggestVersions picks the highest semver across every version, including
// unapproved ones, so a suggestion never collides with a pending release.
func (s *Store) SuggestVersions(ctx context.Context, agentRow map[string]any) (*versionSuggestions, error) {
	rows, err := s.DB.Query(ctx, `SELECT version FROM agent_versions
		WHERE agent_id = $1 ORDER BY created_at DESC`, rowStr(agentRow, "id", ""))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	highest := rowStr(agentRow, "version", "")
	if highest == "" {
		highest = "0.0.0"
	}
	highestParsed := [3]int{}
	if ma, mi, pa, ok := parseSemver(highest); ok {
		highestParsed = [3]int{ma, mi, pa}
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		if ma, mi, pa, ok := parseSemver(v); ok && semverLess(highestParsed, [3]int{ma, mi, pa}) {
			highest = v
			highestParsed = [3]int{ma, mi, pa}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := &versionSuggestions{Current: highest}
	out.Suggestions.Patch = bumpVersion(highest, "patch")
	out.Suggestions.Minor = bumpVersion(highest, "minor")
	out.Suggestions.Major = bumpVersion(highest, "major")
	return out, nil
}
