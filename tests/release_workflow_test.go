// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"strings"
	"testing"
)

// sliceFrom returns the text between the two markers, keeping the start
// marker itself (Python slice-by-index semantics).
func sliceFrom(t *testing.T, text, start, end, where string) string {
	t.Helper()
	i := strings.Index(text, start)
	if i < 0 {
		t.Fatalf("%s: marker %q not found", where, start)
	}
	j := strings.Index(text, end)
	if j < 0 {
		t.Fatalf("%s: marker %q not found", where, end)
	}
	if j < i {
		t.Fatalf("%s: marker %q appears before %q", where, end, start)
	}
	return text[i:j]
}

func TestReleaseWorkflowSignsAndVerifiesTagsBeforePush(t *testing.T) {
	workflow := readRepoFile(t, ".github/workflows/release.yml")
	tagJob := sliceFrom(t, workflow, "  tag:\n", "  npm:\n", "release.yml tag job")
	installGitsign := sliceFrom(t, tagJob,
		"      - name: Install gitsign 0.17.1",
		"      - name: Create or verify tag",
		"tag job install-gitsign step")
	verifyTag := sliceFrom(t, tagJob,
		"          verify_tag() {",
		"          if git rev-parse",
		"tag job verify_tag function")

	for _, needle := range []string{
		"id-token: write",
		"chainguard-dev/actions/setup-gitsign@9d631658f55713e5f63ca0cc21ee168f81301fd9",
		`GITSIGN_ENABLE_SIGSTORE_GO: "true"`,
		`GITSIGN_REKOR_MODE: "online"`,
		`GITSIGN_REKOR_VERSION: "1"`,
		"git tag -s",
		"certificate-oidc-issuer",
		"predates signed-tag enforcement",
		"git merge-base --is-ancestor",
	} {
		mustContain(t, tagJob, needle, "tag job")
	}

	for _, needle := range []string{
		`GITSIGN_VERSION: "0.17.1"`,
		"69213a8a0813a151e5a47d0060862952ff833a845d57309dff76f7ba6600abae",
		"sha256sum -c",
		"gitsign version",
	} {
		mustContain(t, installGitsign, needle, "install-gitsign step")
	}

	for _, needle := range []string{
		"gitsign verify-tag",
		"for attempt in {1..5}",
		`"$attempt" -eq 5`,
		"sleep 15",
	} {
		mustContain(t, verifyTag, needle, "verify_tag function")
	}

	if strings.Index(tagJob, "gitsign verify-tag") >= strings.Index(tagJob, "git push origin") {
		t.Fatalf("tag job must verify the signed tag before pushing it")
	}
}

func TestServerReleasePackageContainsNoGeneratedSecretsOrTLSOverlay(t *testing.T) {
	workflow := readRepoFile(t, ".github/workflows/release.yml")
	packageJob := sliceFrom(t, workflow, "  server-package:\n", "  approve:\n", "release.yml server-package job")

	mustContain(t, packageJob, "docker-compose.observability.yml", "server-package job")
	mustNotContain(t, packageJob, "docker-compose.tls.yml", "server-package job")
	mustNotContain(t, packageJob, `"$STAGING/secrets"`, "server-package job")
}
