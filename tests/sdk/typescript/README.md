# TypeScript SDK Tests

## Overview

This directory will contain tests for the Caracal TypeScript/Node.js SDK once it stabilizes.

## Planned Structure

```
typescript/
├── README.md (this file)
├── unit/
│   ├── client.test.ts
│   ├── authority.test.ts
│   ├── mandate.test.ts
│   ├── delegation.test.ts
│   └── secrets.test.ts
└── integration/
    ├── authority-workflow.test.ts
    ├── mandate-workflow.test.ts
    ├── delegation-workflow.test.ts
    └── secrets-workflow.test.ts
```

## Test Framework

- **Framework**: Jest or Vitest
- **Async Support**: Native async/await
- **Mocking**: jest.mock() or vi.mock()
- **Coverage**: Built-in coverage tools
- **HTTP Mocking**: nock or msw (Mock Service Worker)

## Test Guidelines

### Unit Tests

Test SDK client methods in isolation using mocks:

```typescript
import { CaracalClient } from '@caracal/sdk';
import { jest } from '@jest/globals';

describe('CaracalClient', () => {
  describe('initialization', () => {
    it('should initialize with correct config', () => {
      const client = new CaracalClient({
        apiUrl: 'http://localhost:8000',
        apiKey: 'test-key'
      });
      
      expect(client.apiUrl).toBe('http://localhost:8000');
      expect(client.apiKey).toBe('test-key');
    });
    
    it('should use default configuration', () => {
      const client = new CaracalClient();
      
      expect(client.apiUrl).toBeDefined();
      expect(client.timeout).toBeGreaterThan(0);
    });
  });
  
  describe('createAuthority', () => {
    it('should create authority successfully', async () => {
      // Arrange
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'auth-123',
          name: 'test-authority',
          scope: 'read:secrets'
        })
      });
      global.fetch = mockFetch;
      
      const client = new CaracalClient();
      
      // Act
      const authority = await client.createAuthority({
        name: 'test-authority',
        scope: 'read:secrets'
      });
      
      // Assert
      expect(authority.id).toBe('auth-123');
      expect(authority.name).toBe('test-authority');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    
    it('should handle errors gracefully', async () => {
      // Arrange
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid name' })
      });
      global.fetch = mockFetch;
      
      const client = new CaracalClient();
      
      // Act & Assert
      await expect(
        client.createAuthority({ name: '', scope: 'read:secrets' })
      ).rejects.toThrow('Invalid name');
    });
  });
});

describe('AsyncOperations', () => {
  it('should handle concurrent requests', async () => {
    const client = new CaracalClient();
    
    // Mock multiple successful responses
    const mockFetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'auth-1', name: 'authority-1' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'auth-2', name: 'authority-2' })
      });
    global.fetch = mockFetch;
    
    // Act
    const [auth1, auth2] = await Promise.all([
      client.createAuthority({ name: 'authority-1', scope: 'read:secrets' }),
      client.createAuthority({ name: 'authority-2', scope: 'read:secrets' })
    ]);
    
    // Assert
    expect(auth1.id).toBe('auth-1');
    expect(auth2.id).toBe('auth-2');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

### Integration Tests

Test SDK against live Caracal broker:

```typescript
import { CaracalClient } from '@caracal/sdk';

describe('Authority Workflow', () => {
  let client: CaracalClient;

  beforeAll(() => {
    client = new CaracalClient({
      apiUrl: process.env.CARACAL_API_URL || 'http://localhost:8000',
      apiKey: process.env.CARACAL_API_KEY || 'test-key'
    });
  });

  describe('complete lifecycle', () => {
    it('should create, retrieve, and delete authority', async () => {
      // Create authority
      const authority = await client.createAuthority({
        name: 'test-authority',
        scope: 'read:secrets'
      });
      
      expect(authority.id).toBeDefined();
      expect(authority.name).toBe('test-authority');
      
      // Get authority
      const retrieved = await client.getAuthority(authority.id);
      expect(retrieved.id).toBe(authority.id);
      expect(retrieved.name).toBe('test-authority');
      
      // List authorities
      const authorities = await client.listAuthorities();
      expect(authorities.some(a => a.id === authority.id)).toBe(true);
      
      // Delete authority
      await client.deleteAuthority(authority.id);
      
      // Verify deletion
      await expect(
        client.getAuthority(authority.id)
      ).rejects.toThrow();
    });
  });
});

