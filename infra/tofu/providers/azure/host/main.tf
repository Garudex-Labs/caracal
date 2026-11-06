# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Azure adapter for the Caracal host contract: one VM, its network exposure, its identity, and its DNS names.

terraform {
  required_version = ">= 1.8.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.12"
    }
  }
}

locals {
  # DNS records are created relative to the zone, so the zone suffix is trimmed
  # from each fully qualified name the caller supplied.
  records   = { for host in var.hostnames : host => trimsuffix(trimsuffix(host, var.dnsZone), ".") }
  dnsZoneRg = var.dnsZoneResourceGroupName != "" ? var.dnsZoneResourceGroupName : var.resourceGroupName

  # A team with an existing network supplies a subnet; otherwise the adapter
  # creates a minimal one so a first deployment needs no prior setup.
  createNetwork = var.subnetId == ""
  subnetId      = local.createNetwork ? azurerm_subnet.caracal[0].id : var.subnetId
}

resource "azurerm_virtual_network" "caracal" {
  count = local.createNetwork ? 1 : 0

  name                = "${var.name}-network"
  resource_group_name = var.resourceGroupName
  location            = var.region
  address_space       = [var.networkCidr]
  tags                = var.tags
}

resource "azurerm_subnet" "caracal" {
  count = local.createNetwork ? 1 : 0

  name                 = "${var.name}-subnet"
  resource_group_name  = var.resourceGroupName
  virtual_network_name = azurerm_virtual_network.caracal[0].name
  address_prefixes     = [cidrsubnet(var.networkCidr, 8, 0)]
}

resource "azurerm_network_security_group" "caracal" {
  name                = "${var.name}-security"
  resource_group_name = var.resourceGroupName
  location            = var.region
  tags                = var.tags

  # 80 stays open alongside 443 because the host's certificate issuance answers
  # the ACME challenge over plain HTTP before any certificate exists.
  security_rule {
    name                       = "https"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["80", "443"]
    source_address_prefixes    = var.ingressCidrs
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "admin"
    priority                   = 200
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.adminCidrs
    destination_address_prefix = "*"
  }
}

# Bound to the interface rather than the subnet, so attaching to an existing
# network never changes rules for anything else already in that subnet.
resource "azurerm_network_interface_security_group_association" "caracal" {
  network_interface_id      = azurerm_network_interface.caracal.id
  network_security_group_id = azurerm_network_security_group.caracal.id
}

resource "azurerm_public_ip" "caracal" {
  name                = "${var.name}-address"
  resource_group_name = var.resourceGroupName
  location            = var.region
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = var.zone == "" ? null : [var.zone]
  tags                = var.tags
}

resource "azurerm_network_interface" "caracal" {
  name                           = "${var.name}-interface"
  resource_group_name            = var.resourceGroupName
  location                       = var.region
  accelerated_networking_enabled = var.acceleratedNetworking
  tags                           = var.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = local.subnetId
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.caracal.id
  }
}

resource "azurerm_user_assigned_identity" "caracal" {
  name                = "${var.name}-identity"
  resource_group_name = var.resourceGroupName
  location            = var.region
  tags                = var.tags
}

resource "azurerm_linux_virtual_machine" "caracal" {
  name                            = var.name
  resource_group_name             = var.resourceGroupName
  location                        = var.region
  size                            = var.machineSize
  zone                            = var.zone == "" ? null : var.zone
  admin_username                  = var.adminUsername
  network_interface_ids           = [azurerm_network_interface.caracal.id]
  disable_password_authentication = true
  custom_data                     = base64encode(var.userData)
  encryption_at_host_enabled      = var.encryptionAtHost
  tags                            = var.tags

  admin_ssh_key {
    username   = var.adminUsername
    public_key = var.adminPublicKey
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.caracal.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = var.diskType
    disk_size_gb         = var.diskGb
  }

  # A specific image ID wins when given; otherwise the published Ubuntu LTS
  # image the bootstrap is written against.
  dynamic "source_image_reference" {
    for_each = var.sourceImageId == "" ? [1] : []
    content {
      publisher = var.osImage.publisher
      offer     = var.osImage.offer
      sku       = var.osImage.sku
      version   = var.osImage.version
    }
  }

  source_image_id = var.sourceImageId == "" ? null : var.sourceImageId

  # Serial console and screenshots are the only way to diagnose a host that
  # fails before cloud-init can report anything.
  boot_diagnostics {}
}

resource "azurerm_dns_a_record" "caracal" {
  for_each = var.dnsZone == "" ? {} : local.records

  name                = each.value == "" ? "@" : each.value
  zone_name           = var.dnsZone
  resource_group_name = local.dnsZoneRg
  ttl                 = var.dnsTtl
  records             = [azurerm_public_ip.caracal.ip_address]
  tags                = var.tags
}
