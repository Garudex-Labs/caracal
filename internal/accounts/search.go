// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package accounts

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/garudex-labs/caracal/internal/httpapi"
)

// searchResult is one directory match.
type searchResult struct {
	ID        string  `json:"id"`
	Email     string  `json:"email"`
	Username  *string `json:"username"`
	Name      string  `json:"name"`
	AvatarURL *string `json:"avatar_url"`
	Role      string  `json:"role"`
	IsActive  bool    `json:"is_active"`
}

var spaceRun = regexp.MustCompile(`\s+`)

func normQuery(v string) string {
	return spaceRun.ReplaceAllString(strings.ToLower(strings.TrimSpace(v)), " ")
}

func escapeLike(v string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(v)
}

// scoreExpr ranks exact identity hits first, then prefixes, then trigram
// similarity; $1 = normalized query, $2 = prefix pattern, $3 = contains.
const scoreExpr = `(
	  CASE WHEN lower(COALESCE(u.username, '')) = $1 THEN 100 ELSE 0 END
	+ CASE WHEN lower(u.email) = $1 THEN 98 ELSE 0 END
	+ CASE WHEN lower(u.name) = $1 THEN 96 ELSE 0 END
	+ CASE WHEN u.username ILIKE $2 ESCAPE '\' THEN 30 ELSE 0 END
	+ CASE WHEN u.email ILIKE $2 ESCAPE '\' THEN 28 ELSE 0 END
	+ CASE WHEN u.name ILIKE $2 ESCAPE '\' THEN 26 ELSE 0 END
	+ CASE WHEN u.name ILIKE $3 ESCAPE '\' THEN 10 ELSE 0 END
	+ GREATEST(similarity(lower(u.name), $1), similarity(lower(u.email), $1),
	           similarity(lower(COALESCE(u.username, '')), $1)) * 74
)`

// SearchUsers answers the shared directory search used by member pickers.
func (s *Store) SearchUsers(ctx context.Context, query string, limit int) ([]searchResult, error) {
	q := strings.TrimPrefix(normQuery(query), "@")
	if len(q) < 2 {
		return []searchResult{}, nil
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 50 {
		limit = 50
	}
	escaped := escapeLike(q)
	rows, err := s.DB.Query(ctx,
		`SELECT u.id::text, u.email, u.username, u.name, u.avatar_url, u.role, u.auth_provider
		 FROM users u
		 WHERE u.username ILIKE $2 ESCAPE '\' OR u.email ILIKE $2 ESCAPE '\'
		    OR u.name ILIKE $3 ESCAPE '\'
		    OR u.username % $1 OR u.email % $1 OR u.name % $1
		    OR GREATEST(similarity(lower(u.name), $1), similarity(lower(u.email), $1),
		                similarity(lower(COALESCE(u.username, '')), $1)) >= 0.18
		 ORDER BY `+scoreExpr+` DESC, u.name, u.email LIMIT $4`,
		q, escaped+"%", "%"+escaped+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []searchResult{}
	for rows.Next() {
		var r searchResult
		var authProvider *string
		if err := rows.Scan(&r.ID, &r.Email, &r.Username, &r.Name, &r.AvatarURL, &r.Role, &authProvider); err != nil {
			return nil, err
		}
		r.IsActive = authProvider == nil || *authProvider != "deactivated"
		out = append(out, r)
	}
	return out, rows.Err()
}

func (h *Handler) searchUsers(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	errs := []fieldError{}
	raw := q.Get("q")
	switch {
	case !q.Has("q"):
		errs = append(errs, fieldError{Type: "missing", Loc: []string{"query", "q"},
			Msg: "Field required", Input: nil})
	case len(raw) < 2:
		errs = append(errs, fieldError{Type: "string_too_short", Loc: []string{"query", "q"},
			Msg: "String should have at least 2 characters", Input: raw, Ctx: map[string]any{"min_length": 2}})
	case len(raw) > 255:
		errs = append(errs, fieldError{Type: "string_too_long", Loc: []string{"query", "q"},
			Msg: "String should have at most 255 characters", Input: raw, Ctx: map[string]any{"max_length": 255}})
	}
	limit := intQuery(q.Get("limit"), 10, &errs)
	if len(errs) > 0 {
		httpapi.WriteJSON(w, http.StatusUnprocessableEntity, map[string]any{"detail": errs})
		return
	}
	out, err := h.Store.SearchUsers(r.Context(), raw, limit)
	if err != nil {
		httpapi.WriteInternalError(w, r, err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func intQuery(raw string, def int, errs *[]fieldError) int {
	if raw == "" {
		return def
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			*errs = append(*errs, fieldError{Type: "int_parsing", Loc: []string{"query", "limit"},
				Msg: "Input should be a valid integer, unable to parse string as an integer", Input: raw})
			return def
		}
		n = n*10 + int(c-'0')
	}
	if n < 1 {
		*errs = append(*errs, fieldError{Type: "greater_than_equal", Loc: []string{"query", "limit"},
			Msg: "Input should be greater than or equal to 1", Input: raw, Ctx: map[string]any{"ge": 1}})
		return def
	}
	if n > 50 {
		*errs = append(*errs, fieldError{Type: "less_than_equal", Loc: []string{"query", "limit"},
			Msg: "Input should be less than or equal to 50", Input: raw, Ctx: map[string]any{"le": 50}})
		return def
	}
	return n
}
