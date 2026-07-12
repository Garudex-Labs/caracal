// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Embedded platform decision contract: the signed, versioned authorization brain injected into every bundle.

package internal

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"

	"github.com/open-policy-agent/opa/ast"
)

// DecisionContractVersion identifies the platform decision contract shipped in this
// build. It is stamped into audit metadata and surfaced on the metrics snapshot so
// every decision names the exact authorization brain that produced it.
const DecisionContractVersion = "2026-07-12"

// decisionContractModuleID is the module name the embedded contract compiles under.
// It is namespaced so it can never collide with an adopter policy version id.
const decisionContractModuleID = "caracal.platform.decision_contract"

//go:embed decision_contract.rego
var decisionContractSource string

// decisionContractSHA256 is the hex SHA-256 of the embedded contract source, computed
// once at process start. It is the build-time provenance hash the engine verifies the
// embedded bytes against before serving decisions and records alongside each result.
var decisionContractSHA256 = func() string {
	sum := sha256.Sum256([]byte(decisionContractSource))
	return hex.EncodeToString(sum[:])
}()

// verifyDecisionContract parses and compiles the embedded contract in isolation and
// confirms it owns the decision entrypoint. STS calls this at startup and refuses to
// come up if the embedded brain is missing, tampered, or no longer default-deny, so a
// corrupted contract fails closed rather than serving an undefined decision.
func verifyDecisionContract() error {
	module, err := ast.ParseModule(decisionContractModuleID+".rego", decisionContractSource)
	if err != nil {
		return fmt.Errorf("parse embedded decision contract: %w", err)
	}
	compiler := ast.NewCompiler().WithCapabilities(safeCapabilities())
	compiler.Compile(map[string]*ast.Module{decisionContractModuleID: module})
	if compiler.Failed() {
		return fmt.Errorf("compile embedded decision contract: %v", compiler.Errors)
	}
	var hasDefaultResult, hasResult bool
	for _, rule := range module.Rules {
		if !ruleHeadNamed(rule, "result") {
			continue
		}
		hasResult = true
		if rule.Default {
			hasDefaultResult = true
		}
	}
	if !hasDefaultResult {
		return fmt.Errorf("embedded decision contract must declare a default result rule")
	}
	if !hasResult {
		return fmt.Errorf("embedded decision contract must define the result decision")
	}
	return nil
}

// moduleDefinesResult reports whether an adopter policy module defines the result
// decision. Adopters supply data documents only; the platform owns result, so the
// engine rejects any bundle whose adopter modules define it.
func moduleDefinesResult(id, content string) (bool, error) {
	module, err := ast.ParseModule(id+".rego", content)
	if err != nil {
		return false, fmt.Errorf("parse policy module %s: %w", id, err)
	}
	for _, rule := range module.Rules {
		if ruleHeadNamed(rule, "result") {
			return true, nil
		}
	}
	return false, nil
}

var adopterDataRules = map[string]struct{}{
	"app_ids":        {},
	"grants":         {},
	"confinement":    {},
	"restrict":       {},
	"risk":           {},
	"approval_tiers": {},
}

// validateAdopterModule restricts adopter modules to the data roots consumed by
// the platform contract. Rego modules in one package merge their rules, so allowing
// any other root would let an adopter redefine a contract helper and widen authority.
func validateAdopterModule(id, content string) error {
	module, err := ast.ParseModule(id+".rego", content)
	if err != nil {
		return fmt.Errorf("parse policy module %s: %w", id, err)
	}
	for _, rule := range module.Rules {
		name := ruleHeadName(rule)
		if name == "result" {
			return fmt.Errorf("policy module %s defines result; adopters supply data documents only", id)
		}
		if _, ok := adopterDataRules[name]; !ok {
			return fmt.Errorf("policy module %s defines unsupported data rule %s", id, name)
		}
	}
	return nil
}

// ruleHeadNamed reports whether a rule's head names the given top-level document.
func ruleHeadNamed(rule *ast.Rule, name string) bool {
	return ruleHeadName(rule) == name
}

func ruleHeadName(rule *ast.Rule) string {
	if rule.Head == nil {
		return ""
	}
	if value := string(rule.Head.Name); value != "" {
		return value
	}
	ref := rule.Head.Ref()
	if len(ref) > 0 {
		if v, ok := ref[0].Value.(ast.Var); ok {
			return string(v)
		}
	}
	return ""
}
