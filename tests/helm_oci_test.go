// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package contracts

import (
	"strings"
	"testing"
)

const helmOCIRef = "oci://ghcr.io/garudex-labs/charts/caracal"

func mustContain(t *testing.T, haystack, needle, where string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("%s must contain %q", where, needle)
	}
}

func mustNotContain(t *testing.T, haystack, needle, where string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Fatalf("%s must not contain %q", where, needle)
	}
}

// sliceBetween returns the text after the first occurrence of start up to
// the next occurrence of end, mirroring sequential split-once semantics.
func sliceBetween(t *testing.T, text, start, end, where string) string {
	t.Helper()
	i := strings.Index(text, start)
	if i < 0 {
		t.Fatalf("%s: marker %q not found", where, start)
	}
	rest := text[i+len(start):]
	j := strings.Index(rest, end)
	if j < 0 {
		t.Fatalf("%s: marker %q not found after %q", where, end, start)
	}
	return rest[:j]
}

func TestReleaseWorkflowPublishesHelmChartToGHCROCI(t *testing.T) {
	workflow := loadYAML(t, ".github/workflows/release.yml")
	jobs := asMap(t, workflow["jobs"], "jobs")
	job := asMap(t, jobs["helm-chart"], "jobs.helm-chart")

	permissions := asMap(t, job["permissions"], "helm-chart permissions")
	if len(permissions) != 2 || permissions["contents"] != "read" || permissions["packages"] != "write" {
		t.Fatalf("helm-chart permissions must be {contents: read, packages: write}, got %v", permissions)
	}

	var needs []string
	switch v := job["needs"].(type) {
	case string:
		needs = []string{v}
	case []any:
		for _, n := range v {
			needs = append(needs, n.(string))
		}
	default:
		t.Fatalf("helm-chart needs is %T, expected string or sequence", v)
	}
	found := false
	for _, n := range needs {
		if n == "approve" {
			found = true
		}
	}
	if !found {
		t.Fatalf("helm-chart needs must include %q, got %v", "approve", needs)
	}

	var runs []string
	for _, step := range asList(t, job["steps"], "helm-chart steps") {
		if run, ok := asMap(t, step, "helm-chart step")["run"].(string); ok {
			runs = append(runs, run)
		}
	}
	stepRuns := strings.Join(runs, "\n")

	for _, needle := range []string{
		`HELM_OCI_REPO="oci://ghcr.io/garudex-labs/charts"`,
		`HELM_OCI_REF="ghcr.io/garudex-labs/charts/caracal"`,
		"helm registry login ghcr.io",
		"oras login ghcr.io",
		`helm push "chart-dist/caracal-${VERSION}.tgz" "$HELM_OCI_REPO"`,
		`"${HELM_OCI_REF}:artifacthub.io"`,
		"application/vnd.cncf.artifacthub.repository-metadata.layer.v1.yaml",
	} {
		mustContain(t, stepRuns, needle, "helm-chart step runs")
	}
}

func TestReleaseWorkflowDoesNotPublishHelmChartToGitHubPages(t *testing.T) {
	workflow := readRepoFile(t, ".github/workflows/release.yml")
	helmJob := sliceBetween(t, workflow, "  helm-chart:", "  release:", "release.yml helm-chart job")

	mustNotContain(t, helmJob, "gh-pages", "helm-chart job")
	mustNotContain(t, helmJob, "helm repo index", "helm-chart job")
	mustNotContain(t, helmJob, "caracal.github.io", "helm-chart job")
}

func TestChartHasArtifactHubMetadataForOCIListing(t *testing.T) {
	chart := loadYAML(t, "infra/helm/caracal/Chart.yaml")

	if chart["icon"] != "https://raw.githubusercontent.com/Garudex-Labs/caracal/main/docs/logo.svg" {
		t.Fatalf("unexpected chart icon: %v", chart["icon"])
	}
	maintainers := asList(t, chart["maintainers"], "chart maintainers")
	if len(maintainers) == 0 {
		t.Fatalf("chart maintainers must not be empty")
	}
	if email := asMap(t, maintainers[0], "chart maintainer")["email"]; email != "support@caracal.run" {
		t.Fatalf("unexpected maintainer email: %v", email)
	}
	annotations := asMap(t, chart["annotations"], "chart annotations")
	if annotations["artifacthub.io/category"] != "monitoring-logging" {
		t.Fatalf("unexpected artifacthub.io/category: %v", annotations["artifacthub.io/category"])
	}
	if annotations["artifacthub.io/license"] != "Apache-2.0" {
		t.Fatalf("unexpected artifacthub.io/license: %v", annotations["artifacthub.io/license"])
	}
	links, ok := annotations["artifacthub.io/links"].(string)
	if !ok || !strings.Contains(links, "Documentation") {
		t.Fatalf("artifacthub.io/links must mention Documentation, got %v", annotations["artifacthub.io/links"])
	}
}

