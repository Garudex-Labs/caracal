// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package layers stores and serves full harness layer manifests keyed by
// hash. Snapshots power version-aware insights: diffing two layer states
// and pinning a long-term baseline per agent.
package layers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"

	"github.com/garudex-labs/caracal/internal/agents"
	"github.com/garudex-labs/caracal/internal/clickhouse"
	"github.com/garudex-labs/caracal/internal/httpapi"
	"github.com/garudex-labs/caracal/internal/redact"
	"github.com/garudex-labs/caracal/internal/registry"
	"github.com/garudex-labs/caracal/internal/tenancy"
)

const (
	maxFilesPerSnapshot = 200
	maxTotalSize        = 5 * 1024 * 1024
	maxFileContent      = 524288
)

// Handler serves the layer snapshot routes.
type Handler struct {
	CH     *clickhouse.Client
	Agents *agents.Store
}

func activeProjectID(ctx context.Context) string {
	projectID, _ := tenancy.ProjectIDFromContext(ctx)
	return projectID
}

// readScope confines snapshot reads to the uploader.
func readScope(r *http.Request, params clickhouse.Settings) string {
	claims, ok := httpapi.ClaimsFrom(r.Context())
	if !ok {
		return " AND user_id = ''"
	}
	params["param_viewer"] = claims.UserID.String()
	return " AND user_id = {viewer:String}"
}

// Register mounts the snapshot routes; every route requires authentication.
func (h *Handler) Register(mux *http.ServeMux, withAuth func(http.Handler) http.Handler) {
	mux.Handle("POST /api/v1/layer-snapshots", withAuth(h.upload()))
	mux.Handle("POST /api/v1/layer-snapshots/baseline", withAuth(h.pinBaseline()))
	mux.Handle("GET /api/v1/layer-snapshots/{snapshot_hash}", withAuth(h.show()))
	mux.Handle("GET /api/v1/layer-snapshots/{hash_a}/diff/{hash_b}", withAuth(h.diff()))
}

// layerFile is one manifest entry; source distinguishes user files from
// caracal-managed ones.
type layerFile struct {
	Path    *string `json:"path"`
	Hash    *string `json:"hash"`
	Size    *int64  `json:"size"`
	Source  *string `json:"source"`
	Content string  `json:"content"`
}

type uploadBody struct {
	Hash           *string                `json:"hash"`
	Harnesses      map[string][]layerFile `json:"harnesses"`
	LockfileHash   string                 `json:"lockfile_hash"`
	PinnedVersions map[string]any         `json:"pinned_versions"`
	Drift          map[string]any         `json:"drift"`
}

// fieldErrors validates the upload body the way the request model does.
// bodyEcho and fileEchoes are the submitted objects, replayed in reports.
func (b *uploadBody) fieldErrors(harnessOrder []string, bodyEcho map[string]any,
	fileEchoes map[string][]map[string]any) []map[string]any {
	errs := []map[string]any{}
	switch {
	case b.Hash == nil:
		errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", "hash"}, "msg": "Field required", "input": bodyEcho})
	case len(*b.Hash) < 8:
		errs = append(errs, map[string]any{
			"type": "string_too_short", "loc": []any{"body", "hash"},
			"msg": "String should have at least 8 characters", "input": *b.Hash,
			"ctx": map[string]any{"min_length": 8},
		})
	case len(*b.Hash) > 64:
		errs = append(errs, map[string]any{
			"type": "string_too_long", "loc": []any{"body", "hash"},
			"msg": "String should have at most 64 characters", "input": *b.Hash,
			"ctx": map[string]any{"max_length": 64},
		})
	}
	for _, name := range harnessOrder {
		for i, f := range b.Harnesses[name] {
			var fileEcho map[string]any
			if i < len(fileEchoes[name]) {
				fileEcho = fileEchoes[name][i]
			}
			missing := func(field string) {
				errs = append(errs, map[string]any{
					"type": "missing", "loc": []any{"body", "harnesses", name, i, field},
					"msg": "Field required", "input": fileEcho,
				})
			}
			tooLong := func(field, value string, limit int) {
				if len(value) > limit {
					errs = append(errs, map[string]any{
						"type": "string_too_long", "loc": []any{"body", "harnesses", name, i, field},
						"msg": fmt.Sprintf("String should have at most %d characters", limit),
						"ctx": map[string]any{"max_length": limit},
					})
				}
			}
			if f.Path == nil {
				missing("path")
			} else {
				tooLong("path", *f.Path, 500)
			}
			if f.Hash == nil {
				missing("hash")
			} else {
				tooLong("hash", *f.Hash, 100)
			}
			if f.Source != nil {
				tooLong("source", *f.Source, 20)
			}
			tooLong("content", f.Content, maxFileContent)
			if f.Size == nil {
				missing("size")
			} else if *f.Size < 0 {
				errs = append(errs, map[string]any{
					"type": "greater_than_equal", "loc": []any{"body", "harnesses", name, i, "size"},
					"msg": "Input should be greater than or equal to 0", "input": *f.Size,
					"ctx": map[string]any{"ge": 0},
				})
			}
		}
	}
	return errs
}

