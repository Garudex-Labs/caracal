#!/bin/bash
# Deployment script for Caracal Core on Kubernetes
# Requirements: 17.2, 17.4
#
# This script automates the deployment of Caracal Core to Kubernetes.
#
# Usage:
#   ./deploy.sh [options]
#
# Options:
#   --namespace NAME    Kubernetes namespace (default: caracal)
#   --wait              Wait for deployments to be ready
#   --skip-tls          Skip TLS certificate creation
#   --dry-run           Show what would be deployed without applying
#   --help              Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
NAMESPACE="caracal"
WAIT=false
SKIP_TLS=false
DRY_RUN=false

# Read version from VERSION file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="$SCRIPT_DIR/../VERSION"
if [ -f "$VERSION_FILE" ]; then
    CARACAL_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
else
    CARACAL_VERSION="unknown"
fi

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --wait)
      WAIT=true
      shift
      ;;
    --skip-tls)
      SKIP_TLS=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      grep "^#" "$0" | grep -v "#!/bin/bash" | sed 's/^# //'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Function to print colored messages
print_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Check prerequisites
print_info "Checking prerequisites..."

if ! command_exists kubectl; then
  print_error "kubectl is not installed. Please install kubectl first."
  exit 1
fi

if ! command_exists openssl; then
  print_error "openssl is not installed. Please install openssl first."
  exit 1
fi

print_success "Prerequisites check passed"

# Check kubectl connection
print_info "Checking Kubernetes cluster connection..."
if ! kubectl cluster-info >/dev/null 2>&1; then
  print_error "Cannot connect to Kubernetes cluster. Please check your kubeconfig."
  exit 1
fi

CLUSTER_NAME=$(kubectl config current-context)
print_success "Connected to cluster: $CLUSTER_NAME"

# Create TLS certificates if needed
if [ "$SKIP_TLS" = false ]; then
  print_info "Checking TLS certificates..."
  
  if [ ! -d "certs" ]; then
    print_warning "TLS certificates not found. Creating self-signed certificates for testing..."
    mkdir -p certs
    
    # Generate server certificate
    openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
    
    # Generate CA certificate
    openssl req -x509 -newkey rsa:4096 -keyout certs/ca.key -out certs/ca.crt \
      -days 365 -nodes -subj "/CN=caracal-ca" >/dev/null 2>&1
    
    # Generate JWT keys
    ssh-keygen -t rsa -b 4096 -m PEM -f certs/jwt_private.pem -N "" >/dev/null 2>&1
    openssl rsa -in certs/jwt_private.pem -pubout -out certs/jwt_public.pem >/dev/null 2>&1
    
    print_success "Self-signed certificates created in ./certs/"
    print_warning "These are for TESTING ONLY. Use proper certificates in production!"
  else
    print_success "TLS certificates found in ./certs/"
  fi
fi

# Dry run mode
if [ "$DRY_RUN" = true ]; then
  print_info "DRY RUN MODE - No changes will be applied"
  KUBECTL_CMD="kubectl apply --dry-run=client"
else
  KUBECTL_CMD="kubectl apply"
fi

# Deploy to Kubernetes
print_info "Deploying Caracal Core v${CARACAL_VERSION} to namespace: $NAMESPACE"
echo ""

# Step 1: Create namespace
print_info "Step 1/6: Creating namespace..."
$KUBECTL_CMD -f namespace.yaml
print_success "Namespace created"
echo ""

# Step 2: Create ConfigMap
print_info "Step 2/6: Creating ConfigMap..."
$KUBECTL_CMD -f configmap.yaml
print_success "ConfigMap created"
echo ""

# Step 3: Create Secrets
print_info "Step 3/6: Creating Secrets..."

# Create TLS secret from files if not in dry-run mode
if [ "$DRY_RUN" = false ] && [ "$SKIP_TLS" = false ]; then
  if kubectl get secret caracal-tls -n "$NAMESPACE" >/dev/null 2>&1; then
    print_warning "TLS secret already exists, skipping creation"
  else
    kubectl create secret generic caracal-tls \
      --from-file=server.crt=certs/server.crt \
      --from-file=server.key=certs/server.key \
      --from-file=ca.crt=certs/ca.crt \
      --from-file=jwt_public.pem=certs/jwt_public.pem \
      --namespace="$NAMESPACE"
    print_success "TLS secret created"
  fi
fi

# Create database password secret
$KUBECTL_CMD -f secret.yaml
print_success "Secrets created"
echo ""

# Step 4: Deploy PostgreSQL
print_info "Step 4/6: Deploying PostgreSQL..."
$KUBECTL_CMD -f postgres-statefulset.yaml
print_success "PostgreSQL deployed"

if [ "$WAIT" = true ] && [ "$DRY_RUN" = false ]; then
  print_info "Waiting for PostgreSQL to be ready..."
  kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=database \
    -n "$NAMESPACE" --timeout=300s
  print_success "PostgreSQL is ready"
fi
echo ""

# Step 5: Deploy Gateway Proxy
print_info "Step 5/6: Deploying Gateway Proxy..."
print_success "Gateway Proxy deployed"

if [ "$WAIT" = true ] && [ "$DRY_RUN" = false ]; then
  print_info "Waiting for Gateway Proxy to be ready..."
    -n "$NAMESPACE" --timeout=300s
  print_success "Gateway Proxy is ready"
fi
echo ""

# Step 6: Deploy MCP Adapter
print_info "Step 6/6: Deploying MCP Adapter..."
$KUBECTL_CMD -f mcp-adapter-deployment.yaml
print_success "MCP Adapter deployed"

if [ "$WAIT" = true ] && [ "$DRY_RUN" = false ]; then
  print_info "Waiting for MCP Adapter to be ready..."
  kubectl wait --for=condition=available deployment/caracal-mcp-adapter \
    -n "$NAMESPACE" --timeout=300s
  print_success "MCP Adapter is ready"
fi
echo ""

# Deployment summary
print_success "Deployment complete!"
echo ""
print_info "Deployment Summary:"
echo "  Namespace: $NAMESPACE"
echo "  Cluster: $CLUSTER_NAME"
echo ""

if [ "$DRY_RUN" = false ]; then
  print_info "Checking deployment status..."
  kubectl get pods -n "$NAMESPACE"
  echo ""
  kubectl get svc -n "$NAMESPACE"
  echo ""
  
  print_info "Next steps:"
  echo "  1. Check pod status: kubectl get pods -n $NAMESPACE"
  echo "  2. View logs: kubectl logs -n $NAMESPACE -l app.kubernetes.io/name=caracal -f"
  echo "  4. Test health: curl -k https://<gateway-ip>:8443/health"
  echo ""
  print_info "To initialize the database:"
  echo "  kubectl port-forward -n $NAMESPACE svc/caracal-postgres 5432:5432"
  echo "  caracal db init"
  echo "  caracal db migrate up"
else
  print_info "This was a dry run. No changes were applied."
  print_info "Run without --dry-run to apply changes."
fi
