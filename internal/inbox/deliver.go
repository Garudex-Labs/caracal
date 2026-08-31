// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package inbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Subject is the thing an inbox item is about.
type Subject struct {
	Type      string
	ID        *uuid.UUID
	Name      string
	Namespace *string
	Slug      *string
	Handle    string
	Version   *string
	ProjectID *uuid.UUID
	IsPrivate bool
}

func (s Subject) versioned() string {
	if s.Version != nil && *s.Version != "" {
		return s.label() + " v" + *s.Version
	}
	return s.label()
}

func (s Subject) versionKey() string {
	if s.Version != nil && *s.Version != "" {
		return *s.Version
	}
	return "-"
}

func (s Subject) label() string {
	if s.Name != "" {
		return s.Name
	}
	if s.Slug != nil && *s.Slug != "" {
		return *s.Slug
	}
	if s.ID != nil {
		return s.ID.String()
	}
	return "item"
}

// kindSpec is how one kind renders and deduplicates.
type kindSpec struct {
	actionRequired     bool
	reopenOnRedelivery bool
	title              func(Subject, map[string]any) string
	dedupe             func(Subject, map[string]any) string
	url                func(Subject) *string
	// command is the CLI action recorded alongside the item; most kinds
	// have none.
	command func(Subject, map[string]any) *string
}

// registryURL is the canonical product URL for a subject, with a UUID
// fallback for legacy identities.
func registryURL(s Subject) *string {
	if s.Type == "agent" {
		ns, slug := "", ""
		if s.Namespace != nil {
			ns = strings.TrimSpace(*s.Namespace)
		}
		if s.Slug != nil {
			slug = strings.TrimSpace(*s.Slug)
		}
		var url string
		switch {
		case ns == strings.ToLower(ns) && slug == strings.ToLower(slug) &&
			namespaceRe.MatchString(ns) && !strings.Contains(ns, "..") && slugRe.MatchString(slug):
			url = fmt.Sprintf("/agents/%s/%s", ns, slug)
		case s.ID != nil:
			url = "/agents/" + s.ID.String()
		default:
			return nil
		}
		return &url
	}
	return nil
}

// componentTypeParam maps a singular component subject type to the plural
// `?type=` value the web component route expects.
var componentTypeParam = map[string]string{
	"mcp":    "mcps",
	"skill":  "skills",
	"hook":   "hooks",
	"prompt": "prompts",
}

// reviewURL points reviewers at the resource's own in-context review view
// (?view=review). The UUID route is deliberate: the canonical namespace/slug
// resolve route only answers for approved-or-owned listings, which would
// strand a reviewer following a link to someone else's pending submission.
func reviewURL(s Subject) *string {
	url := "/resources"
	if s.ID != nil {
		if s.Type == "agent" {
			url = "/agents/" + s.ID.String() + "?view=review"
		} else if plural, ok := componentTypeParam[s.Type]; ok {
			url = "/components/" + s.ID.String() + "?type=" + plural + "&view=review"
		}
	}
	return &url
}

func reviewShowCommand(s Subject, _ map[string]any) *string {
	if s.ID == nil {
		return nil
	}
	suffix := ""
	if s.Type == "agent" {
		suffix = " --agent"
	}
	cmd := "caracal admin review show " + s.ID.String() + suffix
	return &cmd
}

func ctxStr(ctx map[string]any, key, fallback string) string {
	if v, ok := ctx[key].(string); ok && v != "" {
		return v
	}
	return fallback
}

