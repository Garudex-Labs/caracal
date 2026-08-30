# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

# Remote state stored in Azure Blob Storage.
# The storage account is created out-of-band (see README).
#
# The state key keeps its legacy "terraform.tfstate" name on purpose:
# renaming it would point OpenTofu at an empty state and re-create the stack.

terraform {
  backend "azurerm" {
    resource_group_name  = "caracal-tfstate-rg"
    storage_account_name = "caracaltfstate"
    container_name       = "tfstate"
    key                  = "staging.terraform.tfstate"
  }
}
