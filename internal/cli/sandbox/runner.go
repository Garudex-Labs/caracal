// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// Package sandbox executes registered sandbox components on the local
// machine. This is security-sensitive: every host-side invocation uses
// argv arrays (never a host shell), agent-supplied command strings are
// only ever interpreted inside the isolation boundary they target, and
// containers are force-removed on every exit path.
package sandbox

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// MaxLogBytes truncates captured sandbox output.
const MaxLogBytes = 64 * 1024

// RunSpec describes one sandbox execution request.
type RunSpec struct {
	SandboxID      string
	Image          string
	Command        string
	RuntimeType    string
	NetworkPolicy  string
	Timeout        int
	Env            map[string]string
	ResourceLimits map[string]any
	RuntimeConfig  map[string]any
}

// RunResult is the outcome surfaced to the caller.
type RunResult struct {
	Output   string
	ExitCode int
}

func truncate(text string) string {
	if len(text) > MaxLogBytes {
		return text[:MaxLogBytes] + "\n... [truncated at 64KB]"
	}
	return text
}

func missingRuntime(name string) RunResult {
	return RunResult{
		Output:   fmt.Sprintf("local-runtime-missing: %s is not installed or not on PATH", name),
		ExitCode: 127,
	}
}

// shellWords splits a command string with POSIX-style quoting, mirroring
// how the container runtime lexes string commands. The host never
// interprets the result; it is passed as argv into the sandbox.
func shellWords(s string) []string {
	var words []string
	var current strings.Builder
	inSingle, inDouble, escaped, started := false, false, false, false
	for _, r := range s {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\' && !inSingle:
			escaped = true
			started = true
		case r == '\'' && !inDouble:
			inSingle = !inSingle
			started = true
		case r == '"' && !inSingle:
			inDouble = !inDouble
			started = true
		case (r == ' ' || r == '\t' || r == '\n') && !inSingle && !inDouble:
			if started {
				words = append(words, current.String())
				current.Reset()
				started = false
			}
		default:
			current.WriteRune(r)
			started = true
		}
	}
	if started {
		words = append(words, current.String())
	}
	return words
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case string:
		f, err := strconv.ParseFloat(n, 64)
		return f, err == nil
	}
	return 0, false
}

func configStr(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// Run dispatches to the configured local sandbox runtime.
func Run(spec RunSpec) RunResult {
	switch spec.RuntimeType {
	case "", "docker":
		return runDocker(spec)
	case "lxc":
		return runLXC(spec)
	case "firecracker":
		return runFirecracker(spec)
	case "wasm":
		return runWasm(spec)
	}
	return RunResult{Output: fmt.Sprintf("Unsupported sandbox runtime_type: %s", spec.RuntimeType), ExitCode: 2}
}

func commandContext(timeout int) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		timeout = 300
	}
	return context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
}

func runDocker(spec RunSpec) RunResult {
	docker, err := exec.LookPath("docker")
	if err != nil {
		return missingRuntime("docker")
	}
	ctx, cancel := commandContext(spec.Timeout)
	defer cancel()

	args := []string{"create"}
	switch spec.NetworkPolicy {
	case "none", "host", "bridge":
		args = append(args, "--network", spec.NetworkPolicy)
	case "restricted":
		// Restricted policy is local-runner only for now; no-network until
		// policy profiles exist.
		args = append(args, "--network", "none")
	}
	if mem, ok := numeric(spec.ResourceLimits["memory_mb"]); ok && mem > 0 {
		args = append(args, "--memory", fmt.Sprintf("%dm", int(mem)))
	}
	if cpus, ok := numeric(spec.ResourceLimits["cpu_count"]); ok && cpus > 0 {
		args = append(args, "--cpus", strconv.FormatFloat(cpus, 'f', -1, 64))
	}
	for key, value := range spec.Env {
		args = append(args, "--env", key+"="+value)
	}
	args = append(args, spec.Image)
	if spec.Command != "" {
		args = append(args, shellWords(spec.Command)...)
	}
	// Pull progress goes to stderr; only stdout carries the container id.
	var createErr strings.Builder
	createCmd := exec.CommandContext(ctx, docker, args...)
	createCmd.Stderr = &createErr
	created, err := createCmd.Output()
	if err != nil {
		return RunResult{Output: "Error: " + truncate(strings.TrimSpace(createErr.String())), ExitCode: 1}
	}
	containerID := strings.TrimSpace(string(created))
	defer func() {
		// Cleanup must survive the run context's deadline.
		_ = exec.Command(docker, "rm", "-f", containerID).Run()
	}()

	if out, err := exec.CommandContext(ctx, docker, "start", containerID).CombinedOutput(); err != nil {
		return RunResult{Output: "Error: " + truncate(strings.TrimSpace(string(out))), ExitCode: 1}
	}
	waitOut, err := exec.CommandContext(ctx, docker, "wait", containerID).Output()
	if err != nil {
		if ctx.Err() != nil {
			return RunResult{Output: fmt.Sprintf("Sandbox timed out after %ds", spec.Timeout), ExitCode: 124}
		}
		return RunResult{Output: "Error: docker wait failed", ExitCode: 1}
	}
	exitCode, _ := strconv.Atoi(strings.TrimSpace(string(waitOut)))

	logs, _ := exec.Command(docker, "logs", containerID).CombinedOutput()
	output := truncate(string(logs))

	oomOut, _ := exec.Command(docker, "inspect", "-f", "{{.State.OOMKilled}}", containerID).Output()
	if strings.TrimSpace(string(oomOut)) == "true" {
		output += "\n[oom-killed]"
	}
	return RunResult{Output: output, ExitCode: exitCode}
}