describe('Mandate Workflow', () => {
  let client: CaracalClient;
  let authorityId: string;

  beforeAll(async () => {
    client = new CaracalClient({
      apiUrl: process.env.CARACAL_API_URL || 'http://localhost:8000',
      apiKey: process.env.CARACAL_API_KEY || 'test-key'
    });
    
    // Create test authority
    const authority = await client.createAuthority({
      name: 'test-authority',
      scope: 'read:secrets'
    });
    authorityId = authority.id;
  });

  afterAll(async () => {
    // Cleanup
    await client.deleteAuthority(authorityId);
  });

  it('should complete mandate lifecycle', async () => {
    // Create mandate
    const mandate = await client.createMandate({
      authorityId,
      principalId: 'user-123',
      scope: 'read:secrets'
    });
    
    expect(mandate.id).toBeDefined();
    
    // Verify mandate
    const isValid = await client.verifyMandate(mandate.id);
    expect(isValid).toBe(true);
    
    // Revoke mandate
    await client.revokeMandate(mandate.id);
    
    // Verify revocation
    const isValidAfterRevoke = await client.verifyMandate(mandate.id);
    expect(isValidAfterRevoke).toBe(false);
  });
});
```

## Running Tests

```bash
# Run all TypeScript SDK tests
npm test tests/sdk/typescript/

# Run only unit tests
npm test tests/sdk/typescript/unit/

# Run only integration tests
npm test tests/sdk/typescript/integration/

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch

# Run specific test file
npm test tests/sdk/typescript/unit/client.test.ts
```

## Test Configuration

### Jest Configuration (jest.config.js)

```javascript
export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/sdk/typescript'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90
    }
  }
};
```

### Vitest Configuration (vitest.config.ts)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/sdk/typescript/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      exclude: ['**/*.d.ts', '**/*.test.ts']
    }
  }
});
```

## Environment Setup

Integration tests require:

1. Running Caracal broker:
   ```bash
   docker-compose up -d
   ```

2. Environment variables (.env.test):
   ```
   CARACAL_API_URL=http://localhost:8000
   CARACAL_API_KEY=test-key
   ```

3. Install dependencies:
   ```bash
   npm install --save-dev jest @types/jest ts-jest
   # or
   npm install --save-dev vitest
   ```

## Test Patterns

### Mocking HTTP Requests

Using MSW (Mock Service Worker):

```typescript
import { rest } from 'msw';
import { setupServer } from 'msw/node';

const server = setupServer(
  rest.post('http://localhost:8000/api/v1/authorities', (req, res, ctx) => {
    return res(
      ctx.status(201),
      ctx.json({
        id: 'auth-123',
        name: 'test-authority',
        scope: 'read:secrets'
      })
    );
  })
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

### Testing Error Handling

```typescript
it('should handle network errors', async () => {
  const mockFetch = jest.fn().mockRejectedValue(
    new Error('Network error')
  );
  global.fetch = mockFetch;
  
  const client = new CaracalClient();
  
  await expect(
    client.createAuthority({ name: 'test', scope: 'read:secrets' })
  ).rejects.toThrow('Network error');
});
```

## Status

**Not yet implemented** - SDK is subject to change.
Add tests here once the TypeScript SDK API stabilizes.

## Contributing

When adding tests:
1. Follow TypeScript best practices
2. Use descriptive test names
3. Add JSDoc comments to complex tests
4. Mock external dependencies in unit tests
5. Clean up resources in integration tests
6. Ensure type safety throughout
7. Update this README with new patterns