// kindSpecs covers the kinds delivered from this service.
var kindSpecs = map[string]kindSpec{
	"review_requested": {
		actionRequired:     true,
		reopenOnRedelivery: true,
		title:              func(s Subject, _ map[string]any) string { return "Review requested: " + s.versioned() },
		dedupe: func(s Subject, _ map[string]any) string {
			return fmt.Sprintf("review_requested:%s:%s:v%s", s.Type, s.ID, s.versionKey())
		},
		url:     reviewURL,
		command: reviewShowCommand,
	},
	"review_approved": {
		actionRequired:     false,
		reopenOnRedelivery: true,
		title:              func(s Subject, _ map[string]any) string { return "Approved: " + s.versioned() },
		dedupe: func(s Subject, _ map[string]any) string {
			return fmt.Sprintf("review_approved:%s:%s:v%s", s.Type, s.ID, s.versionKey())
		},
		url: registryURL,
	},
	"review_rejected": {
		actionRequired:     true,
		reopenOnRedelivery: true,
		title:              func(s Subject, _ map[string]any) string { return "Changes needed: " + s.versioned() },
		dedupe: func(s Subject, _ map[string]any) string {
			return fmt.Sprintf("review_rejected:%s:%s:v%s", s.Type, s.ID, s.versionKey())
		},
		url: registryURL,
	},
	"review_comment": {
		actionRequired: false,
		title:          func(s Subject, _ map[string]any) string { return "New comment on " + s.label() },
		dedupe: func(s Subject, c map[string]any) string {
			return fmt.Sprintf("review_comment:%s:%s:%s", s.Type, s.ID, ctxStr(c, "comment_id", "-"))
		},
	},
	"change_requested": {
		actionRequired: true,
		title:          func(s Subject, _ map[string]any) string { return "Changes requested on " + s.label() },
		dedupe: func(s Subject, c map[string]any) string {
			return fmt.Sprintf("change_requested:%s:%s:%s", s.Type, s.ID, ctxStr(c, "request_id", "-"))
		},
	},
}

func truncate(v string, limit int) string {
	if len(v) > limit {
		return v[:limit]
	}
	return v
}

// DeliverOne writes one item inside the caller's transaction, recovering a
// dedupe collision in a savepoint so sibling work is never rolled back.
// Returns the item id when a new fact landed or was resurrected, nil when
// the redelivery was absorbed.
func DeliverOne(ctx context.Context, tx pgx.Tx, kind string, userID uuid.UUID, subject Subject,
	actorID *uuid.UUID, body *string, context map[string]any, actionRequired *bool) (*uuid.UUID, error) {
	spec, ok := kindSpecs[kind]
	if !ok {
		return nil, fmt.Errorf("inbox: no delivery spec for kind %q", kind)
	}
	if context == nil {
		context = map[string]any{}
	}
	required := spec.actionRequired
	if actionRequired != nil {
		required = *actionRequired
	}
	payload, err := json.Marshal(context)
	if err != nil {
		return nil, err
	}
	title := truncate(spec.title(subject, context), 255)
	dedupe := truncate(spec.dedupe(subject, context), 255)
	var actionURL *string
	if spec.url != nil {
		if u := spec.url(subject); u != nil {
			trimmed := truncate(*u, 500)
			actionURL = &trimmed
		}
	}
	var actionCommand *string
	if spec.command != nil {
		if c := spec.command(subject, context); c != nil {
			trimmed := truncate(*c, 500)
			actionCommand = &trimmed
		}
	}
	itemID := uuid.New()

	sp, err := tx.Begin(ctx) // SAVEPOINT: a collision must not poison the batch
	if err != nil {
		return nil, err
	}
	_, err = sp.Exec(ctx,
		`INSERT INTO inbox_items (
		   id, user_id, kind, state, action_required, title, body,
		   subject_type, subject_id, subject_namespace, subject_slug,
		   action_url, action_command, actor_id, project_id, is_private_subject,
		   dedupe_key, payload, created_at)
		 VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
		itemID, userID, kind, required, title, body,
		subject.Type, subject.ID, subject.Namespace, subject.Slug,
		actionURL, actionCommand, actorID, subject.ProjectID, subject.IsPrivate, dedupe, payload)
	if err != nil {
		_ = sp.Rollback(ctx)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.ConstraintName != "uq_inbox_items_user_dedupe" {
			return nil, err
		}
		return onDuplicate(ctx, tx, spec, userID, dedupe, title, body, actionURL, actionCommand, payload, actorID)
	}
	if err := sp.Commit(ctx); err != nil {
		return nil, err
	}
	if err := txRecordEvent(ctx, tx, itemID.String(), "created", actorID, nil); err != nil {
		return nil, err
	}
	return &itemID, nil
}

// onDuplicate refreshes a colliding item's presentation and, for kinds that
// resurrect, reopens a resolved copy so the recipient learns the fact is back.
func onDuplicate(ctx context.Context, tx pgx.Tx, spec kindSpec, userID uuid.UUID, dedupe, title string,
	body, actionURL, actionCommand *string, payload []byte, actorID *uuid.UUID) (*uuid.UUID, error) {
	var id uuid.UUID
	var state, oldTitle string
	var oldBody, oldURL, oldCommand *string
	var oldPayload []byte
	err := tx.QueryRow(ctx,
		`SELECT id, state, title, body, action_url, action_command, payload::text FROM inbox_items
		 WHERE user_id = $1 AND dedupe_key = $2`, userID, dedupe).
		Scan(&id, &state, &oldTitle, &oldBody, &oldURL, &oldCommand, &oldPayload)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	changed := oldTitle != title || !strPtrEq(oldBody, body) || !strPtrEq(oldURL, actionURL) ||
		!strPtrEq(oldCommand, actionCommand) || !jsonEq(oldPayload, payload)
	if changed {
		if _, err := tx.Exec(ctx,
			`UPDATE inbox_items SET title = $2, body = $3, action_url = $4, action_command = $5, payload = $6 WHERE id = $1`,
			id, title, body, actionURL, actionCommand, payload); err != nil {
			return nil, err
		}
	}
	if state == "open" {
		if changed {
			detail := "Redelivered with updated details"
			if _, err := tx.Exec(ctx, "UPDATE inbox_items SET read_at = NULL WHERE id = $1", id); err != nil {
				return nil, err
			}
			if err := txRecordEvent(ctx, tx, id.String(), "updated", actorID, &detail); err != nil {
				return nil, err
			}
		}
		return nil, nil
	}
	if !spec.reopenOnRedelivery {
		return nil, nil
	}
	if _, err := tx.Exec(ctx,
		"UPDATE inbox_items SET state = 'open', resolved_at = NULL, read_at = NULL WHERE id = $1", id); err != nil {
		return nil, err
	}
	detail := "Redelivered after resolution"
	if err := txRecordEvent(ctx, tx, id.String(), "reopened", actorID, &detail); err != nil {
		return nil, err
	}
	return &id, nil
}

func txRecordEvent(ctx context.Context, tx pgx.Tx, itemID, event string, actorID *uuid.UUID, detail *string) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO inbox_item_events (id, item_id, event, actor_id, detail, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())`, uuid.New(), itemID, event, actorID, detail)
	return err
}

