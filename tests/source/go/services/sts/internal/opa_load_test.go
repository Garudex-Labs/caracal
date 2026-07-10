// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// OPA zone bundle loading tests: manifest resolution, compilation, and seeding.

package internal

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// policyDB serves scripted policy bindings and versions on top of the shared stub.
type policyDB struct {
	stubDB
	binding     *PolicySetBinding
	bindingErr  error
	version     *PolicySetVersion
	versionErr  error
	policies    []PolicyVersion
	policiesErr error
	boundZones  []string
	boundErr    error
}

func (d *policyDB) GetActivePolicySetBinding(_ context.Context, _ string) (*PolicySetBinding, error) {
	return d.binding, d.bindingErr
}

func (d *policyDB) GetPolicySetVersion(_ context.Context, _ string) (*PolicySetVersion, error) {
	return d.version, d.versionErr
}

func (d *policyDB) GetPolicyVersionsByIDs(_ context.Context, _ []string) ([]PolicyVersion, error) {
	return d.policies, d.policiesErr
}

func (d *policyDB) ListBoundZoneIDs(_ context.Context) ([]string, error) {
	return d.boundZones, d.boundErr
}

func boundPolicyDB(policies []PolicyVersion) *policyDB {
	versionID := "psv-1"
	manifest := make([]map[string]string, len(policies))
	for i, p := range policies {
		manifest[i] = map[string]string{"policy_version_id": p.ID}
	}
	manifestJSON, _ := json.Marshal(manifest)
	manifestSHA := fmt.Sprintf("%x", sha256.Sum256(manifestJSON))
	return &policyDB{
		binding:  &PolicySetBinding{ZoneID: "zone-1", PolicySetID: "ps-1", ActiveVersionID: &versionID},
		version:  &PolicySetVersion{ID: versionID, ManifestJSON: manifestJSON, ManifestSHA256: manifestSHA},
		policies: policies,
	}
}

func TestLoadZoneCompilesActiveBundle(t *testing.T) {
	db := boundPolicyDB([]PolicyVersion{{ID: "pv-grants", Content: grantsData}})
	engine := newOPAEngine(db, zerolog.Nop())

	if err := engine.loadZone(context.Background(), "zone-1"); err != nil {
		t.Fatalf("loadZone: %v", err)
	}
	info := engine.BundleInfo("zone-1")
	if info.PolicySetVersionID != "psv-1" || info.ManifestSHA != db.version.ManifestSHA256 {
		t.Fatalf("bundle info = %+v", info)
	}
	if engine.metrics.CompileTotal.Load() != 1 {
		t.Fatalf("compiles = %d", engine.metrics.CompileTotal.Load())
	}

	if err := engine.loadZone(context.Background(), "zone-1"); err != nil {
		t.Fatalf("reload with same manifest: %v", err)
	}
	if engine.metrics.CompileTotal.Load() != 1 {
		t.Fatal("identical manifest SHA must not recompile")
	}
}

