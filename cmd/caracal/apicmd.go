// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/api"
	"github.com/garudex-labs/caracal/internal/cli/clierr"
)

var apiMethods = map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}

func apiCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "api METHOD PATH",
		Short: "Call an authenticated Caracal JSON API endpoint",
		Long: "JSON from standard input is used when --from-file is omitted. The command\n" +
			"uses the configured bearer token and never accepts arbitrary auth headers.",
		Args: cobra.ExactArgs(2),
	}
	fromFile := cmd.Flags().StringP("from-file", "f", "", "Read a JSON object request body")
	params := cmd.Flags().StringArray("param", nil, "Query parameter as KEY=VALUE; repeatable")
	mode := outputFlag(cmd)
	cmd.RunE = func(_ *cobra.Command, args []string) error {
		method := strings.ToUpper(args[0])
		path := args[1]
		if !apiMethods[method] {
			return &clierr.Error{
				Category: clierr.Validation, Message: fmt.Sprintf("Unsupported API method: %s.", args[0]),
				Operation: "Call Caracal API", Resource: "API method",
				Remediation: "Use one of GET, POST, PUT, PATCH, or DELETE.",
			}
		}
		if !strings.HasPrefix(path, "/api/v1/") {
			return &clierr.Error{
				Category: clierr.Validation, Message: "API paths must start with /api/v1/.",
				Operation: "Call Caracal API", Resource: path,
				Remediation: "Provide a relative /api/v1 endpoint path.",
			}
		}
		query := map[string]string{}
		for _, value := range *params {
			key, item, found := strings.Cut(value, "=")
			if !found || key == "" {
				return &clierr.Error{
					Category: clierr.Validation, Message: fmt.Sprintf("Invalid API parameter: %s.", value),
					Operation: "Call Caracal API", Resource: "API query parameters",
					Remediation: "Use --param KEY=VALUE for every query parameter.",
				}
			}
			query[key] = item
		}
		body, cerr := requestBody(*fromFile)
		if cerr != nil {
			return cerr
		}
		client, cerr := api.New(cliVersion)
		if cerr != nil {
			return cerr
		}
		if cerr := client.EnforceVersion("api"); cerr != nil {
			return cerr
		}
		raw, cerr := client.Do(method, path, query, body, "Call Caracal API", "Caracal API endpoint")
		if cerr != nil {
			return cerr
		}
		if *mode == "json" {
			printIndented(raw)
			return nil
		}
		var response any
		_ = json.Unmarshal(raw, &response)
		renderResponse(response)
		return nil
	}
	return cmd
}

// requestBody reads a JSON object from --from-file or piped standard input.
func requestBody(fromFile string) (any, *clierr.Error) {
	var blob []byte
	source := "API request body"
	if fromFile != "" {
		data, err := os.ReadFile(fromFile)
		if err != nil {
			return nil, &clierr.Error{
				Category: clierr.Validation, Message: "The request body file cannot be read.",
				Operation: "Call Caracal API", Resource: fromFile,
				Remediation: "Check the file path and permissions, then retry.", Detail: err.Error(),
			}
		}
		blob = data
	} else {
		stat, err := os.Stdin.Stat()
		if err != nil || (stat.Mode()&os.ModeCharDevice) != 0 {
			return nil, nil
		}
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return nil, nil
		}
		blob = data
	}
	trimmed := strings.TrimSpace(string(blob))
	if trimmed == "" {
		return nil, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
		return nil, &clierr.Error{
			Category: clierr.Validation, Message: "API standard input is not valid JSON.",
			Operation: "Call Caracal API", Resource: source,
			Remediation: "Pipe one JSON object or use --from-file.", Detail: err.Error(),
		}
	}
	return payload, nil
}

func renderResponse(response any) {
	switch v := response.(type) {
	case map[string]any:
		for key, value := range v {
			rendered := ""
			switch item := value.(type) {
			case map[string]any, []any:
				blob, _ := json.Marshal(item)
				rendered = string(blob)
			default:
				rendered = fmt.Sprint(item)
			}
			fmt.Printf("%-24s %s\n", key, rendered)
		}
	case []any:
		for index, value := range v {
			blob, _ := json.Marshal(value)
			fmt.Printf("%4d  %s\n", index+1, string(blob))
		}
	default:
		fmt.Println(v)
	}
}
