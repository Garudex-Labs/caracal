// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"errors"
	"net/url"

	"github.com/jackc/pgx/v5"
)

// This file is the consumption surface for sibling route domains (agents,
// review): row visibility, keyword search, wire datetimes, and the shared
// request-validation helpers, re-exported without behavior changes.

// ScopeSQL renders the caller-visibility row filter for a listing-shaped
// table alias (columns: is_private, ownership_scope, project_id).
// creatorCol names the authorship column, e.g. "a.created_by".
func ScopeSQL(alias, creatorCol string, viewer *Viewer, args *[]any) string {
	return visibilitySQLCreator(alias, creatorCol, viewer, args)
}

// KeywordTerms tokenizes a search query: phrase first, then tokens.
func KeywordTerms(query string) []string {
	return searchTerms(query)
}

// KeywordSQL renders the ILIKE OR condition and the rank expression for the
// given terms; nameField scores 100/12, every field scores 40/4.
func KeywordSQL(terms []string, nameField string, fields []string, args *[]any) (where, rank string) {
	return searchSQL(terms, nameField, fields, args)
}

// WireTime renders timestamps RFC 3339 with a Z suffix, microseconds only
// when nonzero; non-time values pass through as nil.
func WireTime(v any) any {
	return wireTimeZ(v)
}

// CollectRows materializes pgx rows into column-keyed maps.
func CollectRows(rows pgx.Rows) []map[string]any {
	return collectRows(rows)
}

// APIErrorOf unwraps a store rejection into its wire status and detail.
func APIErrorOf(err error) (int, string, bool) {
	var api *apiError
	if errors.As(err, &api) {
		return api.Status, api.Detail, true
	}
	return 0, "", false
}

// FieldError is one item of the request-validation error body.
type FieldError = fieldError

// ParseIntQuery validates an integer query parameter with ge/le bounds
// (max < 0 disables the upper bound).
func ParseIntQuery(q url.Values, name string, def, min, max int, errs *[]FieldError) int {
	return intParam(q, name, def, min, max, errs)
}

// ParseBoolQuery validates a boolean query parameter.
func ParseBoolQuery(q url.Values, name string, errs *[]FieldError) bool {
	return boolParam(q, name, errs)
}

// ParseUUIDQuery validates a UUID query parameter, returning its canonical
// string form or "".
func ParseUUIDQuery(q url.Values, name string, errs *[]FieldError) string {
	return uuidParam(q, name, errs)
}
