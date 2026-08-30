// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// -- package-local pgx.Tx fake -----------------------------------------------

// txExec routes one Exec by SQL substring to a fixed tag or error.
type txExec struct {
	match string
	tag   pgconn.CommandTag
	err   error
}

// fakeTx implements pgx.Tx over the same stub routing as fakeDB. Begin
// returns the receiver, standing in for a savepoint.
type fakeTx struct {
	stubs     []stub
	execs     []txExec
	log       []string
	args      [][]any
	commits   int
	rollbacks int
	beginErr  error
}

func (tx *fakeTx) route(sql string, args []any) *fakeRows {
	tx.log = append(tx.log, sql)
	tx.args = append(tx.args, args)
	for _, s := range tx.stubs {
		if strings.Contains(sql, s.match) {
			copyRows := *s.rows
			copyRows.idx = 0
			return &copyRows
		}
	}
	return &fakeRows{}
}

func (tx *fakeTx) Begin(context.Context) (pgx.Tx, error) {
	if tx.beginErr != nil {
		return nil, tx.beginErr
	}
	return tx, nil
}

func (tx *fakeTx) Commit(context.Context) error   { tx.commits++; return nil }
func (tx *fakeTx) Rollback(context.Context) error { tx.rollbacks++; return nil }

func (tx *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.log = append(tx.log, sql)
	tx.args = append(tx.args, args)
	for _, e := range tx.execs {
		if strings.Contains(sql, e.match) {
			return e.tag, e.err
		}
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (tx *fakeTx) Query(_ context.Context, sql string, args ...any) (pgx.Rows, error) {
	return tx.route(sql, args), nil
}

func (tx *fakeTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return fakeRow{tx.route(sql, args)}
}

func (tx *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("fakeTx: CopyFrom not supported")
}
func (tx *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (tx *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (tx *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("fakeTx: Prepare not supported")
}
func (tx *fakeTx) Conn() *pgx.Conn { return nil }

// countLog returns how many logged statements contain the fragment.
func (tx *fakeTx) countLog(fragment string) int {
	n := 0
	for _, sql := range tx.log {
		if strings.Contains(sql, fragment) {
			n++
		}
	}
	return n
}

// txDB is a fakeDB whose Begin hands out a shared fakeTx.
type txDB struct {
	fakeDB
	tx       *fakeTx
	beginErr error
}

func (db *txDB) Begin(context.Context) (pgx.Tx, error) {
	if db.beginErr != nil {
		return nil, db.beginErr
	}
	return db.tx, nil
}

// itemRow builds one itemColumns row with the given id, state, and read_at.
func itemRow(id, state string, readAt *time.Time) []any {
	var read any
	if readAt != nil {
		read = *readAt
	}
	return []any{
		id, "system_notice", state, read, false, "Notice", nil,
		"agent", nil, nil, nil,
		nil, nil, nil, nil,
		map[string]any{}, inboxTime, nil,
	}
}

// -- History -----------------------------------------------------------------

func TestHistoryScansEvents(t *testing.T) {
	actor := "22222222-2222-2222-2222-222222222222"
	db := &fakeDB{stubs: []stub{
		{match: "inbox_item_events", rows: &fakeRows{rows: [][]any{
			{"e1", "created", nil, nil, inboxTime},
			{"e2", "read", actor, "detail text", inboxTime},
		}}},
	}}
	events, err := (&Store{DB: db}).History(context.Background(), "i1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Event != "created" || events[1].Event != "read" {
		t.Fatalf("events = %+v", events)
	}
	if events[0].ActorID != nil || events[1].ActorID == nil || *events[1].ActorID != actor {
		t.Errorf("actor projection: %+v", events)
	}
	if events[1].Detail == nil || *events[1].Detail != "detail text" {
		t.Errorf("detail projection: %+v", events[1])
	}
	if !strings.Contains(db.log[0], "ORDER BY created_at ASC") {
		t.Errorf("history is not oldest-first:\n%s", db.log[0])
	}
}

// -- SetRead / Resolve / reload ----------------------------------------------

func TestSetReadMarksAndRecords(t *testing.T) {
	readTime := inboxTime.Add(time.Minute)
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "WHERE i.id = $1", rows: &fakeRows{rows: [][]any{itemRow("i1", "open", &readTime)}}},
	}
	item := &Item{ID: "i1", State: "open"}
	fresh, err := (&Store{DB: db}).SetRead(context.Background(), item, inboxUser, true)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ReadAt == nil {
		t.Fatalf("reload lost read_at: %+v", fresh)
	}
	if tx.countLog("read_at = now()") != 1 || tx.countLog("INSERT INTO inbox_item_events") != 1 {
		t.Errorf("tx statements: %v", tx.log)
	}
	if tx.commits != 1 {
		t.Errorf("commits = %d", tx.commits)
	}
	// The recorded event names the action.
	for i, sql := range tx.log {
		if strings.Contains(sql, "inbox_item_events") && tx.args[i][2] != "read" {
			t.Errorf("event = %v, want read", tx.args[i][2])
		}
	}
}

func TestSetReadUnreadClearsMarker(t *testing.T) {
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "WHERE i.id = $1", rows: &fakeRows{rows: [][]any{itemRow("i1", "open", nil)}}},
	}
	readTime := inboxTime
	item := &Item{ID: "i1", State: "open", ReadAt: &readTime}
	fresh, err := (&Store{DB: db}).SetRead(context.Background(), item, inboxUser, false)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ReadAt != nil {
		t.Fatalf("read_at kept: %+v", fresh)
	}
	if tx.countLog("read_at = NULL") != 1 {
		t.Errorf("tx statements: %v", tx.log)
	}
}

