#!/usr/bin/env bash
# Generate self-signed TLS certificates for Caracal Services
# For production, use certificates from a trusted CA

set -e

CERTS_DIR="${1:-./certs}"
DAYS_VALID="${2:-365}"

echo "=== Caracal TLS Certificate Generator ==="
echo "Generating self-signed certificates for development..."
echo "Directory: $CERTS_DIR"
echo "Valid for: $DAYS_VALID days"
echo

# Create certs directory if it doesn't exist
mkdir -p "$CERTS_DIR"

# Generate CA private key
echo "1. Generating CA private key..."
openssl genrsa -out "$CERTS_DIR/ca.key" 4096

# Generate CA certificate
echo "2. Generating CA certificate..."
openssl req -new -x509 -days "$DAYS_VALID" -key "$CERTS_DIR/ca.key" -out "$CERTS_DIR/ca.crt" \
  -subj "/C=US/ST=State/L=City/O=Caracal Dev/OU=IT/CN=Caracal CA"

# Generate server private key
echo "3. Generating server private key..."
openssl genrsa -out "$CERTS_DIR/server.key" 4096

# Generate server CSR
echo "4. Generating server certificate signing request..."
  -subj "/C=US/ST=State/L=City/O=Caracal/OU=IT/CN=localhost"

# Generate server certificate
echo "5. Signing server certificate with CA..."
openssl x509 -req -days "$DAYS_VALID" -in "$CERTS_DIR/server.csr" \
  -CA "$CERTS_DIR/ca.crt" -CAkey "$CERTS_DIR/ca.key" -CAcreateserial \
  -out "$CERTS_DIR/server.crt" \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1")

# Generate JWT signing keys (RS256)
echo "6. Generating JWT RSA key pair..."
openssl genrsa -out "$CERTS_DIR/jwt_private.pem" 4096
openssl rsa -pubout -in "$CERTS_DIR/jwt_private.pem" -out "$CERTS_DIR/jwt_public.pem"

# Set permissions
chmod 600 "$CERTS_DIR"/*.key "$CERTS_DIR"/*.pem
chmod 644 "$CERTS_DIR"/*.crt "$CERTS_DIR"/*.csr

# Cleanup CSR
rm -f "$CERTS_DIR/server.csr" "$CERTS_DIR/ca.srl"

echo
echo "✓ Certificates generated successfully!"
echo
echo "Files created:"
echo "  - CA Certificate:       $CERTS_DIR/ca.crt"
echo "  - Server Certificate:   $CERTS_DIR/server.crt"
echo "  - Server Private Key:   $CERTS_DIR/server.key"
echo "  - JWT Private Key:      $CERTS_DIR/jwt_private.pem"
echo "  - JWT Public Key:       $CERTS_DIR/jwt_public.pem"
echo
echo "⚠️  WARNING: These are self-signed certificates for development only!"
echo "    For production, use certificates from a trusted Certificate Authority."
echo
echo "Next steps:"
echo "  1. Start services: docker compose up -d"
echo "  2. Test services: curl -k https://localhost:8443/health"
echo
