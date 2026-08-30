// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package tenancy

import "context"

type projectScopeKey struct{}

// ContextWithProjectID records the server-validated active project for the request.
func ContextWithProjectID(ctx context.Context, projectID string) context.Context {
	return context.WithValue(ctx, projectScopeKey{}, projectID)
}

// ProjectIDFromContext returns the server-validated active project, if any.
func ProjectIDFromContext(ctx context.Context) (string, bool) {
	projectID, ok := ctx.Value(projectScopeKey{}).(string)
	return projectID, ok && projectID != ""
}
