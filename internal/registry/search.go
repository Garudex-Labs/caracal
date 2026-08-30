// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"fmt"
	"regexp"
	"strings"
)

var tokenRE = regexp.MustCompile(`[a-z0-9][a-z0-9_-]*`)

var shortAllowed = map[string]bool{"ai": true, "go": true, "js": true, "ts": true, "ui": true, "ux": true}

var stopWords = map[string]bool{
	"about": true, "agent": true, "all": true, "and": true, "any": true, "are": true,
	"component": true, "components": true, "could": true, "find": true, "for": true,
	"from": true, "good": true, "help": true, "helps": true, "install": true, "into": true,
	"make": true, "mcp": true, "me": true, "need": true, "please": true, "registry": true,
	"server": true, "skill": true, "skills": true, "setup": true, "that": true, "the": true,
	"this": true, "what": true, "when": true, "with": true, "would": true, "you": true,
}

// searchTerms tokenizes a query the way the registry search contract defines:
// lowercase tokens, trimmed edges, de-pluralized, stop-worded, deduplicated,
// with the full phrase prepended.
func searchTerms(query string) []string {
	tokens := []string{}
	seen := map[string]bool{}
	for _, token := range tokenRE.FindAllString(strings.ToLower(query), -1) {
		token = strings.Trim(token, "-_")
		if len(token) > 4 && strings.HasSuffix(token, "s") && !strings.HasSuffix(token, "ss") {
			token = token[:len(token)-1]
		}
		if len(token) < 3 && !shortAllowed[token] {
			continue
		}
		if stopWords[token] || seen[token] {
			continue
		}
		seen[token] = true
		tokens = append(tokens, token)
	}
	if len(tokens) == 0 {
		return nil
	}
	phrase := strings.Join(tokens, " ")
	terms := []string{phrase}
	for _, token := range tokens {
		if token != phrase {
			terms = append(terms, token)
		}
	}
	return terms
}

// escapeLike escapes LIKE wildcards with the Postgres default backslash.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// searchSQL renders the WHERE clause and rank expression for the given
// terms over the family's searchable fields. Arguments are appended to args
// as %term% patterns; name scores 100/12, other fields 40/4.
func searchSQL(terms []string, nameField string, fields []string, args *[]any) (where, rank string) {
	pattern := func(term string) string {
		*args = append(*args, "%"+escapeLike(term)+"%")
		return fmt.Sprintf("$%d", len(*args))
	}
	conditions := []string{}
	rankParts := []string{"0"}

	placeholders := make(map[string]string, len(terms))
	for _, term := range terms {
		if _, seen := placeholders[term]; !seen {
			placeholders[term] = pattern(term)
		}
	}
	phrase := terms[0]
	rankParts = append(rankParts, fmt.Sprintf("(CASE WHEN %s ILIKE %s THEN 100 ELSE 0 END)", nameField, placeholders[phrase]))
	for _, field := range fields {
		conditions = append(conditions, fmt.Sprintf("%s ILIKE %s", field, placeholders[phrase]))
		rankParts = append(rankParts, fmt.Sprintf("(CASE WHEN %s ILIKE %s THEN 40 ELSE 0 END)", field, placeholders[phrase]))
	}
	for _, term := range terms[1:] {
		for _, field := range fields {
			conditions = append(conditions, fmt.Sprintf("%s ILIKE %s", field, placeholders[term]))
		}
	}
	// Token scores cover every token, including a lone token equal to the phrase.
	tokens := terms[1:]
	if len(tokens) == 0 {
		tokens = terms
	}
	for _, token := range tokens {
		p := placeholders[token]
		rankParts = append(rankParts, fmt.Sprintf("(CASE WHEN %s ILIKE %s THEN 12 ELSE 0 END)", nameField, p))
		for _, field := range fields {
			rankParts = append(rankParts, fmt.Sprintf("(CASE WHEN %s ILIKE %s THEN 4 ELSE 0 END)", field, p))
		}
	}
	return "(" + strings.Join(conditions, " OR ") + ")", strings.Join(rankParts, " + ")
}
