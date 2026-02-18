"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for MCP Adapter Service.

Provides commands to start and manage the MCP adapter standalone service.
"""

import asyncio
import sys
from pathlib import Path

import click

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name="mcp-service")
def mcp_service_group():
    """Manage MCP Adapter Service."""
    pass


@mcp_service_group.command(name="start")
@click.option(
    "--config",
    "-c",
    type=click.Path(exists=True),
    help="Path to configuration file (YAML)",
    envvar="CARACAL_CONFIG_PATH"
)
@click.option(
    "--listen-address",
    "-l",
    type=str,
    default="0.0.0.0:8080",
    help="Listen address (default: 0.0.0.0:8080)",
    envvar="CARACAL_MCP_LISTEN_ADDRESS"
)
def start_service(config, listen_address):
    """
    Start the MCP Adapter Service.
    
    The service can be configured via:
    1. Configuration file (--config or CARACAL_CONFIG_PATH env var)
    2. Environment variables (CARACAL_MCP_*)
    
    Examples:
        # Start with config file
        caracal mcp-service start --config /etc/caracal/config.yaml
        
        # Start with environment variables
        export CARACAL_MCP_LISTEN_ADDRESS="0.0.0.0:8080"
        export CARACAL_MCP_SERVERS='[{"name":"filesystem","url":"http://localhost:9000"}]'
        caracal mcp-service start
    """
    from caracal.mcp.service import (
        MCPAdapterService,
        MCPServiceConfig,
        load_config_from_yaml,
        load_config_from_env,
        main as service_main
    )
    
    try:
        logger.info("Starting MCP Adapter Service...")
        
        # Run the service
        asyncio.run(service_main())
        
    except KeyboardInterrupt:
        logger.info("Service stopped by user")
        sys.exit(0)
    except Exception as e:
        logger.error(f"Failed to start MCP Adapter Service: {e}", exc_info=True)
        sys.exit(1)


@mcp_service_group.command(name="health")
@click.option(
    "--url",
    "-u",
    type=str,
    default="http://localhost:8080",
    help="Service URL (default: http://localhost:8080)"
)
def check_health(url):
    """
    Check health of running MCP Adapter Service.
    
    Examples:
        caracal mcp-service health
        caracal mcp-service health --url http://localhost:8080
    """
    import httpx
    
    try:
        health_url = f"{url}/health"
        logger.info(f"Checking health at {health_url}...")
        
        response = httpx.get(health_url, timeout=5.0)
        
        if response.status_code == 200:
            data = response.json()
            click.echo(f"✓ Service is {data['status']}")
            click.echo(f"  Version: {data['version']}")
            
            if 'mcp_servers' in data:
                click.echo("\n  MCP Servers:")
                for server_name, server_status in data['mcp_servers'].items():
                    status_icon = "✓" if server_status == "healthy" else "✗"
                    click.echo(f"    {status_icon} {server_name}: {server_status}")
            
            sys.exit(0)
        else:
            click.echo(f"✗ Service returned status {response.status_code}")
            sys.exit(1)
            
    except httpx.ConnectError:
        click.echo(f"✗ Cannot connect to service at {url}")
        sys.exit(1)
    except httpx.TimeoutException:
        click.echo(f"✗ Health check timed out")
        sys.exit(1)
    except Exception as e:
        click.echo(f"✗ Health check failed: {e}")
        sys.exit(1)


@mcp_service_group.command(name="stats")
@click.option(
    "--url",
    "-u",
    type=str,
    default="http://localhost:8080",
    help="Service URL (default: http://localhost:8080)"
)
def get_stats(url):
    """
    Get statistics from running MCP Adapter Service.
    
    Examples:
        caracal mcp-service stats
        caracal mcp-service stats --url http://localhost:8080
    """
    import httpx
    
    try:
        stats_url = f"{url}/stats"
        logger.info(f"Fetching stats from {stats_url}...")
        
        response = httpx.get(stats_url, timeout=5.0)
        
        if response.status_code == 200:
            data = response.json()
            
            click.echo("MCP Adapter Service Statistics")
            click.echo("=" * 40)
            click.echo(f"Total Requests:     {data['requests_total']}")
            click.echo(f"Tool Calls:         {data['tool_calls_total']}")
            click.echo(f"Resource Reads:     {data['resource_reads_total']}")
            click.echo(f"Allowed:            {data['requests_allowed']}")
            click.echo(f"Denied:             {data['requests_denied']}")
            click.echo(f"Errors:             {data['errors_total']}")
            
            if 'mcp_servers' in data:
                click.echo("\nConfigured MCP Servers:")
                for server in data['mcp_servers']:
                    click.echo(f"  - {server['name']}: {server['url']}")
            
            sys.exit(0)
        else:
            click.echo(f"✗ Service returned status {response.status_code}")
            sys.exit(1)
            
    except httpx.ConnectError:
        click.echo(f"✗ Cannot connect to service at {url}")
        sys.exit(1)
    except httpx.TimeoutException:
        click.echo(f"✗ Stats request timed out")
        sys.exit(1)
    except Exception as e:
        click.echo(f"✗ Stats request failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    mcp_service_group()
