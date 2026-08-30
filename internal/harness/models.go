// SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
// SPDX-License-Identifier: Apache-2.0

package harness

import (
	"encoding/json"
	"fmt"
	"sync"

	harnessdata "github.com/garudex-labs/caracal/packages/harness-data"
)

type modelCatalog struct {
	Harness string `json:"harness"`
	Models  []struct {
		ID string `json:"id"`
	} `json:"models"`
}

var loadModelIDs = sync.OnceValues(func() (map[string][]string, error) {
	entries, err := harnessdata.ModelsFS.ReadDir("harness_models")
	if err != nil {
		return nil, fmt.Errorf("read model catalogs: %w", err)
	}
	ids := make(map[string][]string, len(entries))
	for _, entry := range entries {
		data, err := harnessdata.ModelsFS.ReadFile("harness_models/" + entry.Name())
		if err != nil {
			return nil, fmt.Errorf("read model catalog %s: %w", entry.Name(), err)
		}
		var catalog modelCatalog
		if err := json.Unmarshal(data, &catalog); err != nil {
			return nil, fmt.Errorf("parse model catalog %s: %w", entry.Name(), err)
		}
		list := make([]string, 0, len(catalog.Models))
		for _, model := range catalog.Models {
			list = append(list, model.ID)
		}
		ids[catalog.Harness] = list
	}
	return ids, nil
})

// SupportedModelIDs returns the model identifiers a harness accepts, in
// catalog order. Harnesses without a catalog return an empty list.
func SupportedModelIDs(name string) ([]string, error) {
	ids, err := loadModelIDs()
	if err != nil {
		return nil, err
	}
	return ids[name], nil
}
