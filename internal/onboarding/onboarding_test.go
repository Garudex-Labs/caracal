// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package onboarding

import "testing"

func org(slug string, projects ...projectState) orgState {
	return orgState{Slug: slug, Name: slug, Role: "member", Projects: projects}
}

func TestNextStepDerivation(t *testing.T) {
	p := projectState{Slug: "p", Name: "P"}
	cases := []struct {
		name string
		snap Snapshot
		want string
	}{
		{"incomplete profile always comes first",
			Snapshot{Profile: profileState{Completed: false},
				Organizations: []orgState{org("acme", p)}},
			StepProfile},
		{"no membership",
			Snapshot{Profile: profileState{Completed: true}},
			StepOrganization},
		{"membership without any project access",
			Snapshot{Profile: profileState{Completed: true},
				Organizations: []orgState{org("acme")}},
			StepProject},
		{"all orgs empty still blocks",
			Snapshot{Profile: profileState{Completed: true},
				Organizations: []orgState{org("acme"), org("beta")}},
			StepProject},
		{"one accessible project completes onboarding",
			Snapshot{Profile: profileState{Completed: true},
				Organizations: []orgState{org("acme"), org("beta", p)}},
			StepDone},
		{"invitations do not change the step",
			Snapshot{Profile: profileState{Completed: true},
				Invitations: []invitationState{{ID: "i1", OrgSlug: "acme"}}},
			StepOrganization},
	}
	for _, tc := range cases {
		if got := nextStep(&tc.snap); got != tc.want {
			t.Errorf("%s: nextStep = %q, want %q", tc.name, got, tc.want)
		}
	}
}
