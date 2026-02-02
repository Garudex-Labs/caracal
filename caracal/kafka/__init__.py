"""
Kafka event streaming components for Caracal Core v0.3.

This module provides Kafka producers and consumers for event-driven architecture.
"""

from caracal.kafka.producer import (
    KafkaEventProducer,
    KafkaConfig,
    ProducerConfig,
    MeteringEvent,
    PolicyDecisionEvent,
    AgentLifecycleEvent,
    PolicyChangeEvent,
)

from caracal.kafka.consumer import (
    BaseKafkaConsumer,
    ConsumerConfig,
    KafkaMessage,
)

__all__ = [
    "KafkaEventProducer",
    "KafkaConfig",
    "ProducerConfig",
    "MeteringEvent",
    "PolicyDecisionEvent",
    "AgentLifecycleEvent",
    "PolicyChangeEvent",
    "BaseKafkaConsumer",
    "ConsumerConfig",
    "KafkaMessage",
]
