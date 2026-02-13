# Gateway Deployment

The Caracal Gateway is a high-performance proxy that enforces mandates on every request without requiring code changes in your application. It sits between your clients and your API.

## Why Use the Gateway?

-   **Zero Code Changes**: Add authority enforcement to legacy or third-party APIs.
-   **Centralized Enforcement**: Ensure all traffic passes through a single point of policy control.
-   **Protocol Support**: Supports HTTP/1.1, HTTP/2, and gRPC.

## Deployment Options

### Using Docker

The easiest way to deploy the Gateway is using Docker.

```bash
docker run -p 8080:8080 \
  -e UPSTREAM_URL=http://host.docker.internal:3000 \
  -e CARACAL_URL=https://your-enterprise-instance.com \
  -e GATEWAY_API_KEY=your-api-key \
  caracal/gateway:latest
```

### Using CLI

You can also run the Gateway directly using the Caracal CLI.

```bash
caracal gateway start \
  --port 8080 \
  --upstream http://localhost:3000 \
  --authority-url https://your-enterprise-instance.com \
  --api-key your-api-key
```

## Configuration

Configure the Gateway using environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | The port the Gateway listens on. | `8080` |
| `UPSTREAM_URL` | The URL of the service being protected. | Required |
| `CARACAL_URL` | The URL of your Caracal Enterprise instance. | Required |
| `GATEWAY_API_KEY` | API Key for authenticating the Gateway. | Required |
| `CACHE_TTL` | Time in seconds for caching policy decisions. | `60` |

## Verifying Deployment

Once deployed, the Gateway will appear in your Enterprise Dashboard under **Gateways**. You can monitor its status, traffic, and error rates in real-time.