func TestArtifactHubRepoMetadata(t *testing.T) {
	metadata := loadYAML(t, "infra/helm/artifacthub-repo.yml")

	owners := asList(t, metadata["owners"], "artifacthub owners")
	if len(owners) != 1 {
		t.Fatalf("expected exactly one artifacthub owner, got %d", len(owners))
	}
	owner := asMap(t, owners[0], "artifacthub owner")
	if len(owner) != 2 || owner["name"] != "Garudex Labs" || owner["email"] != "support@caracal.run" {
		t.Fatalf(`artifacthub owner must be {name: "Garudex Labs", email: "support@caracal.run"}, got %v`, owner)
	}
	if metadata["repositoryID"] != "bcccc095-d7e6-4ae3-b40c-b5c2b6fb2f80" {
		t.Fatalf("unexpected repositoryID: %v", metadata["repositoryID"])
	}
}

func TestAppWorkloadImageTagsDefaultToChartAppVersion(t *testing.T) {
	values := loadYAML(t, "infra/helm/caracal/values.yaml")
	for _, workload := range []string{"api", "web", "auth"} {
		image := asMap(t, asMap(t, values[workload], workload)["image"], workload+".image")
		if image["tag"] != "" {
			t.Fatalf("%s.image.tag must default to \"\", got %v", workload, image["tag"])
		}
	}

	helpers := readRepoFile(t, "infra/helm/caracal/templates/_helpers.tpl")
	mustContain(t, helpers, `$tag := .image.tag | default (.appVersion | default "latest")`, "_helpers.tpl")

	for _, templatePath := range []string{
		"infra/helm/caracal/templates/api-deployment.yaml",
		"infra/helm/caracal/templates/init-job.yaml",
		"infra/helm/caracal/templates/web-deployment.yaml",
		"infra/helm/caracal/templates/auth-deployment.yaml",
	} {
		mustContain(t, readRepoFile(t, templatePath), `"appVersion" .Chart.AppVersion`, templatePath)
	}
}

func TestCIAssertsPackagedChartUsesAppVersionImageTags(t *testing.T) {
	workflow := readRepoFile(t, ".github/workflows/ci.yml")

	for _, needle := range []string{
		"helm package infra/helm/caracal",
		`--app-version "$VERSION"`,
		`helm template caracal "chart-dist/caracal-${VERSION}.tgz"`,
		`SERVER_IMAGE_COUNT="$(grep -c "image: ghcr.io/garudex-labs/caracal-server:${VERSION}"`,
		`test "$SERVER_IMAGE_COUNT" -ge 2`,
		`grep -q "image: ghcr.io/garudex-labs/caracal-web:${VERSION}"`,
		"--set api.image.tag=custom-api",
		"--set web.image.tag=custom-web",
		`grep -q "image: ghcr.io/garudex-labs/caracal-server:custom-api"`,
		`grep -q "image: ghcr.io/garudex-labs/caracal-web:custom-web"`,
	} {
		mustContain(t, workflow, needle, "ci.yml")
	}
}

func TestHelmDocsUseOCIInstallInsteadOfRepoAdd(t *testing.T) {
	for _, rel := range []string{
		"docs/self-hosting/kubernetes-helm.md",
		"infra/helm/caracal/README.md",
	} {
		text := readRepoFile(t, rel)
		mustContain(t, text, helmOCIRef, rel)
		mustNotContain(t, text, "helm repo add caracal", rel)
		mustNotContain(t, text, "caracal.github.io", rel)
	}
}
