// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

// caracal is the command-line interface to the Caracal platform.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/cobra"

	"github.com/garudex-labs/caracal/internal/cli/clierr"
	"github.com/garudex-labs/caracal/internal/cli/ui"
)

// cliVersion is stamped at build time; the zero value marks a dev build.
var cliVersion = "0.0.0"

// newRootCommand assembles the full command tree.
func newRootCommand() *cobra.Command {
	root := &cobra.Command{
		Use:           "caracal",
		Short:         "Caracal: the agent-centric registry and observability platform",
		Version:       cliVersion,
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(authCommand())
	root.AddCommand(configCommand())
	root.AddCommand(apiCommand())
	root.AddCommand(useCommand())
	root.AddCommand(syncCommand())
	root.AddCommand(pullTopCommand())
	root.AddCommand(reconcileCommand())
	root.AddCommand(registryCommand())
	root.AddCommand(agentCommand())
	root.AddCommand(opsCommand())
	root.AddCommand(doctorCommand())
	root.AddCommand(hookCommand())
	root.AddCommand(scanCommand())
	root.AddCommand(sandboxCommand())
	root.AddCommand(selfCommand())
	return root
}

func main() {
	// Ctrl+C exits with the conventional interrupt status after clearing
	// any progress indicator, so the terminal never keeps a partial line.
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, os.Interrupt)
	go func() {
		<-interrupts
		ui.Interrupt()
		os.Exit(130)
	}()
	root := newRootCommand()
	if err := root.Execute(); err != nil {
		var cerr *clierr.Error
		jsonOK := true
		if !errors.As(err, &cerr) {
			cerr, jsonOK = translateParseError(root, err)
		}
		if cerr.Message == "Aborted!" {
			os.Exit(1)
		}
		clierr.Emit(cerr, jsonOK && jsonErrorsRequested(os.Args[1:]), debugRequested())
		os.Exit(cerr.ExitCode())
	}
}

// translateParseError renders argument-parsing failures with the CLI's
// established option and command phrasing. The error document form is
// available only where the invocation could have selected it.
func translateParseError(root *cobra.Command, err error) (*clierr.Error, bool) {
	message := err.Error()
	target, rest, _ := root.Find(stripFlags(os.Args[1:]))
	switch {
	case target != nil && target.HasSubCommands() && len(rest) > 0 && rest[0] != "help":
		message = fmt.Sprintf("No such command '%s'.", rest[0])
		names := []string{}
		for _, sub := range target.Commands() {
			names = append(names, sub.Name())
		}
		if best := closestMatch(rest[0], names); best != "" {
			message += fmt.Sprintf(" Did you mean '%s'?", best)
		}
	case target != nil && !target.HasSubCommands() && len(rest) > 0 && strings.HasPrefix(message, "unknown command "):
		message = fmt.Sprintf("Got unexpected extra argument(s) (%s)", strings.Join(rest, " "))
	default:
		switch {
		case strings.HasPrefix(message, "unknown flag: "):
			message = "No such option: " + strings.TrimPrefix(message, "unknown flag: ")
		case strings.HasPrefix(message, "unknown shorthand flag: "):
			if i := strings.LastIndex(message, " in "); i >= 0 {
				message = "No such option: " + message[i+4:]
			}
		case strings.HasPrefix(message, "unknown command "):
			if parts := strings.SplitN(message, "\"", 3); len(parts) >= 2 {
				message = fmt.Sprintf("No such command '%s'.", parts[1])
			}
		}
	}
	command := ""
	jsonOK := false
	if target != nil {
		command = strings.TrimSpace(strings.TrimPrefix(target.CommandPath(), "caracal"))
		jsonOK = target.Flags().Lookup("output") != nil
	}
	operation := "Run caracal"
	remediation := "Run caracal --help for valid usage."
	if command != "" {
		operation = "Run caracal " + command
		remediation = "Run caracal " + command + " --help for valid usage."
	}
	return &clierr.Error{Category: clierr.Usage, Message: message, Operation: operation, Remediation: remediation}, jsonOK
}

// stripFlags drops option tokens so command resolution sees only the path.
func stripFlags(args []string) []string {
	kept := []string{}
	for _, value := range args {
		if strings.HasPrefix(value, "-") {
			break
		}
		kept = append(kept, value)
	}
	return kept
}

// jsonErrorsRequested reports whether the invocation selected JSON output.
func jsonErrorsRequested(args []string) bool {
	for i, value := range args {
		if value == "--output=json" || value == "-ojson" {
			return true
		}
		if (value == "--output" || value == "-o") && i+1 < len(args) && args[i+1] == "json" {
			return true
		}
	}
	return false
}

func debugRequested() bool {
	return os.Getenv("CARACAL_DEBUG") != ""
}

