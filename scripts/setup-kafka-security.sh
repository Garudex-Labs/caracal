#!/bin/bash
#
# Setup Kafka Security with SASL/SCRAM and TLS
#
# This script configures Kafka with:
# - TLS encryption for data in transit
# - SASL/SCRAM authentication for client authentication
# - ACLs for topic access control
#
# Requirements:
# - Kafka 2.8+ installed
# - OpenSSL for certificate generation
# - Admin access to Kafka cluster
#

set -e

# Configuration
KAFKA_HOME="${KAFKA_HOME:-/opt/kafka}"
KAFKA_CONFIG_DIR="${KAFKA_CONFIG_DIR:-$KAFKA_HOME/config}"
KAFKA_CERTS_DIR="${KAFKA_CERTS_DIR:-/etc/caracal/kafka/certs}"
KAFKA_BROKER="${KAFKA_BROKER:-localhost:9092}"
KAFKA_ADMIN_USER="${KAFKA_ADMIN_USER:-admin}"
KAFKA_ADMIN_PASSWORD="${KAFKA_ADMIN_PASSWORD:-admin-secret}"
CARACAL_USER="${CARACAL_USER:-caracal_producer}"
CARACAL_PASSWORD="${CARACAL_PASSWORD:-caracal-secret}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Kafka is installed
if [ ! -d "$KAFKA_HOME" ]; then
    log_error "Kafka not found at $KAFKA_HOME"
    log_error "Please set KAFKA_HOME environment variable or install Kafka"
    exit 1
fi

log_info "Setting up Kafka security..."
log_info "Kafka home: $KAFKA_HOME"
log_info "Certificates directory: $KAFKA_CERTS_DIR"

# Create certificates directory
mkdir -p "$KAFKA_CERTS_DIR"
cd "$KAFKA_CERTS_DIR"

# Step 1: Generate CA certificate
log_info "Step 1: Generating CA certificate..."
if [ ! -f "ca.key" ]; then
    openssl req -new -x509 -keyout ca.key -out ca.crt -days 365 -nodes \
        -subj "/CN=Caracal-Kafka-CA/O=Caracal/C=US"
    log_info "CA certificate generated: ca.crt"
else
    log_warn "CA certificate already exists, skipping generation"
fi

# Step 2: Generate Kafka broker certificate
log_info "Step 2: Generating Kafka broker certificate..."
if [ ! -f "kafka-broker.keystore.jks" ]; then
    # Generate keystore
    keytool -genkey -keystore kafka-broker.keystore.jks -validity 365 -storepass kafka-broker-pass \
        -keypass kafka-broker-pass -dname "CN=kafka-broker" -storetype pkcs12 -keyalg RSA
    
    # Generate certificate signing request
    keytool -keystore kafka-broker.keystore.jks -certreq -file kafka-broker.csr \
        -storepass kafka-broker-pass -keypass kafka-broker-pass
    
    # Sign certificate with CA
    openssl x509 -req -CA ca.crt -CAkey ca.key -in kafka-broker.csr \
        -out kafka-broker.crt -days 365 -CAcreateserial
    
    # Import CA certificate into keystore
    keytool -keystore kafka-broker.keystore.jks -alias CARoot -import -file ca.crt \
        -storepass kafka-broker-pass -noprompt
    
    # Import signed certificate into keystore
    keytool -keystore kafka-broker.keystore.jks -import -file kafka-broker.crt \
        -storepass kafka-broker-pass -noprompt
    
    # Create truststore
    keytool -keystore kafka-broker.truststore.jks -alias CARoot -import -file ca.crt \
        -storepass kafka-broker-pass -noprompt
    
    log_info "Kafka broker certificate generated"
else
    log_warn "Kafka broker keystore already exists, skipping generation"
fi

# Step 3: Generate client certificate for Caracal
log_info "Step 3: Generating client certificate for Caracal..."
if [ ! -f "caracal-client.key" ]; then
    # Generate client private key
    openssl genrsa -out caracal-client.key 2048
    
    # Generate certificate signing request
    openssl req -new -key caracal-client.key -out caracal-client.csr \
        -subj "/CN=caracal-client/O=Caracal/C=US"
    
    # Sign certificate with CA
    openssl x509 -req -CA ca.crt -CAkey ca.key -in caracal-client.csr \
        -out caracal-client.crt -days 365 -CAcreateserial
    
    log_info "Client certificate generated: caracal-client.crt"
