// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
	"github.com/garudex-labs/caracal/internal/httpapi"
)

func TestWireFloatMarshal(t *testing.T) {
	cases := []struct {
		in   wireFloat
		want string
	}{
		{1, "1.0"},
		{0, "0.0"},
		{1.024, "1.024"},
	}
	for _, c := range cases {
		blob, err := json.Marshal(c.in)
		if err != nil || string(blob) != c.want {
			t.Errorf("Marshal(%v) = %s, %v; want %s", c.in, blob, err, c.want)
		}
	}
}

func TestRecommendSearchFieldsPerFamily(t *testing.T) {
	cases := map[string]string{
		"mcps": "l.category", "skills": "v.task_type",
		"hooks": "v.event", "prompts": "v.category",
	}
	for prefix, extra := range cases {
		fields := recommendSearchFields(Families[prefix])
		if fields[0] != "l.name" || fields[len(fields)-1] != extra {
			t.Errorf("%s fields = %v", prefix, fields)
		}
	}
}

func TestCandidateCategorySourceColumn(t *testing.T) {
	row := map[string]any{"category": "general", "task_type": "review", "event": "PreToolUse"}
	if got := candidateCategory(Families["mcps"], row); got == nil || *got != "general" {
		t.Errorf("mcp category = %v", got)
	}
	if got := candidateCategory(Families["skills"], row); got == nil || *got != "review" {
		t.Errorf("skill category = %v", got)
	}
	if got := candidateCategory(Families["hooks"], row); got == nil || *got != "PreToolUse" {
		t.Errorf("hook category = %v", got)
	}
}

func TestRecommendTokensAndDisplay(t *testing.T) {
	// Single-word signals keep their lone stemmed token.
	if got := recommendTokens("postgres"); len(got) != 1 || got[0] != "postgre" {
		t.Errorf("single token = %v", got)
	}
	// Multi-word signals drop the phrase entry.
	got := recommendTokens("postgres redis")
	if len(got) != 2 || got[0] != "postgre" || got[1] != "redi" {
		t.Errorf("tokens = %v", got)
	}
	display := tokenDisplayMap("postgres redis")
	if display["postgre"] != "postgres" || display["redi"] != "redis" {
		t.Errorf("display = %v", display)
	}
	matched := matchedTerms([]string{"postgre", "redi"}, "A Postgres helper", display)
	if len(matched) != 1 || matched[0] != "postgres" {
		t.Errorf("matched = %v", matched)
	}
}

func TestExplainReasons(t *testing.T) {
	c := candidate{MatchedOn: []string{"a", "b", "c", "d"}}
	if got := explain(c, &WorkProfile{}); got != "Matches your work on a, b, c" {
		t.Errorf("matched reason = %q", got)
	}
	if got := explain(candidate{}, &WorkProfile{}); got != "Popular in your registry" {
		t.Errorf("cold reason = %q", got)
	}
	warm := &WorkProfile{Topics: []string{"testing"}}
	if got := explain(candidate{}, warm); got != "Popular among components like the ones you use" {
		t.Errorf("warm reason = %q", got)
	}
}

func TestRecommenderVisibilitySQLBindsViewerOnce(t *testing.T) {
	args := []any{}
	sql := recommenderVisibilitySQL(testViewer("user"), &args)
	if len(args) != 1 {
		t.Fatalf("args = %v", args)
	}
	if !strings.Contains(sql, "l.is_private = FALSE") || !strings.Contains(sql, "project_memberships") {
		t.Errorf("sql = %s", sql)
	}
}

func TestShortlistScoresSignalMatches(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(map[string]any{
		"name": "Postgres Helper", "description": "manage postgres safely",
	})}}
	s := &Store{DB: db}
	got, err := s.Shortlist(context.Background(), "postgres",
		[]Family{Families["mcps"]}, testViewer("user"), nil, 4, 8)
	if err != nil {
		t.Fatalf("shortlist: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("candidates = %v", got)
	}
	c := got[0]
	if c.Type != "mcp" || c.QualifiedName != "acme/weather" || c.LatestVersion != "1.2.0" || c.DownloadCount != 3 {
		t.Errorf("candidate = %+v", c)
	}
	if len(c.MatchedOn) != 1 || c.MatchedOn[0] != "postgres" {
		t.Errorf("matched = %v", c.MatchedOn)
	}
	// One token match plus 3/50 popularity at weight 0.4.
	if float64(c.Score) != 1.024 {
		t.Errorf("score = %v", c.Score)
	}
	if !strings.Contains(db.log[0], "v.status = 'approved'") {
		t.Errorf("approved gate missing: %s", db.log[0])
	}
}

func TestShortlistExcludesIDsAndSurvivesQueryFailure(t *testing.T) {
	db := &fakeDB{stubs: []stub{{match: "FROM mcp_listings", err: errBoom}}}
	s := &Store{DB: db}
	got, err := s.Shortlist(context.Background(), "",
		[]Family{Families["mcps"]}, testViewer("user"),
		map[string]bool{listingUUID: true}, 4, 8)
	if err != nil || len(got) != 0 {
		t.Errorf("failed family must be skipped: %v, %v", got, err)
	}
	if !strings.Contains(db.log[0], "l.id != ALL") {
		t.Errorf("exclusion missing: %s", db.log[0])
	}
}