func runLXC(spec RunSpec) RunResult {
	lxc, err := exec.LookPath("lxc")
	if err != nil {
		return missingRuntime("lxc")
	}
	ctx, cancel := commandContext(spec.Timeout)
	defer cancel()
	name := fmt.Sprintf("caracal-%.8s-%d", spec.SandboxID, time.Now().UnixNano()%100000000)
	if out, err := exec.CommandContext(ctx, lxc, "launch", spec.Image, name, "--ephemeral").CombinedOutput(); err != nil {
		return RunResult{Output: "Error: " + truncate(strings.TrimSpace(string(out))), ExitCode: 1}
	}
	defer func() { _ = exec.Command(lxc, "delete", name, "--force").Run() }()
	command := spec.Command
	if command == "" {
		command = "sh"
	}
	// The command string is interpreted by the shell inside the container,
	// never by a host shell.
	out, err := exec.CommandContext(ctx, lxc, "exec", name, "--", "sh", "-lc", command).CombinedOutput()
	result := RunResult{Output: truncate(string(out))}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
		}
	}
	return result
}

func runFirecracker(spec RunSpec) RunResult {
	fc, err := exec.LookPath("firecracker")
	if err != nil {
		return missingRuntime("firecracker")
	}
	ctx, cancel := commandContext(spec.Timeout)
	defer cancel()
	configPath := configStr(spec.RuntimeConfig, "config_path")
	if configPath == "" {
		kernel := configStr(spec.RuntimeConfig, "kernel_image_path")
		rootfs := configStr(spec.RuntimeConfig, "rootfs_path")
		if kernel == "" || rootfs == "" {
			return RunResult{
				Output:   "Firecracker requires runtime_config.config_path or kernel_image_path/rootfs_path",
				ExitCode: 2,
			}
		}
		path, cleanup, err := writeFirecrackerConfig(spec.RuntimeConfig, kernel, rootfs)
		if err != nil {
			return RunResult{Output: "Error: " + err.Error(), ExitCode: 1}
		}
		defer cleanup()
		configPath = path
	}
	out, err := exec.CommandContext(ctx, fc, "--config-file", configPath).CombinedOutput()
	result := RunResult{Output: truncate(string(out))}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
		}
	}
	return result
}

func runWasm(spec RunSpec) RunResult {
	runtimeName := configStr(spec.RuntimeConfig, "runtime")
	if runtimeName == "" {
		runtimeName = "wasmtime"
	}
	wasmtime, err := exec.LookPath(runtimeName)
	if err != nil {
		return missingRuntime(runtimeName)
	}
	module := configStr(spec.RuntimeConfig, "module")
	if module == "" {
		module = spec.Image
	}
	if module == "" {
		return RunResult{Output: "WASM requires image or runtime_config.module", ExitCode: 2}
	}
	ctx, cancel := commandContext(spec.Timeout)
	defer cancel()
	args := []string{"run"}
	dirs, ok := spec.RuntimeConfig["preopen_dirs"].([]any)
	if !ok {
		dirs = []any{"."}
	}
	for _, dir := range dirs {
		args = append(args, "--dir", fmt.Sprint(dir))
	}
	args = append(args, module)
	if spec.Command != "" {
		args = append(args, shellWords(spec.Command)...)
	}
	out, err := exec.CommandContext(ctx, wasmtime, args...).CombinedOutput()
	result := RunResult{Output: truncate(string(out))}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = 1
		}
	}
	return result
}