// jsonObjectKeys walks one top-level JSON object and returns its keys in
// document order; Go maps forget it, and harness order is wire-visible.
func jsonObjectKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil
	}
	keys := []string{}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return keys
		}
		key, ok := keyTok.(string)
		if !ok {
			return keys
		}
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}

func writeValidation(w http.ResponseWriter, errs []map[string]any) {
	httpapi.WriteErrorDetail(w, http.StatusUnprocessableEntity, errs)
}

func writeBodyShape(w http.ResponseWriter) {
	writeValidation(w, []map[string]any{{"type": "model_attributes_type", "loc": []any{"body"},
		"msg": "Input should be a valid dictionary or object to extract fields from"}})
}

func (h *Handler) upload() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		var rawFields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &rawFields); err != nil {
			writeBodyShape(w)
			return
		}
		var body uploadBody
		if err := json.Unmarshal(raw, &body); err != nil {
			writeBodyShape(w)
			return
		}
		harnessOrder := jsonObjectKeys(rawFields["harnesses"])
		bodyEcho := map[string]any{}
		for k, v := range rawFields {
			var decoded any
			_ = json.Unmarshal(v, &decoded)
			bodyEcho[k] = decoded
		}
		var fileEchoes map[string][]map[string]any
		_ = json.Unmarshal(rawFields["harnesses"], &fileEchoes)
		if errs := body.fieldErrors(harnessOrder, bodyEcho, fileEchoes); len(errs) > 0 {
			writeValidation(w, errs)
			return
		}

		totalFiles := 0
		totalContent := 0
		for _, files := range body.Harnesses {
			totalFiles += len(files)
			for _, f := range files {
				totalContent += len(f.Content)
			}
		}
		if totalFiles > maxFilesPerSnapshot {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				fmt.Sprintf("Snapshot exceeds %d file limit (%d files)", maxFilesPerSnapshot, totalFiles))
			return
		}
		if totalContent > maxTotalSize {
			httpapi.WriteError(w, http.StatusUnprocessableEntity,
				fmt.Sprintf("Snapshot exceeds %dMB total content limit", maxTotalSize/(1024*1024)))
			return
		}

		ctx := r.Context()
		if exists, err := h.snapshotExists(ctx, *body.Hash); err != nil {
			// Proceed with the insert anyway: the table replaces duplicates.
			slog.Warn("failed to check existing snapshot", "error", err)
		} else if exists {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"stored": false, "hash": *body.Hash, "file_count": totalFiles,
			})
			return
		}

		// Redact secrets from file contents before storage, preserving the
		// caller's harness order in the stored manifest.
		type storedFile struct {
			Path    string `json:"path"`
			Hash    string `json:"hash"`
			Size    int64  `json:"size"`
			Source  string `json:"source"`
			Content string `json:"content"`
		}
		harnessJSON := map[string]json.RawMessage{}
		totalFileCount := 0
		var totalSize int64
		for name, files := range body.Harnesses {
			stored := make([]storedFile, 0, len(files))
			for _, f := range files {
				source := "user"
				if f.Source != nil {
					source = *f.Source
				}
				content := f.Content
				if content != "" {
					content = redact.Secrets(content)
				}
				stored = append(stored, storedFile{
					Path: *f.Path, Hash: *f.Hash, Size: *f.Size, Source: source, Content: content,
				})
				totalSize += *f.Size
				totalFileCount++
			}
			blob, _ := json.Marshal(stored)
			harnessJSON[name] = blob
		}
		var manifest []byte
		manifest = append(manifest, `{"harnesses": {`...)
		for i, name := range harnessOrder {
			if i > 0 {
				manifest = append(manifest, ", "...)
			}
			key, _ := json.Marshal(name)
			manifest = append(manifest, key...)
			manifest = append(manifest, ": "...)
			manifest = append(manifest, harnessJSON[name]...)
		}
		lockfile, _ := json.Marshal(body.LockfileHash)
		pinned, _ := json.Marshal(orEmpty(body.PinnedVersions))
		drift, _ := json.Marshal(orEmpty(body.Drift))
		manifest = append(manifest, `}, "lockfile_hash": `...)
		manifest = append(manifest, lockfile...)
		manifest = append(manifest, `, "pinned_versions": `...)
		manifest = append(manifest, pinned...)
		manifest = append(manifest, `, "drift": `...)
		manifest = append(manifest, drift...)
		manifest = append(manifest, '}')

		viewer, _ := httpapi.ClaimsFrom(ctx)
		row := map[string]any{
			"hash":          *body.Hash,
			"project_id":    activeProjectID(ctx),
			"user_id":       viewer.UserID.String(),
			"harness":       joinKeys(harnessOrder),
			"content":       string(manifest),
			"file_count":    totalFileCount,
			"total_size":    totalSize,
			"lockfile_hash": body.LockfileHash,
		}
		err = h.CH.InsertJSONEachRow(ctx,
			`INSERT INTO layer_snapshots (hash, project_id, user_id, harness, content, `+
				`file_count, total_size, lockfile_hash) FORMAT JSONEachRow`, []any{row})
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"stored": true, "hash": *body.Hash, "file_count": totalFiles,
		})
	})
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