// outputJSON prints the universal JSON contract: bare lists gain the
// items/total/page envelope, item-bearing objects gain pagination defaults.
func outputJSON(data any) {
	switch v := data.(type) {
	case []any:
		data = map[string]any{"items": v, "total": len(v), "page": 1, "page_size": len(v)}
	case map[string]any:
		if items, ok := v["items"].([]any); ok {
			if _, has := v["total"]; !has {
				v["total"] = len(items)
			}
			if _, has := v["page"]; !has {
				v["page"] = 1
			}
			if _, has := v["page_size"]; !has {
				v["page_size"] = len(items)
			}
		}
	}
	fmt.Println(marshalIndentNoEscape(data))
}

// marshalIndentNoEscape renders indent-2 JSON without HTML escaping,
// matching the wire contract for URLs and comparison operators.
func marshalIndentNoEscape(data any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(data)
	return strings.TrimRight(buf.String(), "\n")
}

// printIndented pretty-prints a raw JSON document without envelope wrapping.
func printIndented(raw []byte) {
	trimmed := bytes.TrimSpace(raw)
	var pretty bytes.Buffer
	if json.Indent(&pretty, trimmed, "", "  ") != nil {
		fmt.Println(string(trimmed))
		return
	}
	fmt.Println(pretty.String())
}

// outputJSONRaw prints a server document preserving its field order; bare
// arrays gain the items/total/page envelope of the list contract, and
// objects carrying an item list gain any missing envelope fields.
func outputJSONRaw(raw []byte) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err == nil {
			var doc bytes.Buffer
			doc.WriteString(`{"items":`)
			doc.Write(trimmed)
			fmt.Fprintf(&doc, `,"total":%d,"page":1,"page_size":%d}`, len(items), len(items))
			trimmed = doc.Bytes()
		}
	} else if len(trimmed) > 0 && trimmed[0] == '{' {
		var probe struct {
			Items    []json.RawMessage `json:"items"`
			Total    *int              `json:"total"`
			Page     *int              `json:"page"`
			PageSize *int              `json:"page_size"`
		}
		var keys map[string]json.RawMessage
		if json.Unmarshal(trimmed, &probe) == nil && json.Unmarshal(trimmed, &keys) == nil {
			if itemsRaw, hasItems := keys["items"]; hasItems && bytes.HasPrefix(bytes.TrimSpace(itemsRaw), []byte("[")) {
				var doc bytes.Buffer
				doc.Write(bytes.TrimSuffix(bytes.TrimRight(trimmed, " \n\t"), []byte("}")))
				if _, ok := keys["total"]; !ok {
					fmt.Fprintf(&doc, `,"total":%d`, len(probe.Items))
				}
				if _, ok := keys["page"]; !ok {
					doc.WriteString(`,"page":1`)
				}
				if _, ok := keys["page_size"]; !ok {
					fmt.Fprintf(&doc, `,"page_size":%d`, len(probe.Items))
				}
				doc.WriteString("}")
				trimmed = doc.Bytes()
			}
		}
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, trimmed, "", "  ") != nil {
		fmt.Println(string(trimmed))
		return
	}
	fmt.Println(pretty.String())
}

// outputFlag registers the shared --output/-o flag.
func outputFlag(cmd *cobra.Command) *string {
	mode := cmd.Flags().StringP("output", "o", "table", "Output format: table or json")
	return mode
}

// closestMatch reports the best fuzzy candidate above the standard cutoff.
func closestMatch(word string, candidates []string) string {
	best, bestRatio := "", 0.6
	for _, candidate := range candidates {
		ratio := matchRatio(word, candidate)
		if ratio >= bestRatio {
			best, bestRatio = candidate, ratio
		}
	}
	return best
}

// matchRatio mirrors the classic sequence-matcher similarity measure.
func matchRatio(a, b string) float64 {
	matches := matchingBlocks(a, b, 0, len(a), 0, len(b))
	total := len(a) + len(b)
	if total == 0 {
		return 1
	}
	return 2 * float64(matches) / float64(total)
}

func matchingBlocks(a, b string, aLo, aHi, bLo, bHi int) int {
	bestI, bestJ, bestSize := aLo, bLo, 0
	for i := aLo; i < aHi; i++ {
		for j := bLo; j < bHi; j++ {
			size := 0
			for i+size < aHi && j+size < bHi && a[i+size] == b[j+size] {
				size++
			}
			if size > bestSize {
				bestI, bestJ, bestSize = i, j, size
			}
		}
	}
	if bestSize == 0 {
		return 0
	}
	return bestSize +
		matchingBlocks(a, b, aLo, bestI, bLo, bestJ) +
		matchingBlocks(a, b, bestI+bestSize, aHi, bestJ+bestSize, bHi)
}
