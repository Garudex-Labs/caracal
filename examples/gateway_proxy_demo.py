#!/usr/bin/env python3
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

[One-sentence description of the file's purpose and functionality.]
"""

"""
Demo script for Gateway Proxy server.

This script demonstrates how to set up and run the Gateway Proxy
for network-enforced policy enforcement.

Requirements: 1.1, 1.2, 1.6
"""

import asyncio
import sys
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from caracal.gateway.proxy import GatewayProxy, GatewayConfig
from caracal.gateway.auth import Authenticator, AuthenticationMethod
from caracal.gateway.replay_protection import ReplayProtection, ReplayProtectionConfig
from caracal.core.identity import AgentRegistry
from caracal.core.policy import PolicyStore, PolicyEvaluator
from caracal.core.ledger import LedgerWriter, LedgerQuery
from caracal.core.metering import MeteringCollector
from caracal.core.pricebook import Pricebook
from caracal.config.settings import get_default_config


async def main():
    """
    Main function to set up and run the Gateway Proxy.
    """
    print("=" * 60)
    print("Caracal Gateway Proxy Demo")
    print("=" * 60)
    
    # 1. Load configuration
    print("\n1. Loading configuration...")
    config = get_default_config()
    print(f"   ✓ Configuration loaded")
    
    # 2. Initialize core components
    print("\n2. Initializing core components...")
    
    # Agent Registry
    agent_registry = AgentRegistry(config.storage.agent_registry)
    print(f"   ✓ Agent Registry: {config.storage.agent_registry}")
    
    # Policy Store
    policy_store = PolicyStore(
        config.storage.policy_store,
        agent_registry=agent_registry
    )
    print(f"   ✓ Policy Store: {config.storage.policy_store}")
    
    # Ledger
    ledger_writer = LedgerWriter(config.storage.ledger)
    ledger_query = LedgerQuery(config.storage.ledger)
    print(f"   ✓ Ledger: {config.storage.ledger}")
    
    # Pricebook
    pricebook = Pricebook(config.storage.pricebook)
    print(f"   ✓ Pricebook: {config.storage.pricebook}")
    
    # Metering Collector
    metering_collector = MeteringCollector(pricebook, ledger_writer)
    print(f"   ✓ Metering Collector initialized")
    
    # Policy Evaluator
    policy_evaluator = PolicyEvaluator(policy_store, ledger_query)
    print(f"   ✓ Policy Evaluator initialized")
    
    # 3. Initialize gateway components
    print("\n3. Initializing gateway components...")
    
    # Authenticator
    # For demo, we'll use JWT authentication
    # In production, load JWT public key from file
    jwt_public_key = None  # Set to None for demo (will fail auth, but shows setup)
    
    authenticator = Authenticator(
        agent_registry=agent_registry,
        jwt_public_key=jwt_public_key,
        jwt_algorithm="RS256"
    )
    print(f"   ✓ Authenticator initialized (mode: JWT)")
    
    # Replay Protection
    replay_config = ReplayProtectionConfig(
        nonce_cache_ttl=300,  # 5 minutes
        nonce_cache_size=100000,
        timestamp_window_seconds=300,  # 5 minutes
        enable_nonce_validation=True,
        enable_timestamp_validation=True
    )
    replay_protection = ReplayProtection(replay_config)
    print(f"   ✓ Replay Protection initialized")
    
    # 4. Initialize Gateway Proxy
    print("\n4. Initializing Gateway Proxy...")
    
    gateway_config = GatewayConfig(
        listen_address="0.0.0.0:8443",
        tls_cert_file=None,  # Set to cert path for TLS
        tls_key_file=None,   # Set to key path for TLS
        tls_ca_file=None,    # Set to CA cert path for mTLS
        auth_mode="jwt",
        jwt_public_key=jwt_public_key,
        jwt_algorithm="RS256",
        enable_replay_protection=True,
        nonce_cache_ttl=300,
        nonce_cache_size=100000,
        timestamp_window_seconds=300,
        request_timeout_seconds=30,
        max_request_size_mb=10
    )
    
    gateway = GatewayProxy(
        config=gateway_config,
        authenticator=authenticator,
        policy_evaluator=policy_evaluator,
        metering_collector=metering_collector,
        replay_protection=replay_protection
    )
    print(f"   ✓ Gateway Proxy initialized")
    print(f"   ✓ Listen address: {gateway_config.listen_address}")
    print(f"   ✓ Auth mode: {gateway_config.auth_mode}")
    print(f"   ✓ Replay protection: {gateway_config.enable_replay_protection}")
    
    # 5. Display configuration
    print("\n5. Gateway Configuration:")
    print(f"   - Listen Address: {gateway_config.listen_address}")
    print(f"   - TLS Enabled: {gateway_config.tls_cert_file is not None}")
    print(f"   - mTLS Enabled: {gateway_config.tls_ca_file is not None}")
    print(f"   - Auth Mode: {gateway_config.auth_mode}")
    print(f"   - Replay Protection: {gateway_config.enable_replay_protection}")
    print(f"   - Request Timeout: {gateway_config.request_timeout_seconds}s")
    print(f"   - Max Request Size: {gateway_config.max_request_size_mb}MB")
    
    # 6. Display endpoints
    print("\n6. Available Endpoints:")
    print(f"   - GET  /health       - Health check")
    print(f"   - GET  /stats        - Gateway statistics")
    print(f"   - *    /{{path:path}}  - Proxied requests")
    
    # 7. Display usage instructions
    print("\n7. Usage Instructions:")
    print("   To make a request through the gateway:")
    print("   ")
    print("   curl -X POST https://localhost:8443/api/endpoint \\")
    print("        -H 'Authorization: Bearer <jwt-token>' \\")
    print("        -H 'X-Caracal-Target-URL: https://api.example.com/endpoint' \\")
    print("        -H 'X-Caracal-Nonce: <unique-nonce>' \\")
    print("        -H 'X-Caracal-Timestamp: <unix-timestamp>' \\")
    print("        -H 'Content-Type: application/json' \\")
    print("        -d '{\"data\": \"value\"}'")
    print("   ")
    print("   Required Headers:")
    print("   - Authorization: Bearer <jwt-token>  (for JWT auth)")
    print("   - X-Caracal-Target-URL: <target-api-url>")
    print("   ")
    print("   Optional Headers:")
    print("   - X-Caracal-Nonce: <unique-nonce>  (for replay protection)")
    print("   - X-Caracal-Timestamp: <unix-timestamp>  (for replay protection)")
    print("   - X-Caracal-Estimated-Cost: <decimal>  (for provisional charges)")
    
    print("\n" + "=" * 60)
    print("Gateway Proxy Demo Complete!")
    print("=" * 60)
    print("\nTo start the gateway server, uncomment the line below:")
    print("# await gateway.start()")
    print("\nNote: Configure TLS certificates and JWT keys before production use.")
    
    # Uncomment to actually start the server:
    # print("\nStarting Gateway Proxy server...")
    # await gateway.start()


if __name__ == "__main__":
    asyncio.run(main())
