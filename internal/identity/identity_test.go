// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/garudex-labs/caracal/internal/auth"
)

// scanRow satisfies pgx.Row with positional values or an error.
type scanRow struct {
	vals []any
	err  error
}

func (r scanRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	for i, v := range r.vals {
		switch d := dest[i].(type) {
		case *uuid.UUID:
			*d = v.(uuid.UUID)
		case *string:
			*d = v.(string)
		case **string:
			if v == nil {
				*d = nil
			} else {
				s := v.(string)
				*d = &s
			}
		case *bool:
			*d = v.(bool)
		case *int:
			*d = v.(int)
		default:
			return errors.New("scanRow: unsupported dest")
		}
	}
	return nil
}

// scriptDB dispatches on SQL substrings so each provisioning step can be
// scripted independently.
type scriptDB struct {
	rows  map[string]scanRow
	execs map[string]error
	// execLog records which exec statements ran, by their matching key.
	execLog []string
}

func (f *scriptDB) match(keys map[string]scanRow, sql string) (scanRow, bool) {
	for k, v := range keys {
		if strings.Contains(sql, k) {
			return v, true
		}
	}
	return scanRow{}, false
}

func (f *scriptDB) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if row, ok := f.match(f.rows, sql); ok {
		return row
	}
	return scanRow{err: errors.New("scriptDB: unscripted query: " + sql)}
}

func (f *scriptDB) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	for k, err := range f.execs {
		if strings.Contains(sql, k) {
			f.execLog = append(f.execLog, k)
			if err != nil {
				return pgconn.CommandTag{}, err
			}
			return pgconn.NewCommandTag("INSERT 0 1"), nil
		}
	}
	return pgconn.CommandTag{}, errors.New("scriptDB: unscripted exec: " + sql)
}

func claimsFor(subject uuid.UUID, email string) auth.Claims {
	return auth.Claims{UserID: subject, Role: "user", Email: email, Name: "Test User"}
}

func TestResolveActiveExistingAccount(t *testing.T) {
	subject := uuid.New()
	localID := uuid.New()
	tests := []struct {
		name    string
		row     scanRow
		wantID  uuid.UUID
		wantErr error
	}{
		{"active user", scanRow{vals: []any{localID, "better-auth", "t@x.dev", "Test User"}}, localID, nil},
		{"adopted legacy user", scanRow{vals: []any{localID, "local", "t@x.dev", "Test User"}}, localID, nil},
		{"deactivated", scanRow{vals: []any{localID, "deactivated", "t@x.dev", "Test User"}}, uuid.Nil, ErrDeactivated},
		{"db down fails closed", scanRow{err: errors.New("conn refused")}, uuid.Nil, ErrUnavailable},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := &Directory{DB: &scriptDB{rows: map[string]scanRow{"WHERE auth_subject_id": tc.row}}}
			got, err := d.ResolveActive(context.Background(), claimsFor(subject, "t@x.dev"))
			if !errors.Is(err, tc.wantErr) {
				t.Errorf("ResolveActive() err = %v, want %v", err, tc.wantErr)
			}
			if got != tc.wantID {
				t.Errorf("ResolveActive() id = %s, want %s", got, tc.wantID)
			}
		})
	}
}

func TestResolveActiveNoEmailCannotProvision(t *testing.T) {
	d := &Directory{DB: &scriptDB{rows: map[string]scanRow{"WHERE auth_subject_id": {err: pgx.ErrNoRows}}}}
	_, err := d.ResolveActive(context.Background(), auth.Claims{UserID: uuid.New(), Role: "user"})
	if !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("err = %v, want ErrUnknownUser", err)
	}
}

func TestResolveActiveAdoptsByEmail(t *testing.T) {
	subject := uuid.New()
	legacyID := uuid.New()
	db := &scriptDB{
		rows: map[string]scanRow{
			"WHERE auth_subject_id": {err: pgx.ErrNoRows},
			"WHERE email":           {vals: []any{legacyID, "local", nil}},
		},
		execs: map[string]error{"SET auth_subject_id": nil},
	}
	d := &Directory{DB: db}
	got, err := d.ResolveActive(context.Background(), claimsFor(subject, "legacy@x.dev"))
	if err != nil || got != legacyID {
		t.Fatalf("adoption = %s, %v; want %s, nil", got, err, legacyID)
	}
	if len(db.execLog) != 1 || db.execLog[0] != "SET auth_subject_id" {
		t.Fatalf("execLog = %v, want the subject link", db.execLog)
	}
}