else
    log_warn "Client certificate already exists, skipping generation"
fi

# Step 4: Configure SASL/SCRAM users
log_info "Step 4: Configuring SASL/SCRAM users..."

# Create JAAS configuration file for Kafka broker
cat > "$KAFKA_CONFIG_DIR/kafka_server_jaas.conf" <<EOF
KafkaServer {
    org.apache.kafka.common.security.scram.ScramLoginModule required
    username="$KAFKA_ADMIN_USER"
    password="$KAFKA_ADMIN_PASSWORD";
};
EOF

log_info "JAAS configuration created: $KAFKA_CONFIG_DIR/kafka_server_jaas.conf"

# Create SCRAM credentials (requires Kafka to be running)
log_info "Creating SCRAM credentials..."
log_warn "Note: Kafka must be running to create SCRAM credentials"
log_warn "Run the following commands after starting Kafka:"
echo ""
echo "# Create admin user"
echo "$KAFKA_HOME/bin/kafka-configs.sh --bootstrap-server $KAFKA_BROKER \\"
echo "  --alter --add-config 'SCRAM-SHA-512=[password=$KAFKA_ADMIN_PASSWORD]' \\"
echo "  --entity-type users --entity-name $KAFKA_ADMIN_USER"
echo ""
echo "# Create Caracal user"
echo "$KAFKA_HOME/bin/kafka-configs.sh --bootstrap-server $KAFKA_BROKER \\"
echo "  --alter --add-config 'SCRAM-SHA-512=[password=$CARACAL_PASSWORD]' \\"
echo "  --entity-type users --entity-name $CARACAL_USER"
echo ""

# Step 5: Configure Kafka broker properties
log_info "Step 5: Configuring Kafka broker properties..."

# Backup existing server.properties
if [ -f "$KAFKA_CONFIG_DIR/server.properties" ]; then
    cp "$KAFKA_CONFIG_DIR/server.properties" "$KAFKA_CONFIG_DIR/server.properties.backup"
    log_info "Backed up existing server.properties"
fi

# Add security configuration to server.properties
cat >> "$KAFKA_CONFIG_DIR/server.properties" <<EOF

# Security Configuration (added by setup-kafka-security.sh)
listeners=SASL_SSL://0.0.0.0:9093
advertised.listeners=SASL_SSL://localhost:9093
security.inter.broker.protocol=SASL_SSL
sasl.mechanism.inter.broker.protocol=SCRAM-SHA-512
sasl.enabled.mechanisms=SCRAM-SHA-512

# SSL Configuration
ssl.keystore.location=$KAFKA_CERTS_DIR/kafka-broker.keystore.jks
ssl.keystore.password=kafka-broker-pass
ssl.key.password=kafka-broker-pass
ssl.truststore.location=$KAFKA_CERTS_DIR/kafka-broker.truststore.jks
ssl.truststore.password=kafka-broker-pass
ssl.client.auth=none

# SASL Configuration
sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required \\
    username="$KAFKA_ADMIN_USER" \\
    password="$KAFKA_ADMIN_PASSWORD";

# ACL Configuration
authorizer.class.name=kafka.security.authorizer.AclAuthorizer
super.users=User:$KAFKA_ADMIN_USER
allow.everyone.if.no.acl.found=false
EOF

log_info "Kafka broker properties updated"

