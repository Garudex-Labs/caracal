# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs

Operator scripts that talk to a running Caracal stack from the host.

- `smokeTest.sh` - probes every service `/ready` path; exits non-zero on the
  first failure. Intended for CI gates and post-deploy validation.

Environment overrides:

- `CARACAL_SMOKE_HOST` (default: `127.0.0.1`)
