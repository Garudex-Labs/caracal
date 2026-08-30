# SPDX-FileCopyrightText: 2026 Ryan Madhuwala <rawx18.dev@gmail.com>
# SPDX-License-Identifier: Apache-2.0

variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "name_prefix" {
  type    = string
  default = "caracal"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "domain_name" {
  type    = string
  default = ""
}

variable "dns_managed_zone_name" {
  type    = string
  default = ""
}
