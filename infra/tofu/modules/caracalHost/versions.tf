# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Toolchain contract for the caracalHost module. The module renders cloud-init
# user data only, so it requires no providers and stays attachable to any VM
# resource on any cloud or hypervisor.

terraform {
  required_version = ">= 1.8.0"
}
