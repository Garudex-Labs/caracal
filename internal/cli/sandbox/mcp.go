// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package sandbox

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// firecrackerConfig materializes a minimal VM config when the caller only
// supplies kernel and rootfs paths.
func writeFirecrackerConfig(runtimeConfig map[string]any, kernel, rootfs string) (string, func(), error) {
	bootArgs := configStr(runtimeConfig, "boot_args")
	if bootArgs == "" {
		bootArgs = "console=ttyS0 reboot=k panic=1 pci=off"
	}
	machine, ok := runtimeConfig["machine_config"].(map[string]any)
	if !ok {
		machine = map[string]any{"vcpu_count": 1, "mem_size_mib": 256}
	}
	readOnly, _ := runtimeConfig["rootfs_read_only"].(bool)
	cfg := map[string]any{
		"boot-source": map[string]any{"kernel_image_path": kernel, "boot_args": bootArgs},
		"drives": []any{map[string]any{
			"drive_id": "rootfs", "path_on_host": rootfs,
			"is_root_device": true, "is_read_only": readOnly,
		}},
		"machine-config": machine,
	}
	f, err := os.CreateTemp("", "caracal-fc-*.json")
	if err != nil {
		return "", nil, err
	}
	if err := json.NewEncoder(f).Encode(cfg); err != nil {
		_ = f.Close()
		os.Remove(f.Name())
		return "", nil, err
	}
	_ = f.Close()
	return f.Name(), func() { _ = os.Remove(f.Name()) }, nil
}

// ── MCP stdio server ────────────────────────────────────────────────────

// Spec is one registered sandbox exposed as an MCP tool.
type Spec struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Image          string         `json:"image"`
	RuntimeType    string         `json:"runtime_type"`
	Entrypoint     string         `json:"entrypoint"`
	NetworkPolicy  string         `json:"network_policy"`
	Timeout        int            `json:"timeout"`
	ResourceLimits map[string]any `json:"resource_limits"`
	RuntimeConfig  map[string]any `json:"runtime_config"`
}

func (s Spec) orDefaults() Spec {
	if s.RuntimeType == "" {
		s.RuntimeType = "docker"
	}
	if s.Entrypoint == "" {
		s.Entrypoint = "bash"
	}
	if s.NetworkPolicy == "" {
		s.NetworkPolicy = "none"
	}
	if s.Timeout <= 0 {
		s.Timeout = 300
	}
	return s
}

func readMessage(r *bufio.Reader) (map[string]any, error) {
	contentLength := 0
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		trimmed := strings.TrimRight(line, "\r\n")
		if trimmed == "" {
			break
		}
		if key, value, found := strings.Cut(trimmed, ":"); found {
			if strings.EqualFold(strings.TrimSpace(key), "content-length") {
				contentLength, _ = strconv.Atoi(strings.TrimSpace(value))
			}
		}
	}
	if contentLength == 0 {
		return nil, io.EOF
	}
	body := make([]byte, contentLength)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, err
	}
	var msg map[string]any
	if err := json.Unmarshal(body, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func sendMessage(w io.Writer, msg map[string]any) {
	body, _ := json.Marshal(msg)
	// A write failure means the stdio session is gone; nothing to report to.
	_, _ = fmt.Fprintf(w, "Content-Length: %d\r\n\r\n%s", len(body), body)
}

func response(id any, result map[string]any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "result": result}
}

func rpcError(id any, code int, message string) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": message}}
}

func textResult(text string, isError bool) map[string]any {
	return map[string]any{
		"content": []any{map[string]any{"type": "text", "text": text}},
		"isError": isError,
	}
}

// ServeMCP runs the stdio MCP server exposing each sandbox as a tool.
func ServeMCP(specs []Spec, stdin io.Reader, stdout io.Writer) error {
	toolToSpec := map[string]Spec{}
	tools := []any{}
	for _, raw := range specs {
		sb := raw.orDefaults()
		toolName := "run_sandbox_" + strings.ReplaceAll(sb.Name, "-", "_")
		toolToSpec[toolName] = sb
		tools = append(tools, map[string]any{
			"name": toolName,
			"description": fmt.Sprintf(
				"Run a command in the '%s' sandbox (%s: %s, timeout: %ds, network: %s). Default command: %s",
				sb.Name, sb.RuntimeType, sb.Image, sb.Timeout, sb.NetworkPolicy, sb.Entrypoint),
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"command": map[string]any{
						"type":        "string",
						"description": "Command to run inside the container. Default: " + sb.Entrypoint,
					},
				},
				"required": []any{},
			},
		})
	}

	reader := bufio.NewReader(stdin)
	for {
		msg, err := readMessage(reader)
		if err != nil {
			return nil
		}
		method, _ := msg["method"].(string)
		id := msg["id"]
		switch method {
		case "initialize":
			sendMessage(stdout, response(id, map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "caracal-sandbox", "version": "1.0.0"},
			}))
		case "notifications/initialized":
		case "tools/list":
			sendMessage(stdout, response(id, map[string]any{"tools": tools}))
		case "tools/call":
			params, _ := msg["params"].(map[string]any)
			toolName, _ := params["name"].(string)
			arguments, _ := params["arguments"].(map[string]any)
			sb, known := toolToSpec[toolName]
			if !known {
				sendMessage(stdout, response(id, textResult("Unknown sandbox tool: "+toolName, true)))
				continue
			}
			command, _ := arguments["command"].(string)
			if command == "" {
				command = sb.Entrypoint
			}
			result := runWithDeadline(sb, command)
			sendMessage(stdout, response(id, result))
		default:
			if id != nil {
				sendMessage(stdout, rpcError(id, -32601, "Method not found: "+method))
			}
		}
	}
}

// runWithDeadline executes one tool call, reporting timeout distinctly.
func runWithDeadline(sb Spec, command string) map[string]any {
	done := make(chan RunResult, 1)
	go func() {
		done <- Run(RunSpec{
			SandboxID: sb.ID, Image: sb.Image, Command: command,
			RuntimeType: sb.RuntimeType, NetworkPolicy: sb.NetworkPolicy,
			Timeout: sb.Timeout, ResourceLimits: sb.ResourceLimits, RuntimeConfig: sb.RuntimeConfig,
		})
	}()
	select {
	case result := <-done:
		output := result.Output
		if result.ExitCode != 0 {
			output += fmt.Sprintf("\n[exit code: %d]", result.ExitCode)
		}
		if output == "" {
			output = "(no output)"
		}
		return textResult(output, result.ExitCode != 0)
	case <-time.After(time.Duration(sb.Timeout+10) * time.Second):
		return textResult(fmt.Sprintf("Sandbox timed out after %ds", sb.Timeout), true)
	}
}
