// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Idempotent reconcilers that converge applications, providers, resources, and policy sets to a desired state.

package admin

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

const (
	// GrantPolicyName is the default policy EnsureGrants converges.
	GrantPolicyName = "application-grants"
	// GrantPolicySetName is the default policy set EnsureGrants activates.
	GrantPolicySetName = "application-grant-policy"
)

func sameStringSet(live, desired []string) bool {
	have := make(map[string]struct{}, len(live))
	for _, value := range live {
		have[value] = struct{}{}
	}
	if len(have) != len(desired) {
		return false
	}
	for _, value := range desired {
		if _, ok := have[value]; !ok {
			return false
		}
	}
	return true
}

// ApplicationEnsure is the desired state for EnsureApplication.
type ApplicationEnsure struct {
	Name         string
	Traits       []string
	ClientSecret string
}

// EnsureApplication converges a managed application to exactly the given
// trait set and seals the given client secret, creating it when absent. The
// secret patch on every run is the rotation itself: the previous secret stops
// working the moment the new one is sealed, which is also how a compromised
// credential is revoked. An existing same-named identity must be a usable
// managed credential; a DCR or app-expiring application cannot carry a
// rotating secret, so binding to it would report the identity configured
// while every token mint failed. Fails closed instead, so the
// misconfiguration surfaces rather than hiding. Returns the application id.
func EnsureApplication(ctx context.Context, client *AdminClient, zoneID string, input ApplicationEnsure) (string, error) {
	apps, err := client.Applications.List(ctx, zoneID)
	if err != nil {
		return "", err
	}
	var existing *Application
	for index := range apps {
		if apps[index].Name == input.Name {
			existing = &apps[index]
			break
		}
	}
	if existing == nil {
		created, err := client.Applications.Create(ctx, zoneID, map[string]any{
			"name":                input.Name,
			"registration_method": "managed",
			"traits":              input.Traits,
		})
		if err != nil {
			return "", err
		}
		if _, err := client.Applications.Patch(ctx, zoneID, created.ID, map[string]any{"client_secret": input.ClientSecret}); err != nil {
			return "", err
		}
		return created.ID, nil
	}
	if existing.RegistrationMethod != "managed" || existing.ExpiresAt != nil {
		return "", fmt.Errorf("application %s exists but is not a usable managed credential", input.Name)
	}
	if !sameStringSet(existing.Traits, input.Traits) {
		if _, err := client.Applications.Patch(ctx, zoneID, existing.ID, map[string]any{"traits": input.Traits}); err != nil {
			return "", err
		}
	}
	if _, err := client.Applications.Patch(ctx, zoneID, existing.ID, map[string]any{"client_secret": input.ClientSecret}); err != nil {
		return "", err
	}
	return existing.ID, nil
}

// APIKeyProviderEnsure is the desired state for EnsureAPIKeyProvider. An
// empty APIKey means no key was supplied.
type APIKeyProviderEnsure struct {
	Name         string
	Identifier   string
	PublicConfig map[string]any
	APIKey       string
}

// EnsureAPIKeyProvider seals an api key into an api_key provider the gateway
// injects at call time, so the caller never holds the key. When a key is
// supplied it is reconciled together with the public placement config (the
// sealed secret cannot be read back, so setting or rotating re-seals). When
// no key is supplied but the placement may have changed, the existing
// provider's public config is patched without resupplying the key, so an edit
// applies and the sealed secret is preserved. A missing provider with no key
// returns an empty id, marking the credential unconfigured so no resource
// binds a dead credential.
func EnsureAPIKeyProvider(ctx context.Context, client *AdminClient, zoneID string, input APIKeyProviderEnsure) (string, error) {
	providers, err := client.Providers.List(ctx, zoneID)
	if err != nil {
		return "", err
	}
	var existing *Provider
	for index := range providers {
		if providers[index].Identifier == input.Identifier {
			existing = &providers[index]
			break
		}
	}
	if input.APIKey == "" {
		if existing == nil {
			return "", nil
		}
		if _, err := client.Providers.Patch(ctx, zoneID, existing.ID, map[string]any{"config_json": input.PublicConfig}); err != nil {
			return "", err
		}
		return existing.ID, nil
	}
	config := make(map[string]any, len(input.PublicConfig)+1)
	for key, value := range input.PublicConfig {
		config[key] = value
	}
	config["api_key"] = input.APIKey
	if existing == nil {
		created, err := client.Providers.Create(ctx, zoneID, map[string]any{
			"name":        input.Name,
			"identifier":  input.Identifier,
			"kind":        "api_key",
			"config_json": config,
		})
		if err != nil {
			return "", err
		}
		return created.ID, nil
	}
	if _, err := client.Providers.Patch(ctx, zoneID, existing.ID, map[string]any{"kind": "api_key", "config_json": config}); err != nil {
		return "", err
	}
	return existing.ID, nil
}