func TestResolveActiveRefusesForeignSubjectLink(t *testing.T) {
	legacyID := uuid.New()
	db := &scriptDB{
		rows: map[string]scanRow{
			"WHERE auth_subject_id": {err: pgx.ErrNoRows},
			"WHERE email":           {vals: []any{legacyID, "better-auth", uuid.NewString()}},
		},
	}
	d := &Directory{DB: db}
	_, err := d.ResolveActive(context.Background(), claimsFor(uuid.New(), "taken@x.dev"))
	if !errors.Is(err, ErrUnknownUser) {
		t.Fatalf("err = %v, want ErrUnknownUser (refuse foreign link)", err)
	}
	if len(db.execLog) != 0 {
		t.Fatalf("execLog = %v, want no writes", db.execLog)
	}
}

func TestResolveActiveAdoptionOfDeactivatedRefuses(t *testing.T) {
	db := &scriptDB{
		rows: map[string]scanRow{
			"WHERE auth_subject_id": {err: pgx.ErrNoRows},
			"WHERE email":           {vals: []any{uuid.New(), "deactivated", nil}},
		},
	}
	d := &Directory{DB: db}
	_, err := d.ResolveActive(context.Background(), claimsFor(uuid.New(), "gone@x.dev"))
	if !errors.Is(err, ErrDeactivated) {
		t.Fatalf("err = %v, want ErrDeactivated", err)
	}
}

func TestResolveActiveProvisionsNewAccount(t *testing.T) {
	db := &scriptDB{
		rows: map[string]scanRow{
			"WHERE auth_subject_id":     {err: pgx.ErrNoRows},
			"WHERE email":               {err: pgx.ErrNoRows},
			"FROM users WHERE username": {vals: []any{false}},
		},
		execs: map[string]error{
			"INSERT INTO users": nil,
		},
	}
	d := &Directory{DB: db}
	got, err := d.ResolveActive(context.Background(), claimsFor(uuid.New(), "fresh@x.dev"))
	if err != nil || got == uuid.Nil {
		t.Fatalf("provision = %s, %v; want a new id, nil", got, err)
	}
	joined := strings.Join(db.execLog, ",")
	if !strings.Contains(joined, "INSERT INTO users") {
		t.Fatalf("execLog = %v, want a user insert", db.execLog)
	}
	// Organization membership is never implicit: provisioning must not
	// write any membership rows.
	if strings.Contains(joined, "INSERT INTO organization_memberships") {
		t.Fatalf("execLog = %v, provisioning granted an implicit org membership", db.execLog)
	}
}

func TestProvisionElevatedRoleFromClaim(t *testing.T) {
	// The role claim is minted by the identity service, which is
	// authoritative at provisioning time (first-user bootstrap).
	for _, role := range []string{"super_admin", "made-up-role"} {
		db := &scriptDB{
			rows: map[string]scanRow{
				"WHERE auth_subject_id":     {err: pgx.ErrNoRows},
				"WHERE email":               {err: pgx.ErrNoRows},
				"FROM users WHERE username": {vals: []any{false}},
			},
			execs: map[string]error{"INSERT INTO users": nil},
		}
		d := &Directory{DB: db}
		claims := auth.Claims{UserID: uuid.New(), Role: role, Email: "r@x.dev"}
		if _, err := d.ResolveActive(context.Background(), claims); err != nil {
			t.Fatalf("role %q: %v", role, err)
		}
	}
}

func TestUsernameCandidates(t *testing.T) {
	tests := []struct {
		email     string
		wantFirst string
	}{
		{"richard.hendricks@example.com", "richard-hendricks"},
		{"RICHARD@EXAMPLE.COM", "richard"},
		{"a+b_c@x.dev", "a-b-c"},
		{"admin@x.dev", "admin-"}, // reserved namespace falls through to a suffixed form
		{"@x.dev", "user"},
		{"an-absurdly-long-local-part-far-beyond@x.dev", "an-absurdly-long-loc"},
	}
	for _, tc := range tests {
		got := usernameCandidates(tc.email)
		if len(got) == 0 {
			t.Fatalf("%q: no candidates", tc.email)
		}
		if !strings.HasPrefix(got[0], tc.wantFirst) {
			t.Errorf("%q: first candidate = %q, want prefix %q", tc.email, got[0], tc.wantFirst)
		}
		for _, c := range got {
			if len(c) < 3 || len(c) > 32 {
				t.Errorf("%q: candidate %q outside 3-32 chars", tc.email, c)
			}
		}
	}
}