// serveRecommend mounts the handler over explicit stores for the
// telemetry-backed recommendation routes.
func serveRecommend(t *testing.T, db PGQuerier, ch CHQuerier, method, target string, body *strings.Reader) *httptest.ResponseRecorder {
	t.Helper()
	h := &Handler{Store: &Store{DB: db, CH: ch}}
	mux := http.NewServeMux()
	withClaims := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := httpapi.ContextWithClaims(r.Context(), auth.Claims{
				UserID: uuid.MustParse(testViewerID), Role: "user",
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	h.Register(mux, withClaims)
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, body)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestMyRecommendationsColdStart(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	rec := serveRecommend(t, db, &fakeCH{}, http.MethodGet, "/api/v1/recommendations/me?limit=1&type=mcp", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var doc struct {
		Items           []map[string]any `json:"items"`
		Personalized    bool             `json:"personalized"`
		ProfileSessions int              `json:"profile_sessions"`
		Topics          []string         `json:"topics"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body: %v", err)
	}
	if len(doc.Items) != 1 || doc.Personalized || doc.ProfileSessions != 0 || doc.Topics == nil {
		t.Errorf("envelope: %+v", doc)
	}
	if doc.Items[0]["reason"] != "Popular in your registry" {
		t.Errorf("reason = %v", doc.Items[0]["reason"])
	}
}

func TestMyRecommendationsValidation(t *testing.T) {
	rec := serveRecommend(t, &fakeDB{}, &fakeCH{}, http.MethodGet, "/api/v1/recommendations/me?limit=99", nil)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("limit over 24: status = %d", rec.Code)
	}
	rec = serveRecommend(t, &fakeDB{}, &fakeCH{}, http.MethodGet, "/api/v1/recommendations/me?type=widget", nil)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "Unknown component type 'widget'") {
		t.Errorf("bad type: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRecommendationFeedbackContract(t *testing.T) {
	valid := `{"component_type":"mcps","component_id":"` + listingUUID + `","action":"dismissed"}`
	db := &fakeDB{}
	rec := serveRecommend(t, db, &fakeCH{}, http.MethodPost, "/api/v1/recommendations/feedback", strings.NewReader(valid))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("valid feedback: status = %d: %s", rec.Code, rec.Body.String())
	}
	found := false
	for _, sql := range db.log {
		if strings.Contains(sql, "INSERT INTO recommendation_feedback") {
			found = true
		}
	}
	if !found {
		t.Errorf("no insert issued:\n%v", db.log)
	}

	cases := []struct {
		name string
		body string
		code int
	}{
		{"missing fields", `{}`, http.StatusUnprocessableEntity},
		{"bad uuid", `{"component_type":"mcp","component_id":"nope","action":"dismissed"}`, http.StatusUnprocessableEntity},
		{"unknown type", `{"component_type":"widget","component_id":"` + listingUUID + `","action":"dismissed"}`, http.StatusBadRequest},
		{"unknown action", `{"component_type":"mcp","component_id":"` + listingUUID + `","action":"snoozed"}`, http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := serveRecommend(t, &fakeDB{}, &fakeCH{}, http.MethodPost, "/api/v1/recommendations/feedback", strings.NewReader(c.body))
		if rec.Code != c.code {
			t.Errorf("%s: status = %d, want %d: %s", c.name, rec.Code, c.code, rec.Body.String())
		}
	}
}

func TestRecordFeedbackSwallowsUniqueViolation(t *testing.T) {
	dup := &execCapableDB{fakeDB: &fakeDB{}, exec: func(string) (pgconn.CommandTag, error) {
		return pgconn.CommandTag{}, &pgconn.PgError{Code: "23505"}
	}}
	s := &Store{DB: dup}
	err := s.RecordFeedback(context.Background(), uuid.MustParse(testViewerID), "mcp",
		uuid.MustParse(listingUUID), "dismissed")
	if err != nil {
		t.Errorf("unique violation must be silent: %v", err)
	}

	broken := &execCapableDB{fakeDB: &fakeDB{}, exec: func(string) (pgconn.CommandTag, error) {
		return pgconn.CommandTag{}, errors.New("boom")
	}}
	s = &Store{DB: broken}
	if err := s.RecordFeedback(context.Background(), uuid.MustParse(testViewerID), "mcp",
		uuid.MustParse(listingUUID), "dismissed"); err == nil {
		t.Errorf("other failures must surface")
	}
}

func TestRecommendForUserTopsUpWithPopularity(t *testing.T) {
	db := &fakeDB{stubs: []stub{mcpShowStub(nil)}}
	s := &Store{DB: db}
	out := s.RecommendForUser(context.Background(), testViewer("user"), &WorkProfile{},
		[]Family{Families["mcps"]}, 1)
	if len(out) != 1 || out[0].Reason != "Popular in your registry" {
		t.Errorf("recommendations = %+v", out)
	}
}