func TestSetReadNoOpSkipsTransaction(t *testing.T) {
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	item := &Item{ID: "i1", State: "open"}
	fresh, err := (&Store{DB: db}).SetRead(context.Background(), item, inboxUser, false)
	if err != nil || fresh != item {
		t.Fatalf("no-op must return the same item: %v, %v", fresh, err)
	}
	if len(tx.log) != 0 {
		t.Errorf("no-op touched the database: %v", tx.log)
	}
}

func TestSetReadBeginError(t *testing.T) {
	db := &txDB{beginErr: errors.New("pool down")}
	if _, err := (&Store{DB: db}).SetRead(context.Background(), &Item{ID: "i1"}, inboxUser, true); err == nil {
		t.Fatal("begin failure must propagate")
	}
}

func TestResolveMovesStateAndReopens(t *testing.T) {
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "WHERE i.id = $1", rows: &fakeRows{rows: [][]any{itemRow("i1", "done", nil)}}},
	}
	store := &Store{DB: db}
	fresh, err := store.Resolve(context.Background(), &Item{ID: "i1", State: "open"}, inboxUser, "done")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.State != "done" {
		t.Fatalf("state = %s", fresh.State)
	}
	if tx.countLog("resolved_at = now()") != 1 {
		t.Errorf("resolve statements: %v", tx.log)
	}

	// Reopening clears resolved_at and records "reopened".
	tx2 := &fakeTx{}
	db2 := &txDB{tx: tx2}
	db2.stubs = []stub{
		{match: "WHERE i.id = $1", rows: &fakeRows{rows: [][]any{itemRow("i1", "open", nil)}}},
	}
	if _, err := (&Store{DB: db2}).Resolve(context.Background(), &Item{ID: "i1", State: "done"}, inboxUser, "open"); err != nil {
		t.Fatal(err)
	}
	if tx2.countLog("resolved_at = NULL") != 1 {
		t.Errorf("reopen statements: %v", tx2.log)
	}
	for i, sql := range tx2.log {
		if strings.Contains(sql, "inbox_item_events") && tx2.args[i][2] != "reopened" {
			t.Errorf("event = %v, want reopened", tx2.args[i][2])
		}
	}
}

