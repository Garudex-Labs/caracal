// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sandbox

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestNumeric(t *testing.T) {
	cases := []struct {
		name   string
		in     any
		want   float64
		wantOk bool
	}{
		{"float64", float64(2.5), 2.5, true},
		{"int", int(3), 3, true},
		{"int64", int64(4), 4, true},
		{"numeric string", "1.5", 1.5, true},
		{"non-numeric string", "abc", 0, false},
		{"bool", true, 0, false},
		{"nil", nil, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := numeric(tc.in)
			if ok != tc.wantOk || got != tc.want {
				t.Fatalf("numeric(%v) = (%v, %v), want (%v, %v)", tc.in, got, ok, tc.want, tc.wantOk)
			}
		})
	}
}

func TestConfigStr(t *testing.T) {
	m := map[string]any{"present": "value", "wrongType": 123}
	if got := configStr(m, "present"); got != "value" {
		t.Errorf("configStr present = %q, want value", got)
	}
	if got := configStr(m, "wrongType"); got != "" {
		t.Errorf("configStr wrong type = %q, want empty", got)
	}
	if got := configStr(m, "missing"); got != "" {
		t.Errorf("configStr missing = %q, want empty", got)
	}
}

func TestCommandContext(t *testing.T) {
	t.Run("non-positive timeout defaults to 300s", func(t *testing.T) {
		ctx, cancel := commandContext(0)
		defer cancel()
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("expected a deadline")
		}
		if remaining := time.Until(deadline); remaining < 250*time.Second || remaining > 300*time.Second {
			t.Fatalf("default deadline remaining = %s, want ~300s", remaining)
		}
	})
	t.Run("explicit timeout is honored", func(t *testing.T) {
		ctx, cancel := commandContext(5)
		defer cancel()
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("expected a deadline")
		}
		if remaining := time.Until(deadline); remaining <= 0 || remaining > 5*time.Second {
			t.Fatalf("explicit deadline remaining = %s, want (0,5s]", remaining)
		}
	})
}

func TestWriteFirecrackerConfigDefaults(t *testing.T) {
	path, cleanup, err := writeFirecrackerConfig(map[string]any{}, "/k/vmlinux", "/r/rootfs.ext4")
	if err != nil {
		t.Fatalf("writeFirecrackerConfig: %v", err)
	}
	defer cleanup()
	if !strings.HasSuffix(path, ".json") {
		t.Errorf("config path = %q, want a .json suffix", path)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("config is not valid JSON: %v", err)
	}

	boot := cfg["boot-source"].(map[string]any)
	if boot["kernel_image_path"] != "/k/vmlinux" {
		t.Errorf("kernel_image_path = %v", boot["kernel_image_path"])
	}
	if boot["boot_args"] != "console=ttyS0 reboot=k panic=1 pci=off" {
		t.Errorf("boot_args default = %v", boot["boot_args"])
	}
	drives := cfg["drives"].([]any)
	drive0 := drives[0].(map[string]any)
	if drive0["path_on_host"] != "/r/rootfs.ext4" {
		t.Errorf("path_on_host = %v", drive0["path_on_host"])
	}
	if drive0["is_root_device"] != true {
		t.Errorf("is_root_device = %v, want true", drive0["is_root_device"])
	}
	if drive0["is_read_only"] != false {
		t.Errorf("is_read_only default = %v, want false", drive0["is_read_only"])
	}
	machine := cfg["machine-config"].(map[string]any)
	if machine["vcpu_count"] != float64(1) || machine["mem_size_mib"] != float64(256) {
		t.Errorf("machine-config defaults = %v", machine)
	}

	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("cleanup left the config in place: stat err = %v", err)
	}
}