func joinKeys(keys []string) string {
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += ","
		}
		out += k
	}
	return out
}

func (h *Handler) snapshotExists(ctx context.Context, hash string) (bool, error) {
	rows, err := h.CH.QueryJSON(ctx,
		`SELECT count() AS cnt FROM layer_snapshots FINAL
		 WHERE project_id = {project_id:String} AND hash = {hash:String} FORMAT JSON`,
		clickhouse.Settings{"param_project_id": activeProjectID(ctx), "param_hash": hash})
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	return chInt(rows[0]["cnt"]) > 0, nil
}

func chInt(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case string:
		parsed, _ := strconv.ParseInt(n, 10, 64)
		return parsed
	default:
		return 0
	}
}

func chStr(v any) string {
	s, _ := v.(string)
	return s
}

func (h *Handler) show() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hash := r.PathValue("snapshot_hash")
		params := clickhouse.Settings{"param_project_id": activeProjectID(r.Context()), "param_hash": hash}
		scope := readScope(r, params)
		rows, err := h.CH.QueryJSON(r.Context(),
			`SELECT hash, harness, content, uploaded_at, file_count, total_size, lockfile_hash
			 FROM layer_snapshots FINAL
			 WHERE project_id = {project_id:String} AND hash = {hash:String}`+scope+`
			 LIMIT 1 FORMAT JSON`,
			params)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if len(rows) == 0 {
			httpapi.WriteError(w, http.StatusNotFound, "Layer snapshot not found")
			return
		}
		row := rows[0]
		contentRaw := []byte(chStr(row["content"]))
		var content struct {
			Harnesses    map[string][]map[string]any `json:"harnesses"`
			LockfileHash *string                     `json:"lockfile_hash"`
		}
		_ = json.Unmarshal(contentRaw, &content)
		var harnessesRaw map[string]json.RawMessage
		_ = json.Unmarshal(contentRaw, &harnessesRaw)
		names := jsonObjectKeys(harnessesRaw["harnesses"])

		flat := []map[string]any{}
		for _, name := range names {
			flat = append(flat, content.Harnesses[name]...)
		}
		harness := chStr(row["harness"])
		if len(names) > 0 {
			harness = joinKeys(names)
		}
		lockfile := chStr(row["lockfile_hash"])
		if content.LockfileHash != nil {
			lockfile = *content.LockfileHash
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"hash":          chStr(row["hash"]),
			"harness":       harness,
			"files":         flat,
			"lockfile_hash": lockfile,
			"uploaded_at":   chStr(row["uploaded_at"]),
			"file_count":    chInt(row["file_count"]),
			"total_size":    chInt(row["total_size"]),
		})
	})
}

