// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sandbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestShellWords(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{`pytest -x tests/`, []string{"pytest", "-x", "tests/"}},
		{`sh -c "echo hi there"`, []string{"sh", "-c", "echo hi there"}},
		{`echo 'single quoted arg'`, []string{"echo", "single quoted arg"}},
		{`cmd --flag="a b" c\ d`, []string{"cmd", "--flag=a b", "c d"}},
		{``, nil},
		{`   `, nil},
	}
	for _, tc := range cases {
		if got := shellWords(tc.in); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("shellWords(%q) = %#v, want %#v", tc.in, got, tc.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	long := strings.Repeat("x", MaxLogBytes+10)
	got := truncate(long)
	if !strings.HasSuffix(got, "[truncated at 64KB]") {
		t.Fatalf("expected truncation suffix, got tail %q", got[len(got)-30:])
	}
	if truncate("short") != "short" {
		t.Fatal("short output must pass through")
	}
}

func TestRunRejectsUnknownRuntime(t *testing.T) {
	result := Run(RunSpec{RuntimeType: "chroot", Image: "x"})
	if result.ExitCode != 2 || !strings.Contains(result.Output, "Unsupported sandbox runtime_type") {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestMissingRuntimeExitCode(t *testing.T) {
	// firecracker is not installed in CI or dev machines.
	result := Run(RunSpec{RuntimeType: "firecracker", RuntimeConfig: map[string]any{"config_path": "/nope"}})
	if result.ExitCode != 127 || !strings.Contains(result.Output, "local-runtime-missing") {
		t.Skipf("firecracker present on this machine: %+v", result)
	}
}

func TestFirecrackerRequiresConfig(t *testing.T) {
	result := runFirecracker(RunSpec{RuntimeType: "firecracker", RuntimeConfig: map[string]any{}})
	if result.ExitCode == 127 {
		t.Skip("firecracker not installed; config validation happens after lookup")
	}
	if result.ExitCode != 2 {
		t.Fatalf("expected exit 2 for missing config, got %+v", result)
	}
}

// mcpEnvelope frames one JSON-RPC message for the stdio server.
func mcpEnvelope(msg map[string]any) string {
	body, _ := json.Marshal(msg)
	return fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(body), body)
}

func mcpDecodeAll(t *testing.T, out *bytes.Buffer) []map[string]any {
	t.Helper()
	var messages []map[string]any
	r := out.String()
	for len(r) > 0 {
		idx := strings.Index(r, "\r\n\r\n")
		if idx < 0 {
			break
		}
		header := r[:idx]
		var length int
		_, _ = fmt.Sscanf(strings.ToLower(header), "content-length: %d", &length)
		body := r[idx+4 : idx+4+length]
		var msg map[string]any
		if err := json.Unmarshal([]byte(body), &msg); err != nil {
			t.Fatalf("bad frame: %v", err)
		}
		messages = append(messages, msg)
		r = r[idx+4+length:]
	}
	return messages
}

func TestServeMCPProtocol(t *testing.T) {
	specs := []Spec{{ID: "sb-1", Name: "python-pytest", Image: "python:3.12-slim", Timeout: 60, Entrypoint: "pytest"}}
	in := mcpEnvelope(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}) +
		mcpEnvelope(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}) +
		mcpEnvelope(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) +
		mcpEnvelope(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
			"params": map[string]any{"name": "run_sandbox_missing", "arguments": map[string]any{}}}) +
		mcpEnvelope(map[string]any{"jsonrpc": "2.0", "id": 4, "method": "bogus/method"})
	var out bytes.Buffer
	if err := ServeMCP(specs, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	messages := mcpDecodeAll(t, &out)
	if len(messages) != 4 {
		t.Fatalf("expected 4 responses, got %d", len(messages))
	}
	init := messages[0]["result"].(map[string]any)
	if init["protocolVersion"] != "2024-11-05" {
		t.Fatalf("bad init: %v", init)
	}
	toolsResult := messages[1]["result"].(map[string]any)
	tools := toolsResult["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	tool := tools[0].(map[string]any)
	if tool["name"] != "run_sandbox_python_pytest" {
		t.Fatalf("bad tool name: %v", tool["name"])
	}
	if !strings.Contains(tool["description"].(string), "docker: python:3.12-slim") {
		t.Fatalf("bad description: %v", tool["description"])
	}
	unknown := messages[2]["result"].(map[string]any)
	if unknown["isError"] != true {
		t.Fatalf("unknown tool should error: %v", unknown)
	}
	if messages[3]["error"] == nil {
		t.Fatalf("bogus method should get a JSON-RPC error: %v", messages[3])
	}
}

func TestSpecDefaults(t *testing.T) {
	sb := Spec{Name: "x", Image: "img"}.orDefaults()
	if sb.RuntimeType != "docker" || sb.Entrypoint != "bash" || sb.NetworkPolicy != "none" || sb.Timeout != 300 {
		t.Fatalf("bad defaults: %+v", sb)
	}
}
