"""
CLI commands for Dead Letter Queue (DLQ) monitoring.

Provides commands for listing and monitoring DLQ events.

Requirements: 15.3
"""

import sys
from datetime import datetime
from typing import Optional

import click
from confluent_kafka import Consumer, KafkaError

from caracal.kafka.dlq import DLQEvent
from caracal.logging_config import get_logger

logger = get_logger(__name__)


@click.group(name='dlq')
def dlq_group():
    """
    Monitor and manage dead letter queue events.
    
    Commands for viewing failed events that were sent to the DLQ.
    
    Note: Advanced DLQ features (retry, purge, custom retention) are available
    in Caracal Enterprise.
    """
    pass


@dlq_group.command(name='list')
@click.option(
    '--limit',
    '-n',
    type=int,
    default=100,
    help='Maximum number of DLQ events to display (default: 100)',
)
@click.option(
    '--filter-by-error',
    '-e',
    type=str,
    default=None,
    help='Filter by error type (e.g., SchemaValidationError)',
)
@click.option(
    '--filter-by-topic',
    '-t',
    type=str,
    default=None,
    help='Filter by original topic',
)
@click.option(
    '--filter-by-consumer-group',
    '-g',
    type=str,
    default=None,
    help='Filter by consumer group',
)
@click.option(
    '--start-time',
    '-s',
    type=str,
    default=None,
    help='Filter by start time (ISO format: YYYY-MM-DDTHH:MM:SS)',
)
@click.option(
    '--end-time',
    '-E',
    type=str,
    default=None,
    help='Filter by end time (ISO format: YYYY-MM-DDTHH:MM:SS)',
)
@click.option(
    '--verbose',
    '-v',
    is_flag=True,
    help='Show full event details including original value',
)
@click.pass_obj
def list_dlq_events(
    ctx,
    limit: int,
    filter_by_error: Optional[str],
    filter_by_topic: Optional[str],
    filter_by_consumer_group: Optional[str],
    start_time: Optional[str],
    end_time: Optional[str],
    verbose: bool,
):
    """
    List dead letter queue events.
    
    Displays DLQ events with details including error messages, timestamps,
    and original event information. Supports filtering by error type,
    topic, consumer group, and time range.
    
    Examples:
        caracal dlq list
        caracal dlq list --limit 50
        caracal dlq list --filter-by-error SchemaValidationError
        caracal dlq list --filter-by-topic caracal.metering.events
        caracal dlq list --start-time 2024-01-01T00:00:00
        caracal dlq list --verbose
    """
    try:
        # Parse time filters if provided
        start_datetime = None
        end_datetime = None
        
        if start_time:
            try:
                start_datetime = datetime.fromisoformat(start_time)
            except ValueError:
                click.echo(f"✗ Error: Invalid start time format: {start_time}", err=True)
                click.echo("Use ISO format: YYYY-MM-DDTHH:MM:SS", err=True)
                sys.exit(1)
        
        if end_time:
            try:
                end_datetime = datetime.fromisoformat(end_time)
            except ValueError:
                click.echo(f"✗ Error: Invalid end time format: {end_time}", err=True)
                click.echo("Use ISO format: YYYY-MM-DDTHH:MM:SS", err=True)
                sys.exit(1)
        
        # Build consumer configuration
        consumer_conf = {
            'bootstrap.servers': ','.join(ctx.config.kafka.brokers),
            'group.id': 'dlq-cli-reader',
            'auto.offset.reset': 'earliest',
            'enable.auto.commit': False,
        }
        
        # Add security configuration if present
        if hasattr(ctx.config.kafka, 'security_protocol'):
            consumer_conf['security.protocol'] = ctx.config.kafka.security_protocol
        
        if hasattr(ctx.config.kafka, 'sasl_mechanism') and ctx.config.kafka.sasl_mechanism:
            consumer_conf['sasl.mechanism'] = ctx.config.kafka.sasl_mechanism
            if hasattr(ctx.config.kafka, 'sasl_username'):
                consumer_conf['sasl.username'] = ctx.config.kafka.sasl_username
            if hasattr(ctx.config.kafka, 'sasl_password'):
                consumer_conf['sasl.password'] = ctx.config.kafka.sasl_password
        
        if hasattr(ctx.config.kafka, 'ssl_ca_location') and ctx.config.kafka.ssl_ca_location:
            consumer_conf['ssl.ca.location'] = ctx.config.kafka.ssl_ca_location
        if hasattr(ctx.config.kafka, 'ssl_cert_location') and ctx.config.kafka.ssl_cert_location:
            consumer_conf['ssl.certificate.location'] = ctx.config.kafka.ssl_cert_location
        if hasattr(ctx.config.kafka, 'ssl_key_location') and ctx.config.kafka.ssl_key_location:
            consumer_conf['ssl.key.location'] = ctx.config.kafka.ssl_key_location
        
        # Create consumer
        consumer = Consumer(consumer_conf)
        
        # Subscribe to DLQ topic
        consumer.subscribe(['caracal.dlq'])
        
        click.echo("Reading DLQ events...\n")
        
        # Collect events
        events = []
        event_count = 0
        
        try:
            # Poll for messages until we reach the limit or end of topic
            while event_count < limit:
                msg = consumer.poll(timeout=2.0)
                
                if msg is None:
                    # No more messages
                    break
                
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        # End of partition
                        break
                    else:
                        logger.error(f"Kafka error: {msg.error()}")
                        continue
                
                # Deserialize DLQ event
                try:
                    import json
                    dlq_data = json.loads(msg.value().decode('utf-8'))
                    dlq_event = DLQEvent.from_dict(dlq_data)
                    
                    # Apply filters
                    if filter_by_error and dlq_event.error_type != filter_by_error:
                        continue
                    
                    if filter_by_topic and dlq_event.original_topic != filter_by_topic:
                        continue
                    
                    if filter_by_consumer_group and dlq_event.consumer_group != filter_by_consumer_group:
                        continue
                    
                    # Parse failure timestamp for time filtering
                    failure_dt = datetime.fromisoformat(dlq_event.failure_timestamp)
                    
                    if start_datetime and failure_dt < start_datetime:
                        continue
                    
                    if end_datetime and failure_dt > end_datetime:
                        continue
                    
                    # Add to events list
                    events.append(dlq_event)
                    event_count += 1
                
                except Exception as e:
                    logger.error(f"Failed to parse DLQ event: {e}")
                    continue
        
        finally:
            consumer.close()
        
        # Display events
        if not events:
            click.echo("No DLQ events found")
            return
        
        click.echo(f"Found {len(events)} DLQ events:\n")
        
        if verbose:
            # Verbose output with full details
            for i, event in enumerate(events, 1):
                click.echo(f"Event {i}:")
                click.echo(f"  DLQ ID: {event.dlq_id}")
                click.echo(f"  Failure Time: {event.failure_timestamp}")
                click.echo(f"  Original Topic: {event.original_topic}")
                click.echo(f"  Original Partition: {event.original_partition}")
                click.echo(f"  Original Offset: {event.original_offset}")
                click.echo(f"  Consumer Group: {event.consumer_group}")
                click.echo(f"  Error Type: {event.error_type}")
                click.echo(f"  Error Message: {event.error_message}")
                click.echo(f"  Retry Count: {event.retry_count}")
                if event.original_key:
                    click.echo(f"  Original Key: {event.original_key}")
                click.echo(f"  Original Value: {event.original_value[:200]}...")
                click.echo()
        else:
            # Compact table output
            click.echo(f"{'DLQ ID':<38} {'Time':<20} {'Topic':<30} {'Error Type':<25} {'Retries':<8}")
            click.echo("-" * 125)
            
            for event in events:
                # Parse and format timestamp
                failure_dt = datetime.fromisoformat(event.failure_timestamp)
                time_str = failure_dt.strftime("%Y-%m-%d %H:%M:%S")
                
                # Truncate topic if too long
                topic_str = event.original_topic[:28] + ".." if len(event.original_topic) > 30 else event.original_topic
                
                # Truncate error type if too long
                error_str = event.error_type[:23] + ".." if len(event.error_type) > 25 else event.error_type
                
                click.echo(
                    f"{event.dlq_id:<38} "
                    f"{time_str:<20} "
                    f"{topic_str:<30} "
                    f"{error_str:<25} "
                    f"{event.retry_count:<8}"
                )
            
            click.echo(f"\nUse --verbose to see full event details")
        
        # Show summary statistics
        click.echo(f"\nSummary:")
        click.echo(f"  Total events: {len(events)}")
        
        # Count by error type
        error_counts = {}
        for event in events:
            error_counts[event.error_type] = error_counts.get(event.error_type, 0) + 1
        
        click.echo(f"  Error types:")
        for error_type, count in sorted(error_counts.items(), key=lambda x: x[1], reverse=True):
            click.echo(f"    - {error_type}: {count}")
        
    except Exception as e:
        logger.error(f"Failed to list DLQ events: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@dlq_group.command(name='count')
@click.pass_obj
def count_dlq_events(ctx):
    """
    Count total DLQ events.
    
    Displays the total number of events in the dead letter queue.
    
    Example:
        caracal dlq count
    """
    try:
        # Build consumer configuration
        consumer_conf = {
            'bootstrap.servers': ','.join(ctx.config.kafka.brokers),
            'group.id': 'dlq-cli-counter',
            'auto.offset.reset': 'earliest',
            'enable.auto.commit': False,
        }
        
        # Add security configuration if present
        if hasattr(ctx.config.kafka, 'security_protocol'):
            consumer_conf['security.protocol'] = ctx.config.kafka.security_protocol
        
        if hasattr(ctx.config.kafka, 'sasl_mechanism') and ctx.config.kafka.sasl_mechanism:
            consumer_conf['sasl.mechanism'] = ctx.config.kafka.sasl_mechanism
            if hasattr(ctx.config.kafka, 'sasl_username'):
                consumer_conf['sasl.username'] = ctx.config.kafka.sasl_username
            if hasattr(ctx.config.kafka, 'sasl_password'):
                consumer_conf['sasl.password'] = ctx.config.kafka.sasl_password
        
        # Create consumer
        consumer = Consumer(consumer_conf)
        
        # Subscribe to DLQ topic
        consumer.subscribe(['caracal.dlq'])
        
        click.echo("Counting DLQ events...")
        
        # Count messages
        count = 0
        
        try:
            while True:
                msg = consumer.poll(timeout=2.0)
                
                if msg is None:
                    break
                
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        break
                    else:
                        continue
                
                count += 1
        
        finally:
            consumer.close()
        
        click.echo(f"\nTotal DLQ events: {count}")
        
        # Alert if threshold exceeded
        threshold = 1000
        if count >= threshold:
            click.echo(f"\n⚠ WARNING: DLQ size ({count}) exceeds threshold ({threshold})")
            click.echo("Consider investigating and resolving failed events")
        
    except Exception as e:
        logger.error(f"Failed to count DLQ events: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)


@dlq_group.command(name='monitor')
@click.option(
    '--threshold',
    '-t',
    type=int,
    default=1000,
    help='Alert threshold for DLQ size (default: 1000)',
)
@click.pass_obj
def monitor_dlq(ctx, threshold: int):
    """
    Monitor DLQ events in real-time.
    
    Subscribes to the DLQ topic and logs all events as they arrive.
    Alerts when DLQ size exceeds the threshold.
    
    Press Ctrl+C to stop monitoring.
    
    Example:
        caracal dlq monitor
        caracal dlq monitor --threshold 500
    """
    try:
        from caracal.kafka.dlq import DLQMonitorConsumer
        
        click.echo(f"Starting DLQ monitor (threshold: {threshold})...")
        click.echo("Press Ctrl+C to stop\n")
        
        # Create DLQ monitor consumer
        monitor = DLQMonitorConsumer(
            brokers=ctx.config.kafka.brokers,
            consumer_group='dlq-cli-monitor',
            security_protocol=getattr(ctx.config.kafka, 'security_protocol', 'PLAINTEXT'),
            sasl_mechanism=getattr(ctx.config.kafka, 'sasl_mechanism', None),
            sasl_username=getattr(ctx.config.kafka, 'sasl_username', None),
            sasl_password=getattr(ctx.config.kafka, 'sasl_password', None),
            ssl_ca_location=getattr(ctx.config.kafka, 'ssl_ca_location', None),
            ssl_cert_location=getattr(ctx.config.kafka, 'ssl_cert_location', None),
            ssl_key_location=getattr(ctx.config.kafka, 'ssl_key_location', None),
            alert_threshold=threshold,
        )
        
        # Start monitoring (blocking)
        monitor.start()
        
    except KeyboardInterrupt:
        click.echo("\n\nMonitoring stopped")
    except Exception as e:
        logger.error(f"Failed to monitor DLQ: {e}", exc_info=True)
        click.echo(f"✗ Error: {e}", err=True)
        sys.exit(1)
