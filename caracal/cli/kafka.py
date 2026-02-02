"""
CLI commands for Kafka topic management.

Requirements: 13.7

This module provides commands for managing Kafka topics:
- create-topics: Create all Caracal Core topics
- list-topics: List all topics
- describe-topic: Describe a specific topic
"""

import sys
from typing import Optional

import click

from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name="kafka")
def kafka_group():
    """Kafka topic management commands."""
    pass


@kafka_group.command(name="create-topics")
@click.option(
    "--bootstrap-servers",
    default="localhost:9093",
    help="Kafka bootstrap servers (comma-separated)",
    show_default=True,
)
@click.option(
    "--config-file",
    type=click.Path(exists=True),
    help="Kafka client configuration file (for authentication)",
)
@click.option(
    "--replication-factor",
    type=int,
    default=3,
    help="Replication factor for topics",
    show_default=True,
)
@click.option(
    "--min-insync-replicas",
    type=int,
    default=2,
    help="Minimum in-sync replicas",
    show_default=True,
)
@click.option(
    "--retention-days",
    type=int,
    default=30,
    help="Retention period in days",
    show_default=True,
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Show what would be created without actually creating topics",
)
def create_topics(
    bootstrap_servers: str,
    config_file: Optional[str],
    replication_factor: int,
    min_insync_replicas: int,
    retention_days: int,
    dry_run: bool,
):
    """
    Create all Caracal Core Kafka topics.
    
    Creates the following topics:
    - caracal.metering.events (10 partitions)
    - caracal.policy.decisions (5 partitions)
    - caracal.agent.lifecycle (3 partitions)
    - caracal.policy.changes (3 partitions)
    - caracal.dlq (3 partitions)
    
    All topics are configured with:
    - Replication factor: 3 (configurable)
    - Min in-sync replicas: 2 (configurable)
    - Retention: 30 days (configurable)
    - Compression: snappy
    
    Examples:
        # Create topics with defaults
        caracal kafka create-topics
        
        # Create topics with custom configuration
        caracal kafka create-topics --replication-factor 1 --retention-days 7
        
        # Dry run to see what would be created
        caracal kafka create-topics --dry-run
        
        # Use authentication
        caracal kafka create-topics --config-file kafka-certs/client.properties
    """
    try:
        from kafka.admin import KafkaAdminClient, NewTopic
        from kafka.errors import TopicAlreadyExistsError
    except ImportError:
        click.echo(
            "Error: kafka-python library not installed. "
            "Install with: pip install kafka-python",
            err=True,
        )
        sys.exit(1)
    
    # Topic definitions
    topics = [
        {
            "name": "caracal.metering.events",
            "partitions": 10,
            "description": "Metering events from gateway proxy and MCP adapter",
        },
        {
            "name": "caracal.policy.decisions",
            "partitions": 5,
            "description": "Policy evaluation decisions (allow/deny)",
        },
        {
            "name": "caracal.agent.lifecycle",
            "partitions": 3,
            "description": "Agent lifecycle events (created, updated, deleted)",
        },
        {
            "name": "caracal.policy.changes",
            "partitions": 3,
            "description": "Policy change events for versioning and audit trail",
        },
        {
            "name": "caracal.dlq",
            "partitions": 3,
            "description": "Dead letter queue for failed event processing",
        },
    ]
    
    # Calculate retention in milliseconds
    retention_ms = retention_days * 24 * 60 * 60 * 1000
    
    click.echo("=" * 60)
    click.echo("Kafka Topics Creation")
    click.echo("=" * 60)
    click.echo()
    click.echo(f"Bootstrap servers: {bootstrap_servers}")
    click.echo(f"Replication factor: {replication_factor}")
    click.echo(f"Min in-sync replicas: {min_insync_replicas}")
    click.echo(f"Retention: {retention_days} days")
    click.echo(f"Compression: snappy")
    if dry_run:
        click.echo()
        click.echo("DRY RUN MODE - No topics will be created")
    click.echo()
    
    if dry_run:
        # Just show what would be created
        for topic in topics:
            click.echo(f"Would create topic: {topic['name']}")
            click.echo(f"  Partitions: {topic['partitions']}")
            click.echo(f"  Description: {topic['description']}")
            click.echo()
        return
    
    # Load configuration file if provided
    admin_config = {"bootstrap_servers": bootstrap_servers}
    
    if config_file:
        click.echo(f"Loading configuration from: {config_file}")
        # Parse Kafka properties file
        with open(config_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    if "=" in line:
                        key, value = line.split("=", 1)
                        admin_config[key.strip()] = value.strip()
        click.echo()
    
    try:
        # Create admin client
        click.echo("Connecting to Kafka...")
        admin_client = KafkaAdminClient(**admin_config)
        click.echo("✓ Connected to Kafka")
        click.echo()
        
        # Create topics
        new_topics = []
        for topic in topics:
            topic_config = {
                "min.insync.replicas": str(min_insync_replicas),
                "retention.ms": str(retention_ms),
                "compression.type": "snappy",
                "cleanup.policy": "delete",
            }
            
            new_topic = NewTopic(
                name=topic["name"],
                num_partitions=topic["partitions"],
                replication_factor=replication_factor,
                topic_configs=topic_config,
            )
            new_topics.append(new_topic)
            
            click.echo(f"Creating topic: {topic['name']}")
            click.echo(f"  Partitions: {topic['partitions']}")
            click.echo(f"  Description: {topic['description']}")
        
        # Create all topics
        result = admin_client.create_topics(new_topics, validate_only=False)
        
        # Check results
        click.echo()
        for topic_name, future in result.items():
            try:
                future.result()  # Block until topic is created
                click.echo(f"✓ Topic created: {topic_name}")
            except TopicAlreadyExistsError:
                click.echo(f"⚠ Topic already exists: {topic_name}")
            except Exception as e:
                click.echo(f"✗ Failed to create topic {topic_name}: {e}", err=True)
        
        click.echo()
        click.echo("=" * 60)
        click.echo("Topics created successfully!")
        click.echo("=" * 60)
        
        admin_client.close()
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        logger.error(f"Failed to create Kafka topics: {e}", exc_info=True)
        sys.exit(1)


@kafka_group.command(name="list-topics")
@click.option(
    "--bootstrap-servers",
    default="localhost:9093",
    help="Kafka bootstrap servers (comma-separated)",
    show_default=True,
)
@click.option(
    "--config-file",
    type=click.Path(exists=True),
    help="Kafka client configuration file (for authentication)",
)
@click.option(
    "--filter",
    help="Filter topics by prefix (e.g., 'caracal.')",
)
def list_topics(
    bootstrap_servers: str,
    config_file: Optional[str],
    filter: Optional[str],
):
    """
    List all Kafka topics.
    
    Examples:
        # List all topics
        caracal kafka list-topics
        
        # List only Caracal topics
        caracal kafka list-topics --filter caracal.
        
        # Use authentication
        caracal kafka list-topics --config-file kafka-certs/client.properties
    """
    try:
        from kafka.admin import KafkaAdminClient
    except ImportError:
        click.echo(
            "Error: kafka-python library not installed. "
            "Install with: pip install kafka-python",
            err=True,
        )
        sys.exit(1)
    
    # Load configuration file if provided
    admin_config = {"bootstrap_servers": bootstrap_servers}
    
    if config_file:
        # Parse Kafka properties file
        with open(config_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    if "=" in line:
                        key, value = line.split("=", 1)
                        admin_config[key.strip()] = value.strip()
    
    try:
        # Create admin client
        admin_client = KafkaAdminClient(**admin_config)
        
        # List topics
        topics = admin_client.list_topics()
        
        # Filter topics if requested
        if filter:
            topics = [t for t in topics if t.startswith(filter)]
        
        # Sort topics
        topics = sorted(topics)
        
        click.echo("=" * 60)
        click.echo(f"Kafka Topics ({len(topics)} total)")
        click.echo("=" * 60)
        click.echo()
        
        for topic in topics:
            click.echo(f"  {topic}")
        
        click.echo()
        
        admin_client.close()
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        logger.error(f"Failed to list Kafka topics: {e}", exc_info=True)
        sys.exit(1)


@kafka_group.command(name="describe-topic")
@click.argument("topic")
@click.option(
    "--bootstrap-servers",
    default="localhost:9093",
    help="Kafka bootstrap servers (comma-separated)",
    show_default=True,
)
@click.option(
    "--config-file",
    type=click.Path(exists=True),
    help="Kafka client configuration file (for authentication)",
)
def describe_topic(
    topic: str,
    bootstrap_servers: str,
    config_file: Optional[str],
):
    """
    Describe a specific Kafka topic.
    
    Shows detailed information about a topic including:
    - Number of partitions
    - Replication factor
    - Configuration settings
    - Partition details
    
    Examples:
        # Describe a topic
        caracal kafka describe-topic caracal.metering.events
        
        # Use authentication
        caracal kafka describe-topic caracal.metering.events \\
            --config-file kafka-certs/client.properties
    """
    try:
        from kafka.admin import KafkaAdminClient, ConfigResource, ConfigResourceType
    except ImportError:
        click.echo(
            "Error: kafka-python library not installed. "
            "Install with: pip install kafka-python",
            err=True,
        )
        sys.exit(1)
    
    # Load configuration file if provided
    admin_config = {"bootstrap_servers": bootstrap_servers}
    
    if config_file:
        # Parse Kafka properties file
        with open(config_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    if "=" in line:
                        key, value = line.split("=", 1)
                        admin_config[key.strip()] = value.strip()
    
    try:
        # Create admin client
        admin_client = KafkaAdminClient(**admin_config)
        
        # Get topic metadata
        metadata = admin_client.list_topics()
        
        if topic not in metadata:
            click.echo(f"Error: Topic '{topic}' not found", err=True)
            sys.exit(1)
        
        # Get topic details
        topic_metadata = admin_client.describe_topics([topic])
        
        click.echo("=" * 60)
        click.echo(f"Topic: {topic}")
        click.echo("=" * 60)
        click.echo()
        
        if topic_metadata:
            topic_info = topic_metadata[0]
            
            click.echo(f"Partitions: {len(topic_info['partitions'])}")
            
            # Get replication factor from first partition
            if topic_info['partitions']:
                replication_factor = len(topic_info['partitions'][0]['replicas'])
                click.echo(f"Replication factor: {replication_factor}")
            
            click.echo()
            click.echo("Partition Details:")
            click.echo()
            
            for partition in topic_info['partitions']:
                partition_id = partition['partition']
                leader = partition['leader']
                replicas = partition['replicas']
                isr = partition['isr']
                
                click.echo(f"  Partition {partition_id}:")
                click.echo(f"    Leader: {leader}")
                click.echo(f"    Replicas: {replicas}")
                click.echo(f"    In-Sync Replicas: {isr}")
                click.echo()
        
        # Get topic configuration
        config_resource = ConfigResource(ConfigResourceType.TOPIC, topic)
        configs = admin_client.describe_configs([config_resource])
        
        if configs:
            click.echo("Configuration:")
            click.echo()
            
            for config_key, config_value in configs[0].items():
                if not config_value.is_default:
                    click.echo(f"  {config_key}: {config_value.value}")
            
            click.echo()
        
        admin_client.close()
        
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        logger.error(f"Failed to describe Kafka topic: {e}", exc_info=True)
        sys.exit(1)