func TestResolveNoOpAndBeginError(t *testing.T) {
	item := &Item{ID: "i1", State: "done"}
	fresh, err := (&Store{DB: &txDB{}}).Resolve(context.Background(), item, inboxUser, "done")
	if err != nil || fresh != item {
		t.Fatalf("same-state resolve must be a no-op: %v, %v", fresh, err)
	}
	db := &txDB{beginErr: errors.New("pool down")}
	if _, err := (&Store{DB: db}).Resolve(context.Background(), item, inboxUser, "open"); err == nil {
		t.Fatal("begin failure must propagate")
	}
}

// -- ReadAll -----------------------------------------------------------------

func TestReadAllMarksMatchingRows(t *testing.T) {
	tx := &fakeTx{}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "SELECT i.id::text", rows: &fakeRows{rows: [][]any{{"a"}, {"b"}}}},
	}
	updated, err := (&Store{DB: db}).ReadAll(context.Background(), inboxUser, "user", Filters{})
	if err != nil {
		t.Fatal(err)
	}
	if updated != 2 {
		t.Fatalf("updated = %d", updated)
	}
	if tx.countLog("INSERT INTO inbox_item_events") != 2 || tx.commits != 1 {
		t.Errorf("tx statements: %v (commits %d)", tx.log, tx.commits)
	}
	// The candidate query itself re-applies the visibility recheck.
	if !strings.Contains(db.log[0], "project_memberships") {
		t.Errorf("read-all skips the visibility recheck:\n%s", db.log[0])
	}
}

func TestReadAllSkipsRowsFlippedConcurrently(t *testing.T) {
	tx := &fakeTx{execs: []txExec{
		{match: "SET read_at = now()", tag: pgconn.NewCommandTag("UPDATE 0")},
	}}
	db := &txDB{tx: tx}
	db.stubs = []stub{
		{match: "SELECT i.id::text", rows: &fakeRows{rows: [][]any{{"a"}}}},
	}
	updated, err := (&Store{DB: db}).ReadAll(context.Background(), inboxUser, "user", Filters{})
	if err != nil {
		t.Fatal(err)
	}
	if updated != 0 {
		t.Fatalf("updated = %d, want 0 when the row was already read", updated)
	}
	if tx.countLog("INSERT INTO inbox_item_events") != 0 {
		t.Errorf("event written for a skipped row: %v", tx.log)
	}
}

func TestReadAllBeginError(t *testing.T) {
	db := &txDB{beginErr: errors.New("pool down")}
	db.stubs = []stub{
		{match: "SELECT i.id::text", rows: &fakeRows{rows: [][]any{{"a"}}}},
	}
	if _, err := (&Store{DB: db}).ReadAll(context.Background(), inboxUser, "user", Filters{}); err == nil {
		t.Fatal("begin failure must propagate")
	}
}

// -- ReportOutdated ----------------------------------------------------------

func outdatedEntry() OutdatedEntry {
	ns := "acme"
	slug := "tool"
	harness := "kiro"
	return OutdatedEntry{
		Type:        "mcp",
		ComponentID: uuid.MustParse("33333333-3333-3333-3333-333333333333"),
		Name:        "server", Namespace: &ns, Slug: &slug,
		CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Harness: &harness,
	}
}

func TestReportOutdatedCreatesAndSupersedes(t *testing.T) {
	tx := &fakeTx{stubs: []stub{
		{match: "ON CONFLICT", rows: &fakeRows{rows: [][]any{{"new-id"}}}},
		{match: "AND id != $3", rows: &fakeRows{rows: [][]any{{"stale-1"}}}},
	}}
	db := &txDB{tx: tx}
	// The duplicate component id is skipped before any database work.
	created, superseded, err := (&Store{DB: db}).ReportOutdated(context.Background(), inboxUser,
		[]OutdatedEntry{outdatedEntry(), outdatedEntry()})
	if err != nil {
		t.Fatal(err)
	}
	if created != 1 || superseded != 1 {
		t.Fatalf("created=%d superseded=%d", created, superseded)
	}
	if tx.countLog("SET state = 'done'") != 1 {
		t.Errorf("stale notice not closed: %v", tx.log)
	}
	if tx.countLog("INSERT INTO inbox_item_events") != 2 {
		t.Errorf("expected created + superseded events: %v", tx.log)
	}
	if tx.commits != 1 {
		t.Errorf("commits = %d", tx.commits)
	}
}