// ResourceEnsure is the desired state for EnsureResource. Nil pointer and
// slice fields are not managed: they are excluded from both the drift
// comparison and the patch.
type ResourceEnsure struct {
	Name                 string
	Identifier           string
	Scopes               []string
	UpstreamURL          *string
	CredentialProviderID *string
	OperationEnforcement *string
}

// EnsureResource converges a resource to the given desired fields, creating
// it when absent and patching it only on drift so a steady state never bumps
// caches keyed on the resource row. Unmanaged fields are never clobbered, so
// a reconciler that owns only some fields leaves the rest alone. Declared
// scopes are the resource's business vocabulary; the platform-reserved
// agent:lifecycle bootstrap scope is derived by STS for gateway-routed
// resources and never stored on the row. Returns the live resource.
func EnsureResource(ctx context.Context, client *AdminClient, zoneID string, input ResourceEnsure) (*Resource, error) {
	desired := map[string]any{"scopes": input.Scopes}
	managed := map[string]*string{
		"upstream_url":           input.UpstreamURL,
		"credential_provider_id": input.CredentialProviderID,
		"operation_enforcement":  input.OperationEnforcement,
	}
	for key, value := range managed {
		if value != nil {
			desired[key] = *value
		}
	}
	resources, err := client.Resources.List(ctx, zoneID)
	if err != nil {
		return nil, err
	}
	var existing *Resource
	for index := range resources {
		if resources[index].Identifier == input.Identifier {
			existing = &resources[index]
			break
		}
	}
	if existing == nil {
		body := map[string]any{"name": input.Name, "identifier": input.Identifier}
		for key, value := range desired {
			body[key] = value
		}
		return client.Resources.Create(ctx, zoneID, body)
	}
	live := map[string]*string{
		"upstream_url":           existing.UpstreamURL,
		"credential_provider_id": existing.CredentialProviderID,
		"operation_enforcement":  existing.OperationEnforcement,
	}
	drifted := !sameStringSet(existing.Scopes, input.Scopes)
	for key, value := range managed {
		if value == nil {
			continue
		}
		if live[key] == nil || *live[key] != *value {
			drifted = true
		}
	}
	if !drifted {
		return existing, nil
	}
	return client.Resources.Patch(ctx, zoneID, existing.ID, desired)
}

// ActivePolicySetEnsure is the desired state for EnsureActivePolicySet.
// SkipCreate suppresses materializing anything when no policy with PolicyName
// exists yet.
type ActivePolicySetEnsure struct {
	PolicyName string
	SetName    string
	Content    string
	SkipCreate bool
}

// EnsureActivePolicySet converges one named policy and policy set to carry
// exactly the given content, active. Policy versions are immutable, so a new
// version is added only when the content's digest changes; the set is
// re-activated only when the content changed or no version is active, which
// self-heals a deactivated set without churning a steady state.
func EnsureActivePolicySet(ctx context.Context, client *AdminClient, zoneID string, input ActivePolicySetEnsure) error {
	policies, err := client.Policies.List(ctx, zoneID)
	if err != nil {
		return err
	}
	var policy *Policy
	for index := range policies {
		if policies[index].Name == input.PolicyName {
			policy = &policies[index]
			break
		}
	}
	if policy == nil && input.SkipCreate {
		return nil
	}
	digest := sha256.Sum256([]byte(input.Content))
	desiredSHA := hex.EncodeToString(digest[:])
	var policyVersionID string
	policyChanged := false
	if policy == nil {
		created, err := client.Policies.Create(ctx, zoneID, map[string]any{"name": input.PolicyName, "content": input.Content})
		if err != nil {
			return err
		}
		policyVersionID = created.VersionID
		policyChanged = true
	} else {
		detail, err := client.Policies.Get(ctx, zoneID, policy.ID)
		if err != nil {
			return err
		}
		if len(detail.Versions) == 0 {
			return fmt.Errorf("policy %s has no versions", input.PolicyName)
		}
		latest := detail.Versions[0]
		for _, version := range detail.Versions[1:] {
			if version.Version > latest.Version {
				latest = version
			}
		}
		if latest.ContentSHA256 == desiredSHA {
			policyVersionID = latest.ID
		} else {
			added, err := client.Policies.AddVersion(ctx, zoneID, policy.ID, input.Content, "")
			if err != nil {
				return err
			}
			policyVersionID = added.VersionID
			policyChanged = true
		}
	}
	sets, err := client.PolicySets.List(ctx, zoneID)
	if err != nil {
		return err
	}
	var policySet *PolicySet
	for index := range sets {
		if sets[index].Name == input.SetName {
			policySet = &sets[index]
			break
		}
	}
	if policySet == nil {
		created, err := client.PolicySets.Create(ctx, zoneID, input.SetName, "")
		if err != nil {
			return err
		}
		policySet = created
	}
	if policyChanged || policySet.ActiveVersionID == nil || *policySet.ActiveVersionID == "" {
		version, err := client.PolicySets.AddVersion(ctx, zoneID, policySet.ID, []map[string]any{{"policy_version_id": policyVersionID}}, "")
		if err != nil {
			return err
		}
		if _, err := client.PolicySets.Activate(ctx, zoneID, policySet.ID, version.VersionID, ""); err != nil {
			return err
		}
	}
	return nil
}

