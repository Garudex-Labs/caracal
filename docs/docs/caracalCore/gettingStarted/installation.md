---
sidebar_position: 2
title: Installation
---

# Installation

This guide covers installing Caracal Core and its dependencies.

## Prerequisites

- **Python 3.10+**
- **Docker** and **Docker Compose** (for containerized deployment)
- **PostgreSQL 14+** (database)
- **Redis 7+** (optional, for real-time metrics)
- **Kafka** (optional, for event-driven architecture)

## Installation Methods

### Option 1: pip (Development)

```bash
pip install caracal-core
```

### Option 2: Docker (Recommended)

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
docker-compose up -d
```

### Option 3: From Source

```bash
git clone https://github.com/Garudex-Labs/Caracal.git
cd Caracal
pip install -e .
```

## Verifying Installation

```bash
caracal --version
```

## Next Steps

- [Quickstart](./quickstart): Deploy and test in 5 minutes.