func TestReportOutdatedRedeliveryRefreshesOpenItem(t *testing.T) {
	tx := &fakeTx{stubs: []stub{
		// No ON CONFLICT stub: the insert scan reports no row, entering the
		// redelivery path.
		{match: "AND dedupe_key = $2", rows: &fakeRows{rows: [][]any{
			{"ex-1", "open", nil, "stale title", nil, nil, "{}"},
		}}},
	}}
	db := &txDB{tx: tx}
	created, superseded, err := (&Store{DB: db}).ReportOutdated(context.Background(), inboxUser,
		[]OutdatedEntry{outdatedEntry()})
	if err != nil {
		t.Fatal(err)
	}
	if created != 0 || superseded != 0 {
		t.Fatalf("created=%d superseded=%d", created, superseded)
	}
	if tx.countLog("SET title = $2") != 1 || tx.countLog("SET read_at = NULL") != 1 {
		t.Errorf("open redelivery must refresh and re-unread: %v", tx.log)
	}
	if tx.commits != 1 {
		t.Errorf("commits = %d", tx.commits)
	}
}

func TestReportOutdatedRedeliveryUnchangedIsAbsorbed(t *testing.T) {
	entry := outdatedEntry()
	title := "Update available: server 1.0.0 \u2192 1.1.0"
	payload := `{"current_version":"1.0.0","latest_version":"1.1.0","harness":"kiro"}`
	tx := &fakeTx{stubs: []stub{
		{match: "AND dedupe_key = $2", rows: &fakeRows{rows: [][]any{
			{"ex-1", "open", nil, title, *entry.registryURL(), *entry.upgradeCommand(), payload},
		}}},
	}}
	db := &txDB{tx: tx}
	created, superseded, err := (&Store{DB: db}).ReportOutdated(context.Background(), inboxUser,
		[]OutdatedEntry{entry})
	if err != nil {
		t.Fatal(err)
	}
	if created != 0 || superseded != 0 {
		t.Fatalf("created=%d superseded=%d", created, superseded)
	}
	if tx.countLog("SET title = $2") != 0 || tx.countLog("SET read_at = NULL") != 0 {
		t.Errorf("unchanged redelivery must not touch the row: %v", tx.log)
	}
}

func TestReportOutdatedBeginError(t *testing.T) {
	db := &txDB{beginErr: errors.New("pool down")}
	_, _, err := (&Store{DB: db}).ReportOutdated(context.Background(), inboxUser,
		[]OutdatedEntry{outdatedEntry()})
	if err == nil {
		t.Fatal("begin failure must propagate")
	}
}

// -- OutdatedEntry projections -----------------------------------------------

func TestOutdatedEntryLabel(t *testing.T) {
	entry := outdatedEntry()
	if entry.label() != "server" {
		t.Errorf("label = %q", entry.label())
	}
	entry.Name = ""
	if entry.label() != "tool" {
		t.Errorf("slug fallback = %q", entry.label())
	}
	entry.Slug = nil
	if entry.label() != entry.ComponentID.String() {
		t.Errorf("id fallback = %q", entry.label())
	}
}