# Step 6: Create ACLs for Caracal topics
log_info "Step 6: Creating ACLs for Caracal topics..."
log_warn "Run the following commands after starting Kafka with security enabled:"
echo ""
echo "# Grant Caracal user access to topics"
echo "$KAFKA_HOME/bin/kafka-acls.sh --bootstrap-server $KAFKA_BROKER \\"
echo "  --command-config <(cat <<EOFCONFIG"
echo "security.protocol=SASL_SSL"
echo "sasl.mechanism=SCRAM-SHA-512"
echo "sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username=\"$KAFKA_ADMIN_USER\" password=\"$KAFKA_ADMIN_PASSWORD\";"
echo "ssl.truststore.location=$KAFKA_CERTS_DIR/kafka-broker.truststore.jks"
echo "ssl.truststore.password=kafka-broker-pass"
echo "EOFCONFIG"
echo "  ) \\"
echo "  --add --allow-principal User:$CARACAL_USER \\"
echo "  --operation All --topic 'caracal.*'"
echo ""
echo "# Grant Caracal user access to consumer groups"
echo "$KAFKA_HOME/bin/kafka-acls.sh --bootstrap-server $KAFKA_BROKER \\"
echo "  --command-config <(cat <<EOFCONFIG"
echo "security.protocol=SASL_SSL"
echo "sasl.mechanism=SCRAM-SHA-512"
echo "sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username=\"$KAFKA_ADMIN_USER\" password=\"$KAFKA_ADMIN_PASSWORD\";"
echo "ssl.truststore.location=$KAFKA_CERTS_DIR/kafka-broker.truststore.jks"
echo "ssl.truststore.password=kafka-broker-pass"
echo "EOFCONFIG"
echo "  ) \\"
echo "  --add --allow-principal User:$CARACAL_USER \\"
echo "  --operation All --group 'caracal-*'"
echo ""

# Step 7: Create Caracal configuration file
log_info "Step 7: Creating Caracal configuration file..."

cat > "$KAFKA_CERTS_DIR/caracal-kafka.yaml" <<EOF
kafka:
  brokers:
    - localhost:9093
  security_protocol: SASL_SSL
  sasl_mechanism: SCRAM-SHA-512
  sasl_username: $CARACAL_USER
  sasl_password: \${KAFKA_PASSWORD}  # Set KAFKA_PASSWORD environment variable
  ssl_ca_location: $KAFKA_CERTS_DIR/ca.crt
  ssl_cert_location: $KAFKA_CERTS_DIR/caracal-client.crt
  ssl_key_location: $KAFKA_CERTS_DIR/caracal-client.key
  producer:
    acks: all
    retries: 3
    max_in_flight_requests: 5
    compression_type: snappy
    enable_idempotence: true
    transactional_id_prefix: "caracal-producer"
  consumer:
    auto_offset_reset: earliest
    enable_auto_commit: false
    isolation_level: read_committed
    max_poll_records: 500
    session_timeout_ms: 30000
    enable_idempotence: true
    transactional_id_prefix: "caracal-consumer"
  processing:
    guarantee: exactly_once
    enable_transactions: true
    idempotency_check: true
EOF

log_info "Caracal Kafka configuration created: $KAFKA_CERTS_DIR/caracal-kafka.yaml"

# Summary
log_info ""
log_info "========================================="
log_info "Kafka Security Setup Complete!"
log_info "========================================="
log_info ""
log_info "Generated files:"
log_info "  - CA certificate: $KAFKA_CERTS_DIR/ca.crt"
log_info "  - Broker keystore: $KAFKA_CERTS_DIR/kafka-broker.keystore.jks"
log_info "  - Broker truststore: $KAFKA_CERTS_DIR/kafka-broker.truststore.jks"
log_info "  - Client certificate: $KAFKA_CERTS_DIR/caracal-client.crt"
log_info "  - Client private key: $KAFKA_CERTS_DIR/caracal-client.key"
log_info "  - Caracal config: $KAFKA_CERTS_DIR/caracal-kafka.yaml"
log_info ""
log_info "Next steps:"
log_info "1. Start Kafka with security enabled:"
log_info "   export KAFKA_OPTS=\"-Djava.security.auth.login.config=$KAFKA_CONFIG_DIR/kafka_server_jaas.conf\""
log_info "   $KAFKA_HOME/bin/kafka-server-start.sh $KAFKA_CONFIG_DIR/server.properties"
log_info ""
log_info "2. Create SCRAM credentials (see commands above)"
log_info ""
log_info "3. Create ACLs for Caracal topics (see commands above)"
log_info ""
log_info "4. Set environment variable for Caracal:"
log_info "   export KAFKA_PASSWORD=\"$CARACAL_PASSWORD\""
log_info ""
log_info "5. Merge $KAFKA_CERTS_DIR/caracal-kafka.yaml into your Caracal config"
log_info ""
log_warn "IMPORTANT: Keep the passwords and private keys secure!"
log_warn "Consider using a secrets management system in production."