// ResourceGrant is one data-plane grant: the application may mint the given
// scopes on the resource. Role is the agent label the zone's decision
// contract matches at mint and use time; empty defaults to the application
// id, the same default label the SDK's governed transport spawns with, so a
// grant and its transport align without either naming a role. The first grant
// for a resource names its owning application - the identity whose governed
// transport may bootstrap on it; later grants for the same resource add roles
// only.
type ResourceGrant struct {
	ApplicationID      string
	ResourceIdentifier string
	Scopes             []string
	Role               string
}

// AuthorGrantsDocument authors the zone's grant data document: the platform
// decision contract reads app_ids and grants to authorize data-plane
// exchanges, and this renders them so no caller ever touches the document
// format. Deterministic - roles, resources, and scopes are sorted and
// rendered as canonical JSON - so an unchanged grant set produces an
// identical document and the reconciler adds no new policy version.
func AuthorGrantsDocument(grants []ResourceGrant) (string, error) {
	appIDs := map[string]string{}
	type resourceEntry struct {
		application string
		roles       map[string]map[string]struct{}
	}
	byResource := map[string]*resourceEntry{}
	for _, grant := range grants {
		role := grant.Role
		if role == "" {
			role = grant.ApplicationID
		}
		if owner, ok := appIDs[role]; ok && owner != grant.ApplicationID {
			return "", fmt.Errorf("grant role '%s' is claimed by two applications", role)
		}
		appIDs[role] = grant.ApplicationID
		entry, ok := byResource[grant.ResourceIdentifier]
		if !ok {
			entry = &resourceEntry{application: role, roles: map[string]map[string]struct{}{}}
			byResource[grant.ResourceIdentifier] = entry
		}
		scopes, ok := entry.roles[role]
		if !ok {
			scopes = map[string]struct{}{}
			entry.roles[role] = scopes
		}
		for _, scope := range grant.Scopes {
			scopes[scope] = struct{}{}
		}
	}
	grantsDoc := map[string]any{}
	for identifier, entry := range byResource {
		roles := map[string]any{}
		for role, scopeSet := range entry.roles {
			scopes := make([]string, 0, len(scopeSet))
			for scope := range scopeSet {
				scopes = append(scopes, scope)
			}
			sort.Strings(scopes)
			roles[role] = scopes
		}
		grantsDoc[identifier] = map[string]any{"application": entry.application, "roles": roles}
	}
	appIDsJSON, err := canonicalJSON(appIDs)
	if err != nil {
		return "", err
	}
	grantsJSON, err := canonicalJSON(grantsDoc)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{
		"# caracal:data-document",
		"package caracal.authz",
		"import rego.v1",
		"app_ids := " + appIDsJSON,
		"grants := " + grantsJSON,
		"",
	}, "\n"), nil
}

func canonicalJSON(value any) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buffer.String(), "\n"), nil
}

// GrantsEnsure is the desired state for EnsureGrants. Empty PolicyName and
// SetName default to GrantPolicyName and GrantPolicySetName.
type GrantsEnsure struct {
	Grants     []ResourceGrant
	PolicyName string
	SetName    string
}

