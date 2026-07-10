// Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
// Caracal, a product of Garudex Labs
//
// Package admin is the Caracal admin client for Go.
//
// ControlClient mints a scoped, single-use token per governed control invoke.
// AdminClient covers the admin API provisioning surface: zones, applications,
// resources, providers, policies, and policy sets. The Ensure family layers
// idempotent reconcilers on top that converge live state to a desired state,
// and AuthorGrantsDocument renders the zone grant data document the platform
// decision contract reads.
package admin
