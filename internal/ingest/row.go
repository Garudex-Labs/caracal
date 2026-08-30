// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package ingest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"github.com/garudex-labs/caracal/internal/harness"
	"github.com/garudex-labs/caracal/internal/redact"
	"github.com/zeebo/xxh3"
)

// Row is one classified transcript line as stored in session_events.
// Field names match the ClickHouse columns and the golden fixtures.
type Row struct {
	Harness         string  `json:"harness"`
	LineOffset      int     `json:"line_offset"`
	SourceEndOffset int64   `json:"source_end_offset"`
	LineHash        string  `json:"line_hash"`
	SourceSHA256    string  `json:"source_sha256"`
	IsSourceRecord  int     `json:"is_source_record"`
	Rendered        int     `json:"rendered"`
	EventType       string  `json:"event_type"`
	Timestamp       string  `json:"timestamp"`
	IngestedAt      string  `json:"ingested_at"`
	UUID            *string `json:"uuid"`
	ParentUUID      *string `json:"parent_uuid"`
	ToolName        *string `json:"tool_name"`
	ToolID          *string `json:"tool_id"`
	ContentPreview  string  `json:"content_preview"`
	ContentLength   int     `json:"content_length"`
	RawLine         string  `json:"raw_line"`
	Credits         float64 `json:"credits"`
	Usage
}

// Disposition says how one line was classified.
type Disposition int

const (
	// LineRendered rows carry a visible event.
	LineRendered Disposition = iota
	// LineIgnored rows are stored but carry no signal (empty continuations).
	LineIgnored
	// LineParseError rows failed to decode; kept so the read path sees them.
	LineParseError
)

// BuildStats counts per-batch line dispositions.
type BuildStats struct {
	Ingested int // rendered rows
	Skipped  int // classified as ignorable
	Errors   int // lines that failed to parse
}

// Builder turns raw transcript lines into rows for one harness session. It
// carries timestamp-inheritance state across lines, so build lines in source
// order and use one Builder per batch.
type Builder struct {
	harnessName string
	classifier  classifier

	// Redact scrubs secrets from previews and stored raw lines.
	Redact func(string) string
	// Now supplies the timestamp fallback for lines without one, in
	// ClickHouse format ("2026-01-01 00:00:00.000").
	Now func() string
	// IngestedAt stamps every row in the batch.
	IngestedAt string

	lastRealTS string
}

// NewBuilder resolves the classifier for harnessName from the registry.
// Unknown harnesses and harnesses without a session parser are errors.
func NewBuilder(reg *harness.Registry, harnessName string) (*Builder, error) {
	c, err := classifierFor(reg, harnessName)
	if err != nil {
		return nil, err
	}
	return &Builder{
		harnessName: harnessName,
		classifier:  c,
		Redact:      redact.Secrets,
		Now:         clickhouseNow,
		IngestedAt:  clickhouseNow(),
	}, nil
}

func clickhouseNow() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05.000")
}

// Build classifies one raw JSONL line at its stable source offset. Lines
// that fail to parse become _parse_error rows; nothing is dropped.
func (b *Builder) Build(rawLine string, offset int, endOffset int64) (Row, Disposition) {
	var parsed map[string]any
	eventType := "_parse_error"
	disposition := LineParseError
	rendered := 0

	var decoded any
	if err := json.Unmarshal([]byte(rawLine), &decoded); err == nil {
		if d, ok := decoded.(map[string]any); ok {
			parsed = d
			if et, keep := b.classifier.classify(parsed); keep {
				eventType = et
				disposition = LineRendered
				rendered = 1
			} else {
				eventType = "_ignored"
				disposition = LineIgnored
			}
		}
	}

	// The timestamp inherits from the previous stamped line, then falls
	// back to ingestion time. An empty dict carries no extractable fields,
	// so extraction is skipped outright.
	timestamp := ""
	if len(parsed) > 0 {
		if ts := b.classifier.timestamp(parsed); ts != "" {
			b.lastRealTS = ts
			timestamp = ts
		}
	}
	if timestamp == "" {
		timestamp = b.lastRealTS
	}
	if timestamp == "" {
		timestamp = b.Now()
	}

	preview := ""
	var toolName, toolID *string
	if rendered == 1 {
		preview = b.Redact(b.classifier.preview(parsed, eventType))
		toolName, toolID = b.classifier.toolInfo(parsed)
	}
	var rowUUID, parentUUID *string
	usage := Usage{}
	if len(parsed) > 0 {
		rowUUID, parentUUID = extractUUID(b.harnessName, parsed)
		usage = extractUsage(b.harnessName, parsed)
	}

	lineBytes := []byte(rawLine)
	digest := xxh3.Hash128(lineBytes)
	sum := sha256.Sum256(lineBytes)

	return Row{
		Harness:         b.harnessName,
		LineOffset:      offset,
		SourceEndOffset: endOffset,
		LineHash:        uint128Hex(digest),
		SourceSHA256:    hex.EncodeToString(sum[:]),
		IsSourceRecord:  1,
		Rendered:        rendered,
		EventType:       eventType,
		Timestamp:       timestamp,
		IngestedAt:      b.IngestedAt,
		UUID:            rowUUID,
		ParentUUID:      parentUUID,
		ToolName:        toolName,
		ToolID:          toolID,
		ContentPreview:  preview,
		ContentLength:   len(lineBytes),
		RawLine:         b.Redact(rawLine),
		Credits:         0.0,
		Usage:           usage,
	}, disposition
}

// BuildRows classifies a contiguous run of raw JSONL lines starting at
// startOffset.
func (b *Builder) BuildRows(lines []string, startOffset int) ([]Row, BuildStats) {
	rows := make([]Row, 0, len(lines))
	var stats BuildStats
	for i, rawLine := range lines {
		row, disposition := b.Build(rawLine, startOffset+i, 0)
		rows = append(rows, row)
		switch disposition {
		case LineRendered:
			stats.Ingested++
		case LineIgnored:
			stats.Skipped++
		case LineParseError:
			stats.Errors++
		}
	}
	return rows, stats
}

// uint128Hex renders an xxh3 128-bit digest as canonical big-endian hex,
// the line-hash format pinned by the golden fixtures.
func uint128Hex(d xxh3.Uint128) string {
	b := d.Bytes()
	return hex.EncodeToString(b[:])
}

// lineHash is the dedup identity of one raw source line.
func lineHash(rawLine string) string {
	return uint128Hex(xxh3.Hash128([]byte(rawLine)))
}