func TestWriteFirecrackerConfigOverrides(t *testing.T) {
	rc := map[string]any{
		"boot_args":        "console=off",
		"machine_config":   map[string]any{"vcpu_count": 2, "mem_size_mib": 512},
		"rootfs_read_only": true,
	}
	path, cleanup, err := writeFirecrackerConfig(rc, "/k", "/r")
	if err != nil {
		t.Fatalf("writeFirecrackerConfig: %v", err)
	}
	defer cleanup()

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("config is not valid JSON: %v", err)
	}
	if boot := cfg["boot-source"].(map[string]any); boot["boot_args"] != "console=off" {
		t.Errorf("boot_args override = %v", boot["boot_args"])
	}
	if drive0 := cfg["drives"].([]any)[0].(map[string]any); drive0["is_read_only"] != true {
		t.Errorf("is_read_only override = %v, want true", drive0["is_read_only"])
	}
	if machine := cfg["machine-config"].(map[string]any); machine["vcpu_count"] != float64(2) || machine["mem_size_mib"] != float64(512) {
		t.Errorf("machine-config override = %v", machine)
	}
}

func TestRunWithDeadlineReportsExitCode(t *testing.T) {
	// An unsupported runtime returns instantly, so the done channel wins the
	// select and the non-zero exit code is appended to the tool output.
	result := runWithDeadline(Spec{RuntimeType: "chroot", Timeout: 1, Entrypoint: "sh"}, "echo hi")
	if result["isError"] != true {
		t.Fatalf("isError = %v, want true", result["isError"])
	}
	content := result["content"].([]any)
	text := content[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "Unsupported sandbox runtime_type: chroot") {
		t.Errorf("text = %q, want the unsupported-runtime message", text)
	}
	if !strings.Contains(text, "[exit code: 2]") {
		t.Errorf("text = %q, want an exit-code suffix", text)
	}
}

// assertMissingRuntime exercises a runtime dispatch arm without ever shelling
// out to a real container: it only runs the spec when the runtime binary is
// absent, in which case the runner returns at the PATH lookup. When the binary
// is present (a developer box with docker, say) the case is skipped so the
// suite stays hermetic.
func assertMissingRuntime(t *testing.T, binary string, spec RunSpec) {
	t.Helper()
	if _, err := exec.LookPath(binary); err == nil {
		t.Skipf("%s is installed on this machine; skipping the non-hermetic runtime path", binary)
	}
	result := Run(spec)
	if result.ExitCode != 127 {
		t.Fatalf("Run exit = %d, want 127 for a missing runtime", result.ExitCode)
	}
	if !strings.Contains(result.Output, "local-runtime-missing: "+binary) {
		t.Fatalf("Run output = %q, want a local-runtime-missing notice for %s", result.Output, binary)
	}
}

func TestRunDispatchMissingRuntime(t *testing.T) {
	t.Run("docker", func(t *testing.T) {
		assertMissingRuntime(t, "docker", RunSpec{RuntimeType: "docker", Image: "img"})
	})
	t.Run("empty defaults to docker", func(t *testing.T) {
		assertMissingRuntime(t, "docker", RunSpec{RuntimeType: "", Image: "img"})
	})
	t.Run("lxc", func(t *testing.T) {
		assertMissingRuntime(t, "lxc", RunSpec{RuntimeType: "lxc", Image: "img"})
	})
	t.Run("firecracker", func(t *testing.T) {
		assertMissingRuntime(t, "firecracker", RunSpec{
			RuntimeType:   "firecracker",
			RuntimeConfig: map[string]any{"config_path": "/tmp/does-not-matter.json"},
		})
	})
	t.Run("wasm default runtime", func(t *testing.T) {
		assertMissingRuntime(t, "wasmtime", RunSpec{
			RuntimeType:   "wasm",
			RuntimeConfig: map[string]any{"module": "mod.wasm"},
		})
	})
	t.Run("wasm custom runtime", func(t *testing.T) {
		assertMissingRuntime(t, "wasmer", RunSpec{
			RuntimeType:   "wasm",
			RuntimeConfig: map[string]any{"runtime": "wasmer", "module": "mod.wasm"},
		})
	})
}