func TestOutdatedEntryRegistryURL(t *testing.T) {
	entry := outdatedEntry()
	if u := entry.registryURL(); u == nil || *u != "/components/mcps/acme/tool" {
		t.Errorf("component canonical url = %v", u)
	}
	entry.Type = "agent"
	if u := entry.registryURL(); u == nil || *u != "/agents/acme/tool" {
		t.Errorf("agent canonical url = %v", u)
	}
	legacy := "Not Canonical"
	entry.Namespace = &legacy
	if u := entry.registryURL(); u == nil || *u != "/agents/"+entry.ComponentID.String() {
		t.Errorf("agent fallback url = %v", u)
	}
	entry.Type = "skill"
	if u := entry.registryURL(); u == nil || *u != "/components/"+entry.ComponentID.String()+"?type=skills" {
		t.Errorf("component fallback url = %v", u)
	}
	entry.Type = "unknown"
	if u := entry.registryURL(); u != nil {
		t.Errorf("unknown type url = %v, want nil", *u)
	}
}

func TestOutdatedEntryUpgradeCommand(t *testing.T) {
	entry := outdatedEntry()
	if c := entry.upgradeCommand(); c == nil ||
		*c != "caracal registry mcp install acme/tool --harness kiro --no-prompt" {
		t.Errorf("mcp command = %v", c)
	}
	entry.Type = "agent"
	if c := entry.upgradeCommand(); c == nil ||
		*c != "caracal agent pull acme/tool --harness kiro --no-prompt" {
		t.Errorf("agent command = %v", c)
	}
	entry.Type = "skill"
	if c := entry.upgradeCommand(); c == nil ||
		*c != "caracal registry skill install acme/tool --harness kiro" {
		t.Errorf("skill command = %v", c)
	}
	entry.Type = "prompt"
	if c := entry.upgradeCommand(); c != nil {
		t.Errorf("prompt command = %v, want nil", *c)
	}

	// A UUID target stands in when the canonical identity is incomplete.
	entry = outdatedEntry()
	entry.Namespace = nil
	if c := entry.upgradeCommand(); c == nil || !strings.Contains(*c, entry.ComponentID.String()) {
		t.Errorf("uuid target command = %v", c)
	}

	// Unsafe targets and harnesses produce no command at all.
	entry = outdatedEntry()
	bad := "bad ns"
	entry.Namespace = &bad
	if c := entry.upgradeCommand(); c != nil {
		t.Errorf("unsafe target command = %v, want nil", *c)
	}
	entry = outdatedEntry()
	entry.Harness = nil
	if c := entry.upgradeCommand(); c != nil {
		t.Errorf("missing harness command = %v, want nil", *c)
	}
	badHarness := "kiro; rm -rf /"
	entry.Harness = &badHarness
	if c := entry.upgradeCommand(); c != nil {
		t.Errorf("unsafe harness command = %v, want nil", *c)
	}
}

// -- small helpers -----------------------------------------------------------

func TestStrPtrEq(t *testing.T) {
	a, b := "x", "x"
	c := "y"
	if !strPtrEq(nil, nil) || !strPtrEq(&a, &b) {
		t.Error("equal cases misreported")
	}
	if strPtrEq(&a, nil) || strPtrEq(nil, &a) || strPtrEq(&a, &c) {
		t.Error("unequal cases misreported")
	}
}

func TestJSONEq(t *testing.T) {
	if !jsonEq([]byte(`{"a":1, "b":2}`), []byte(`{"b":2,"a":1}`)) {
		t.Error("canonical forms must compare equal")
	}
	if jsonEq([]byte(`{"a":1}`), []byte(`{"a":2}`)) {
		t.Error("different values compare equal")
	}
	// Invalid JSON falls back to byte equality.
	if !jsonEq([]byte("not json"), []byte("not json")) || jsonEq([]byte("not json"), []byte("other")) {
		t.Error("invalid JSON fallback broken")
	}
}

// jsonRoundTrip guards the ordered payload wire shape.
func TestOrderedPayloadShape(t *testing.T) {
	h := "kiro"
	raw, err := json.Marshal(orderedPayload{"1.0.0", "1.1.0", &h})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"current_version":"1.0.0","latest_version":"1.1.0","harness":"kiro"}`
	if string(raw) != want {
		t.Errorf("payload = %s", raw)
	}
}
