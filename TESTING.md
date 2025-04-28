# Testing Guidelines for Roomy

This document provides guidelines for creating and running tests in the Roomy project.

## Table of Contents

- [Testing Framework](#testing-framework)
- [Test Directory Structure](#test-directory-structure)
- [Writing Tests](#writing-tests)
  - [Unit Tests](#unit-tests)
  - [Component Tests](#component-tests)
  - [Mocking Dependencies](#mocking-dependencies)
- [Running Tests](#running-tests)
  - [Basic Test Execution](#basic-test-execution)
  - [Running with Coverage](#running-with-coverage)
  - [Watch Mode](#watch-mode)
- [Test Coverage](#test-coverage)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

## Testing Framework

Roomy uses [Vitest](https://vitest.dev/) as the testing framework, which is designed to work seamlessly with Vite and SvelteKit projects. The project also uses:

- [JSDOM](https://github.com/jsdom/jsdom) for browser environment simulation
- [@testing-library/svelte](https://testing-library.com/docs/svelte-testing-library/intro) for component testing
- [@testing-library/user-event](https://testing-library.com/docs/user-event/intro) for simulating user interactions

## Test Directory Structure

Tests should be placed alongside the code they're testing with a `.test.ts` or `.test.js` extension. For Svelte components, use `.svelte.test.ts` to indicate that you're testing a Svelte component.

Example structure:
```
src/
├── lib/
│   ├── components/
│   │   ├── Button.svelte
│   │   └── Button.svelte.test.ts
│   ├── utils.ts
│   └── utils.test.ts
```

## Writing Tests

### Unit Tests

Unit tests should focus on testing individual functions or modules in isolation. Here's a basic example:

```typescript
// src/lib/utils.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from './utils';

describe('myFunction', () => {
  it('should return expected result', () => {
    const result = myFunction(1, 2);
    expect(result).toBe(3);
  });

  it('should handle edge cases', () => {
    expect(myFunction(-1, 1)).toBe(0);
    expect(myFunction(0, 0)).toBe(0);
  });
});
```

### Component Tests

For Svelte components, use the `@testing-library/svelte` package to render and interact with components:

```typescript
// src/lib/components/Button.svelte.test.ts
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import Button from './Button.svelte';

describe('Button', () => {
  it('renders with the correct text', () => {
    const { getByText } = render(Button, { props: { text: 'Click me' } });
    expect(getByText('Click me')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    const { getByText } = render(Button, {
      props: { text: 'Click me', onClick }
    });

    await fireEvent.click(getByText('Click me'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

### Mocking Dependencies

Use Vitest's mocking capabilities to isolate the code being tested:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myFunctionThatUsesFetch } from './api';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

beforeEach(() => {
  vi.resetAllMocks();
  // Default mock implementation
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ data: 'mocked data' })
  });
});

describe('myFunctionThatUsesFetch', () => {
  it('fetches data and processes it', async () => {
    const result = await myFunctionThatUsesFetch();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(/* expected processed data */);
  });
});
```

For Svelte components that use stores or other Svelte-specific features, you'll need to mock those dependencies:

```typescript
// Mock Svelte stores or other dependencies
vi.mock('$lib/stores', () => ({
  myStore: {
    subscribe: vi.fn((callback) => {
      callback({ value: 'mocked value' });
      return () => {}; // Unsubscribe function
    }),
    set: vi.fn()
  }
}));
```

## Running Tests

### Basic Test Execution

To run all tests once:

```bash
npm test
# or
pnpm test
```

### Running with Coverage

To run tests with coverage reporting:

```bash
npm run coverage
# or
pnpm coverage
```

This will generate a coverage report in the `coverage` directory.

#### Viewing Coverage in Browser UI

Vitest provides a browser-based UI for viewing and interacting with test results and coverage reports. To run tests with the UI:

```bash
npx vitest --ui --coverage
```

This launches a web interface in your browser where you can:
- See test results in real-time
- Navigate through your test files
- View detailed coverage information with highlighted source code
- Filter tests and focus on specific test suites
- Re-run individual tests or test suites

The UI provides a more interactive and visual way to understand your test coverage, making it easier to identify areas that need more testing.

### Watch Mode

To run tests in watch mode (tests will re-run when files change):

```bash
npx vitest
# or
npx vitest --ui  # To use the Vitest UI
```

## Test Coverage

The project uses `@vitest/coverage-v8` for generating coverage reports. Coverage reports include:

- Statement coverage: percentage of statements executed
- Branch coverage: percentage of branches (if/else, switch cases) executed
- Function coverage: percentage of functions called
- Line coverage: percentage of lines executed

Aim for high coverage, but focus on testing critical paths and edge cases rather than just increasing coverage numbers.

## Best Practices

1. **Test behavior, not implementation**: Focus on what the code does, not how it does it.

2. **Keep tests isolated**: Each test should run independently of others.

3. **Use descriptive test names**: Test names should clearly describe what is being tested.

4. **Follow the AAA pattern**:
   - Arrange: Set up the test data and conditions
   - Act: Perform the action being tested
   - Assert: Verify the result is as expected

5. **Mock external dependencies**: Use mocks for API calls, databases, etc.

6. **Test edge cases**: Include tests for boundary conditions and error handling.

7. **Keep tests fast**: Slow tests discourage frequent testing.

8. **Use setup and teardown**: Use `beforeEach`, `afterEach`, `beforeAll`, and `afterAll` to avoid repetition.

## Troubleshooting

### Common Issues

1. **Tests failing in CI but passing locally**:
   - Check for environment differences
   - Ensure all dependencies are properly mocked
   - Look for timing issues or race conditions

2. **Mocks not working as expected**:
   - Verify the mock path matches the import path exactly
   - Check that the mock is defined before the module is imported
   - Use `vi.resetAllMocks()` in `beforeEach` to reset mock state

3. **JSDOM limitations**:
   - JSDOM doesn't support all browser APIs
   - Some features like layout calculations won't work
   - Mock browser APIs that aren't supported by JSDOM

4. **Svelte component testing issues**:
   - Ensure you're using the correct testing utilities
   - Check for lifecycle issues (use `await tick()` when needed)
   - For Svelte 5 runes, special handling may be required

If you encounter persistent issues, check the [Vitest documentation](https://vitest.dev/guide/) or the [Testing Library documentation](https://testing-library.com/docs/).
