<!-- SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com> -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenTofu state bootstrap

One-time setup that creates the S3 bucket and DynamoDB lock table the main Caracal module uses for remote state. Run this **once per AWS account**, before the first `tofu init` in `infra/opentofu/aws/`.

## What it creates

| Resource | Why |
|---|---|
| `aws_s3_bucket` (versioned, AES256, public-access-blocked, TLS-only) | Holds `terraform.tfstate`; versioning lets you recover from a corrupted state |
| `aws_dynamodb_table` (PAY_PER_REQUEST, PITR enabled) | State locking - prevents two `apply`s from corrupting state |

Both have `prevent_destroy = true`. Losing them strands your live infra from OpenTofu.

## Usage

```bash
cd infra/opentofu/aws/bootstrap

tofu init
tofu apply
```

Then paste the output into the main module's `versions.tf`:

```bash
tofu output -raw backend_config
```

```hcl
# infra/opentofu/aws/versions.tf
terraform {
  # ...
  backend "s3" {
    bucket         = "caracal-tf-state-012432678098"
    key            = "caracal/caracal/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "caracal-tf-locks"
    encrypt        = true
  }
}
```

Now `tofu init` (in the main module) will prompt to migrate any existing local state into S3:

```bash
cd ../   # back to infra/opentofu/aws
tofu init -migrate-state
```

## State of this module's own state

Local. That's intentional. Bootstrapping the state backend can't itself live in the state backend. Commit the resulting `terraform.tfstate` for the bootstrap module to a private location, or treat the resources as one-shot infrastructure you'll never re-apply.

## Variables

| Name | Default | Notes |
|---|---|---|
| `region` | `us-east-1` | Pick once; moving the bucket later is painful |
| `name_prefix` | `caracal` | Bucket → `<prefix>-tf-state-<account-id>`; table → `<prefix>-tf-locks` |