// Deliver fans one fact out to its recipients; skipActor keeps a user from
// being told about their own action.
func Deliver(ctx context.Context, tx pgx.Tx, kind string, recipients []uuid.UUID, subject Subject,
	actorID *uuid.UUID, body *string, context map[string]any, skipActor bool) (int, error) {
	seen := map[uuid.UUID]bool{}
	delivered := 0
	for _, userID := range recipients {
		if seen[userID] {
			continue
		}
		seen[userID] = true
		if skipActor && actorID != nil && userID == *actorID {
			continue
		}
		id, err := DeliverOne(ctx, tx, kind, userID, subject, actorID, body, context, nil)
		if err != nil {
			return delivered, err
		}
		if id != nil {
			delivered++
		}
	}
	return delivered, nil
}

// ResolveMatching closes EVERY recipient's open copy of one fact that
// stopped being true, each with its own history entry.
func ResolveMatching(ctx context.Context, tx pgx.Tx, kind, dedupeKey, detail string, actorID *uuid.UUID) (int, error) {
	rows, err := tx.Query(ctx,
		`SELECT id FROM inbox_items WHERE kind = $1 AND dedupe_key = $2 AND state = 'open'`, kind, dedupeKey)
	if err != nil {
		return 0, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx,
			"UPDATE inbox_items SET state = 'done', resolved_at = now() WHERE id = $1", id); err != nil {
			return 0, err
		}
		if err := txRecordEvent(ctx, tx, id.String(), "done", actorID, &detail); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// GlobalReviewers lists reviewer, admin, and super-admin recipients.
func GlobalReviewers(ctx context.Context, q PGQuerier) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx,
		`SELECT id FROM users WHERE role IN ('reviewer', 'operator')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// DedupeKeyFor exposes a kind's dedupe key so producers can close matching
// items when the fact stops being true.
func DedupeKeyFor(kind string, subject Subject, context map[string]any) (string, error) {
	spec, ok := kindSpecs[kind]
	if !ok {
		return "", fmt.Errorf("inbox: no delivery spec for kind %q", kind)
	}
	if context == nil {
		context = map[string]any{}
	}
	return truncate(spec.dedupe(subject, context), 255), nil
}