func TestLoadZoneRejectsBadBundles(t *testing.T) {
	t.Run("nil active version installs fallback", func(t *testing.T) {
		engine := newOPAEngine(&policyDB{binding: &PolicySetBinding{ZoneID: "zone-1"}}, zerolog.Nop())
		if err := engine.loadZone(context.Background(), "zone-1"); err != nil {
			t.Fatalf("unbound zone must fall back silently: %v", err)
		}
		if engine.BundleInfo("zone-1").LoadedAt.IsZero() {
			t.Fatal("fallback bundle must be installed")
		}
	})

	t.Run("malformed manifest", func(t *testing.T) {
		db := boundPolicyDB(nil)
		db.version.ManifestJSON = json.RawMessage(`{not json`)
		engine := newOPAEngine(db, zerolog.Nop())
		if err := engine.loadZone(context.Background(), "zone-1"); err == nil {
			t.Fatal("malformed manifest must fail")
		}
	})

	t.Run("incomplete bundle", func(t *testing.T) {
		db := boundPolicyDB([]PolicyVersion{{ID: "pv-grants", Content: grantsData}})
		db.policies = nil
		engine := newOPAEngine(db, zerolog.Nop())
		err := engine.loadZone(context.Background(), "zone-1")
		if err == nil || !strings.Contains(err.Error(), "incomplete") {
			t.Fatalf("missing policy versions must fail, got %v", err)
		}
	})

	t.Run("policy defining result is rejected", func(t *testing.T) {
		content := "package caracal.authz\n\nimport rego.v1\n\nresult := {\"decision\": \"allow\"}\n"
		db := boundPolicyDB([]PolicyVersion{{ID: "pv-rogue", Content: content}})
		engine := newOPAEngine(db, zerolog.Nop())
		err := engine.loadZone(context.Background(), "zone-1")
		if err == nil || !strings.Contains(err.Error(), "defines result") {
			t.Fatalf("adopter result definition must be rejected, got %v", err)
		}
		if engine.BundleInfo("zone-1").LoadedAt.IsZero() {
			t.Fatal("rejection must leave a deny-all fallback installed")
		}
	})

	t.Run("compile failure counts", func(t *testing.T) {
		db := boundPolicyDB([]PolicyVersion{{ID: "pv-broken", Content: "package caracal.authz\n\ngrants := data.oops["}})
		engine := newOPAEngine(db, zerolog.Nop())
		if err := engine.loadZone(context.Background(), "zone-1"); err == nil {
			t.Fatal("unparsable policy must fail")
		}
	})

	t.Run("manifest hash mismatch", func(t *testing.T) {
		db := boundPolicyDB([]PolicyVersion{{ID: "pv-grants", Content: grantsData}})
		db.version.ManifestSHA256 = strings.Repeat("0", 64)
		engine := newOPAEngine(db, zerolog.Nop())
		err := engine.loadZone(context.Background(), "zone-1")
		if err == nil || !strings.Contains(err.Error(), "hash mismatch") {
			t.Fatalf("tampered manifest hash must fail, got %v", err)
		}
	})
}

func TestLoadZoneKeepsCachedBundleOnTransientVersionError(t *testing.T) {
	db := boundPolicyDB([]PolicyVersion{{ID: "pv-grants", Content: grantsData}})
	engine := newOPAEngine(db, zerolog.Nop())
	if err := engine.loadZone(context.Background(), "zone-1"); err != nil {
		t.Fatal(err)
	}

	db.versionErr = errors.New("pg down")
	if err := engine.loadZone(context.Background(), "zone-1"); err != nil {
		t.Fatalf("cached bundle must absorb transient version errors: %v", err)
	}
	if engine.BundleInfo("zone-1").ManifestSHA != db.version.ManifestSHA256 {
		t.Fatal("cached bundle must survive the flap")
	}

	fresh := newOPAEngine(&policyDB{versionErr: errors.New("pg down"), binding: db.binding}, zerolog.Nop())
	if err := fresh.loadZone(context.Background(), "zone-1"); err == nil {
		t.Fatal("uncached zone must surface the version error")
	}
}

func TestSeedZonesLoadsEveryBoundZone(t *testing.T) {
	db := boundPolicyDB([]PolicyVersion{{ID: "pv-grants", Content: grantsData}})
	db.boundZones = []string{"zone-1", "zone-2"}
	engine := newOPAEngine(db, zerolog.Nop())

	engine.SeedZones(context.Background())

	if engine.BundleInfo("zone-1").ManifestSHA != db.version.ManifestSHA256 || engine.BundleInfo("zone-2").ManifestSHA != db.version.ManifestSHA256 {
		t.Fatal("seeding must compile every bound zone")
	}

	nilEngine := newOPAEngine(nil)
	nilEngine.SeedZones(context.Background())

	failing := newOPAEngine(&policyDB{boundErr: errors.New("pg down")}, zerolog.Nop())
	failing.SeedZones(context.Background())
}
