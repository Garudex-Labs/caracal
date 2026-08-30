// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { applyParsedConfig, parseMcpConfigJson, type EnvVar, type McpFieldSetters } from "./mcp-parser.ts";

test("rejects malformed and non-object payloads", () => {
	assert.equal(parseMcpConfigJson("not json").error, "Invalid JSON");
	assert.equal(parseMcpConfigJson("[1,2]").error, "Config must be a JSON object");
	assert.equal(parseMcpConfigJson('"str"').error, "Config must be a JSON object");
	assert.equal(parseMcpConfigJson("null").error, "Config must be a JSON object");
	assert.equal(parseMcpConfigJson("{}").error, "Could not detect command or url in config");
});

test("parses a bare stdio config with env vars", () => {
	const { parsed, error } = parseMcpConfigJson(
		JSON.stringify({ command: "npx", args: ["-y", "@acme/mcp"], env: { API_TOKEN: "", PORT: 8080 } }),
	);
	assert.equal(error, undefined);
	assert.equal(parsed?.transport, "stdio");
	assert.equal(parsed?.command, "npx");
	assert.deepEqual(parsed?.args, ["-y", "@acme/mcp"]);
	assert.equal(parsed?.framework, "typescript");
	assert.deepEqual(
		parsed?.envVars.map((v) => v.name).sort(),
		["API_TOKEN", "PORT"],
	);
});

test("unwraps the mcpServers harness shape and keeps the server name", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({ mcpServers: { github: { command: "docker", args: ["run", "-i", "ghcr.io/github/mcp"] } } }),
	);
	assert.equal(parsed?.serverName, "github");
	assert.equal(parsed?.framework, "docker");
	assert.equal(parsed?.dockerImage, "ghcr.io/github/mcp");
});

test("unwraps a single named key when it is not a known field", () => {
	const { parsed } = parseMcpConfigJson(JSON.stringify({ jira: { command: "python3", args: [] } }));
	assert.equal(parsed?.serverName, "jira");
	assert.equal(parsed?.framework, "python");
});

test("parses a remote url config with headers and $VAR secrets", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({
			type: "http",
			url: "https://mcp.example.com/sse",
			headers: { Authorization: "Bearer $ACME_TOKEN" },
			autoApprove: ["search"],
		}),
	);
	assert.equal(parsed?.transport, "http");
	assert.equal(parsed?.url, "https://mcp.example.com/sse");
	assert.deepEqual(parsed?.headers, [{ name: "Authorization", value: "Bearer $ACME_TOKEN" }]);
	assert.deepEqual(parsed?.envVars.map((v) => v.name), ["ACME_TOKEN"]);
	assert.deepEqual(parsed?.autoApprove, ["search"]);
});

test("detects $VAR placeholders in stdio args without duplicating env keys", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({ command: "node", args: ["server.js", "--token=$MY_TOKEN"], env: { MY_TOKEN: "$MY_TOKEN" } }),
	);
	assert.deepEqual(parsed?.envVars.map((v) => v.name), ["MY_TOKEN"]);
});

test("parses a server.json manifest with remotes and variables", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({
			remotes: [{ url: "https://acme.dev/mcp", type: "streamable-http", variables: { KEY: { description: "api key" } } }],
		}),
	);
	assert.equal(parsed?.url, "https://acme.dev/mcp");
	assert.equal(parsed?.transport, "streamable-http");
	assert.deepEqual(parsed?.envVars, [{ name: "KEY", description: "api key", required: true }]);
});

test("packages-only manifest implies a docker stdio server", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({ packages: [{ runtimeArguments: [{ value: "API_KEY=abc", description: "key" }] }] }),
	);
	assert.equal(parsed?.transport, "stdio");
	assert.equal(parsed?.framework, "docker");
	assert.deepEqual(parsed?.envVars, [{ name: "API_KEY", description: "key", required: true }]);
});

test("registry format lifts name and description from server metadata", () => {
	const { parsed } = parseMcpConfigJson(
		JSON.stringify({
			server: { title: "Acme MCP", description: "does acme things", remotes: [{ url: "https://acme.dev/mcp" }] },
		}),
	);
	assert.equal(parsed?.serverName, "Acme MCP");
	assert.equal(parsed?.description, "does acme things");
	assert.equal(parsed?.url, "https://acme.dev/mcp");
});

function recordingSetters(): { state: Record<string, unknown>; setters: McpFieldSetters } {
	const state: Record<string, unknown> = {};
	const setters: McpFieldSetters = {
		setCommand: (v: string) => (state.command = v),
		setArgs: (v: string) => (state.args = v),
		setMcpUrl: (v: string) => (state.url = v),
		setTransport: (v: string) => (state.transport = v),
		setFramework: (v: string) => (state.framework = v),
		setDockerImage: (v: string) => (state.dockerImage = v),
		setEnvVars: (v: EnvVar[]) => (state.envVars = v),
	};
	return { state, setters };
}

test("fill mode leaves fields the parse did not produce untouched", () => {
	const { state, setters } = recordingSetters();
	applyParsedConfig({ command: "npx", envVars: [] }, setters, "fill");
	assert.deepEqual(state, { command: "npx" });
});

test("overwrite mode clears stale fields", () => {
	const { state, setters } = recordingSetters();
	applyParsedConfig({ url: "https://acme.dev/mcp", transport: "sse", envVars: [] }, setters, "overwrite");
	assert.equal(state.url, "https://acme.dev/mcp");
	assert.equal(state.command, "");
	assert.equal(state.dockerImage, "");
	assert.deepEqual(state.envVars, []);
});