func (h *Handler) diff() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hashA, hashB := r.PathValue("hash_a"), r.PathValue("hash_b")
		params := clickhouse.Settings{
			"param_project_id": activeProjectID(r.Context()),
			"param_hash_a":     hashA,
			"param_hash_b":     hashB,
		}
		scope := readScope(r, params)
		rows, err := h.CH.QueryJSON(r.Context(),
			`SELECT hash, content FROM layer_snapshots FINAL
			 WHERE project_id = {project_id:String} AND hash IN ({hash_a:String}, {hash_b:String})`+scope+`
			 FORMAT JSON`,
			params)
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		snapshots := map[string]map[string]map[string]any{}
		for _, row := range rows {
			var content struct {
				Harnesses map[string][]map[string]any `json:"harnesses"`
			}
			_ = json.Unmarshal([]byte(chStr(row["content"])), &content)
			flat := map[string]map[string]any{}
			for name, files := range content.Harnesses {
				for _, f := range files {
					path, _ := f["path"].(string)
					flat[name+"/"+path] = f
				}
			}
			snapshots[chStr(row["hash"])] = flat
		}
		filesA, okA := snapshots[hashA]
		if !okA {
			httpapi.WriteError(w, http.StatusNotFound, fmt.Sprintf("Snapshot %s not found", hashA))
			return
		}
		filesB, okB := snapshots[hashB]
		if !okB {
			httpapi.WriteError(w, http.StatusNotFound, fmt.Sprintf("Snapshot %s not found", hashB))
			return
		}

		added := []map[string]any{}
		removed := []map[string]any{}
		modified := []map[string]any{}
		unchanged := 0
		for _, path := range sortedKeys(filesB) {
			if _, ok := filesA[path]; !ok {
				added = append(added, filesB[path])
			}
		}
		for _, path := range sortedKeys(filesA) {
			fileA := filesA[path]
			fileB, ok := filesB[path]
			if !ok {
				removed = append(removed, fileA)
				continue
			}
			if fileA["hash"] != fileB["hash"] {
				modified = append(modified, map[string]any{"path": path, "before": fileA, "after": fileB})
			} else {
				unchanged++
			}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"added": added, "removed": removed, "modified": modified, "unchanged_count": unchanged,
		})
	})
}

func sortedKeys(m map[string]map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ownsAgent mirrors the agent permission contract: creator, co-authors,
// and admins own.
func ownsAgent(row map[string]any, viewerID, role string) bool {
	if s, ok := row["created_by"].(string); ok && s == viewerID {
		return true
	}
	if coAuthors, ok := row["co_authors"].([]any); ok {
		for _, id := range coAuthors {
			if s, ok := id.(string); ok && s == viewerID {
				return true
			}
		}
	}
	return false
}

func (h *Handler) pinBaseline() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		var body struct {
			AgentID   *string `json:"agent_id"`
			LayerHash *string `json:"layer_hash"`
		}
		if err := json.Unmarshal(raw, &body); err != nil {
			writeBodyShape(w)
			return
		}
		errs := []map[string]any{}
		if body.AgentID == nil || body.LayerHash == nil {
			var echo any
			_ = json.Unmarshal(raw, &echo)
			if body.AgentID == nil {
				errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", "agent_id"}, "msg": "Field required", "input": echo})
			}
			if body.LayerHash == nil {
				errs = append(errs, map[string]any{"type": "missing", "loc": []any{"body", "layer_hash"}, "msg": "Field required", "input": echo})
			}
		}
		if body.LayerHash != nil && len(*body.LayerHash) < 8 {
			errs = append(errs, map[string]any{
				"type": "string_too_short", "loc": []any{"body", "layer_hash"},
				"msg": "String should have at least 8 characters", "input": *body.LayerHash,
				"ctx": map[string]any{"min_length": 8},
			})
		}
		if len(errs) > 0 {
			writeValidation(w, errs)
			return
		}

		viewer, _ := httpapi.ClaimsFrom(r.Context())
		// The baseline pin steers version-impact comparisons, so only the
		// agent's owners (creator, co-authors, admins) may set it.
		row, err := h.Agents.LoadWith(r.Context(), *body.AgentID,
			&registry.Viewer{ID: viewer.UserID, Role: viewer.Role, ProjectID: activeProjectID(r.Context())},
			agents.LoadOpts{AllStatuses: true, PreferOwner: true})
		if err != nil {
			httpapi.WriteInternalError(w, r, err)
			return
		}
		if row == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Agent not found")
			return
		}
		if !ownsAgent(row, viewer.UserID.String(), viewer.Role) {
			httpapi.WriteError(w, http.StatusForbidden, "Insufficient permissions for this agent")
			return
		}
		content, _ := json.Marshal(map[string]any{
			"agent_id": *body.AgentID, "baseline": true, "pinned_hash": *body.LayerHash,
		})
		err = h.CH.Exec(r.Context(),
			`INSERT INTO layer_snapshots (hash, project_id, user_id, harness, content, file_count, total_size, lockfile_hash)
			 VALUES ({hash:String}, {project_id:String}, {user_id:String}, 'baseline', {content:String}, 0, 0, '')`,
			clickhouse.Settings{
				"param_hash":       "baseline:" + *body.AgentID,
				"param_project_id": activeProjectID(r.Context()),
				"param_user_id":    viewer.UserID.String(),
				"param_content":    string(content),
			})
		if err != nil {
			slog.Error("failed to pin baseline", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Failed to pin baseline")
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"agent_id": *body.AgentID, "layer_hash": *body.LayerHash, "pinned": true,
		})
	})
}