// EnsureGrants converges the zone's grant policy so each application may mint
// exactly the given scopes on its resources. This owns the decision-contract
// data-document format end to end: pair it with EnsureResource and a governed
// transport and an application's authority is fully declared without
// authoring policy text. With an empty grant set and no existing policy it
// creates nothing; with an existing policy it converges the document to the
// (possibly empty) set, revoking what is no longer granted.
func EnsureGrants(ctx context.Context, client *AdminClient, zoneID string, input GrantsEnsure) error {
	policyName := input.PolicyName
	if policyName == "" {
		policyName = GrantPolicyName
	}
	setName := input.SetName
	if setName == "" {
		setName = GrantPolicySetName
	}
	content, err := AuthorGrantsDocument(input.Grants)
	if err != nil {
		return err
	}
	return EnsureActivePolicySet(ctx, client, zoneID, ActivePolicySetEnsure{
		PolicyName: policyName,
		SetName:    setName,
		Content:    content,
		SkipCreate: len(input.Grants) == 0,
	})
}

// GovernedUpstreamGrant is one application granted to mint scopes on a
// governed upstream's resource. Role semantics match ResourceGrant.
type GovernedUpstreamGrant struct {
	ApplicationID string
	Scopes        []string
	Role          string
}

// GovernedUpstreamResource is the gateway-routed resource fields of a
// governed upstream. The credential provider binding is threaded by the
// reconciler, and an empty OperationEnforcement is left unmanaged.
type GovernedUpstreamResource struct {
	Name                 string
	Identifier           string
	Scopes               []string
	UpstreamURL          string
	OperationEnforcement string
}

// GovernedUpstream is one upstream in a governed set: the sealed credential
// the gateway injects, the gateway-routed resource that proxies it, and the
// applications granted to mint on it. The first grant names the resource's
// owning application - the identity whose governed transport may bootstrap
// on it.
type GovernedUpstream struct {
	Provider APIKeyProviderEnsure
	Resource GovernedUpstreamResource
	Grants   []GovernedUpstreamGrant
}

// GovernedUpstreamsEnsure is the desired state for EnsureGovernedUpstreams.
// Empty PolicyName and SetName default to GrantPolicyName and
// GrantPolicySetName.
type GovernedUpstreamsEnsure struct {
	Upstreams  []GovernedUpstream
	PolicyName string
	SetName    string
}

// GovernedUpstreamResult is the converged state of one governed upstream.
type GovernedUpstreamResult struct {
	ProviderID string
	Resource   *Resource
}

// EnsureGovernedUpstreams converges a set of governed upstreams - sealed
// credential provider, gateway-routed resource, and the zone's grant document
// - in dependency order, so one call declares everything the platform needs
// to govern the set. Rego permits one definition of the grant document per
// zone, so the set converges as a whole: an upstream absent from it loses its
// grants on the next run, which is the revocation. Every step is idempotent,
// so a partial failure converges on rerun, and grants land last so nothing is
// authorized before its resource exists. An upstream whose provider resolves
// to no sealed key fails closed before any resource binds a dead credential.
func EnsureGovernedUpstreams(ctx context.Context, client *AdminClient, zoneID string, input GovernedUpstreamsEnsure) ([]GovernedUpstreamResult, error) {
	results := make([]GovernedUpstreamResult, 0, len(input.Upstreams))
	grants := make([]ResourceGrant, 0)
	for _, upstream := range input.Upstreams {
		providerID, err := EnsureAPIKeyProvider(ctx, client, zoneID, upstream.Provider)
		if err != nil {
			return nil, err
		}
		if providerID == "" {
			return nil, fmt.Errorf("provider %s has no sealed api key: supply APIKey before governing %s", upstream.Provider.Identifier, upstream.Resource.Identifier)
		}
		resourceInput := ResourceEnsure{
			Name:                 upstream.Resource.Name,
			Identifier:           upstream.Resource.Identifier,
			Scopes:               upstream.Resource.Scopes,
			UpstreamURL:          &upstream.Resource.UpstreamURL,
			CredentialProviderID: &providerID,
		}
		if upstream.Resource.OperationEnforcement != "" {
			resourceInput.OperationEnforcement = &upstream.Resource.OperationEnforcement
		}
		resource, err := EnsureResource(ctx, client, zoneID, resourceInput)
		if err != nil {
			return nil, err
		}
		results = append(results, GovernedUpstreamResult{ProviderID: providerID, Resource: resource})
		for _, grant := range upstream.Grants {
			grants = append(grants, ResourceGrant{
				ApplicationID:      grant.ApplicationID,
				ResourceIdentifier: upstream.Resource.Identifier,
				Scopes:             grant.Scopes,
				Role:               grant.Role,
			})
		}
	}
	if err := EnsureGrants(ctx, client, zoneID, GrantsEnsure{Grants: grants, PolicyName: input.PolicyName, SetName: input.SetName}); err != nil {
		return nil, err
	}
	return results, nil
}
