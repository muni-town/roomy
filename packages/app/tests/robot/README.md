# Robot Framework Tests for Roomy (Claude-written Docs)

This directory contains Robot Framework test suites for the Roomy app, providing an alternative to the existing Playwright tests with a keyword-driven approach.

## Why Robot Framework?

Robot Framework offers several advantages alongside Playwright:

- **Keyword-driven testing**: More readable test cases using natural language
- **Better for non-developers**: Product managers and QA can write/read tests
- **Rich ecosystem**: Many libraries available (Browser, SeleniumLibrary, etc.)
- **Excellent reporting**: Built-in HTML reports and logs
- **BDD-style**: Natural language test descriptions

## Setup

### Prerequisites

- `uv` installed (already available in your environment)
- `pnpm` for running scripts
- Python 3.11+ (managed by uv)

### Installation

The project uses `uv` for Python dependency management, integrated with `pnpm`:

```bash
# Install Python dependencies and initialize Robot Framework Browser
pnpm test:robot:setup
```

This will:
1. Install Robot Framework and Browser library via `uv`
2. Initialize the Browser library (downloads Playwright browsers)

## Running Tests

### Basic Usage

```bash
# Run all Robot Framework tests (headless)
pnpm test:robot

# Run with browser visible (great for debugging)
pnpm test:robot:headed

# Run specific test file
uv run robot tests/robot/smoke.robot

# Run tests with specific tag
pnpm test:robot:tag smoke
pnpm test:robot:tag workers
```

### Advanced Options

```bash
# Run with different browser
uv run robot --variable BROWSER:firefox tests/robot

# Run specific test case
uv run robot --test "Workers Should Initialize" tests/robot/smoke.robot

# Generate detailed logs
uv run robot --loglevel DEBUG tests/robot

# Run in parallel (requires robotframework-pabot)
uv run pabot --processes 4 tests/robot
```

## Test Structure

```
tests/robot/
├── smoke.robot           # Smoke tests (critical functionality)
├── initialization.robot  # Worker system initialization tests
└── README.md            # This file
```

## Test Files

### smoke.robot

Core smoke tests covering:
- App loading
- Worker initialization
- Peer worker ping
- SQLite connection
- Browser API compatibility

**Tags**: `smoke`, `critical`, `workers`, `backend`, `sqlite`, `browser-compatibility`

### initialization.robot

Comprehensive worker system initialization tests migrated from `tests/e2e/workers.spec.ts`:
- SharedWorker initialization with fallback
- SQLite worker lock acquisition
- Multi-tab lock management
- Worker heartbeat and health monitoring
- Concurrent SQLite operations
- MessageChannel/MessagePort communication
- Worker error handling
- IndexedDB support
- Navigator.locks API support
- Database initialization and operations
- Diagnostic tests for worker lifecycle
- Reactive state synchronization tests

**Tags**: `initialization`, `workers`, `sqlite`, `locks`, `critical`, `multi-tab`, `heartbeat`, `monitoring`, `concurrency`, `browser-api`, `messageport`, `error-handling`, `indexeddb`, `database`, `diagnostics`, `lifecycle`, `reactive-state`

**Note**: 
- Some tests are skipped on Safari/WebKit due to incomplete OPFS support in the test environment.
- Multi-tab tests are currently skipped because Robot Framework Browser library creates isolated browser contexts per page, preventing shared `navigator.locks` between tabs. This is a limitation of the test environment, not the application. For multi-tab testing, use the Playwright tests in `tests/e2e/workers.spec.ts` which properly share browser contexts.

## Writing Tests

### Basic Test Structure

```robot
*** Settings ***
Documentation     Description of test suite
Library           Browser
Suite Setup       Setup Browser
Suite Teardown    Close Browser

*** Variables ***
${BROWSER}        chromium
${HEADLESS}       True
${BASE_URL}       http://127.0.0.1:5173

*** Test Cases ***
My Test Case
    [Documentation]    What this test does
    [Tags]    smoke    critical
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded
    # Your test steps here

*** Keywords ***
Setup Browser
    New Browser    browser=${BROWSER}    headless=${HEADLESS}
```

### Using Tags

Tags help organize and run specific test subsets:

```bash
# Run only smoke tests
uv run robot --include smoke tests/robot

# Run all worker-related tests
uv run robot --include workers tests/robot

# Exclude slow tests
uv run robot --exclude slow tests/robot

# Combine tags
uv run robot --include smokeANDworkers tests/robot
```

### Common Keywords

```robot
# Browser control
New Page    ${URL}
Go To    ${URL}
Close Page

# Waiting
Wait For Load State    domcontentloaded
Wait For Elements State    selector    visible
Sleep    2s

# Viewport
Set Viewport Size    1920    1080

# JavaScript evaluation
${result}=    Evaluate JavaScript    ${None}    () => window.backend

# Assertions
Should Be Equal    ${actual}    ${expected}
Should Contain    ${text}    ${substring}
Should Be True    ${condition}
```

## Test Reports

After running tests, Robot Framework generates detailed reports:

```
tests/robot/results/
├── log.html           # Detailed execution log
├── report.html        # High-level test report  
├── output.xml         # Machine-readable results
└── browser/           # Screenshots and traces
    └── screenshot/    # Test failure screenshots
```

Open `tests/robot/results/report.html` in a browser to see:
- Test execution summary
- Pass/fail statistics
- Execution times
- Error messages and screenshots

## Integration with Existing Tests

Robot Framework tests complement the existing Playwright tests:

### Playwright (tests/e2e/)
- TypeScript-based
- More programmatic control
- Better for complex JavaScript interactions
- Existing comprehensive test suite

### Robot Framework (tests/robot/)
- Keyword-driven
- More readable for non-developers
- Great for BDD-style testing
- Easier to maintain for simple flows

**Recommendation**: Use both! Run Robot Framework for smoke tests and high-level flows, Playwright for detailed technical testing.

## CI/CD Integration

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Run Robot Framework tests
  run: |
    cd packages/app
    pnpm test:robot:setup
    pnpm test:robot
```

## Configuration

### pyproject.toml

Python dependencies are managed in `pyproject.toml`:

```toml
[project]
dependencies = [
    "robotframework>=7.0",
    "robotframework-browser>=18.0.0",
]
```

### Variables

Configure test behavior via variables in test files or command line:

```bash
# Override default browser
uv run robot --variable BROWSER:firefox tests/robot

# Change base URL
uv run robot --variable BASE_URL:http://localhost:3000 tests/robot

# Disable headless mode
uv run robot --variable HEADLESS:False tests/robot
```

## Troubleshooting

### Browser library not initialized

```bash
pnpm test:robot:setup
# or
uv run rfbrowser init
```

### Tests timing out

Increase timeout in test files:

```robot
*** Variables ***
${TIMEOUT}    30s
```

Or use command line:

```bash
uv run robot --variable TIMEOUT:30s tests/robot
```

### Workers not initializing

Make sure the dev server is running:

```bash
pnpm dev
```

Then run tests in another terminal:

```bash
pnpm test:robot
```

## Migration Path

If you decide to replace Playwright tests with Robot Framework:

1. **Start with smoke tests**: Migrate critical paths first
2. **Run both in parallel**: Keep Playwright while building Robot suite
3. **Compare coverage**: Ensure Robot tests cover same scenarios
4. **Gradual transition**: Migrate test by test, not all at once
5. **Maintain documentation**: Keep both test suites documented

## Resources

- [Robot Framework User Guide](https://robotframework.org/robotframework/latest/RobotFrameworkUserGuide.html)
- [Browser Library Documentation](https://marketsquare.github.io/robotframework-browser/)
- [Robot Framework Best Practices](https://github.com/robotframework/HowToWriteGoodTestCases)
- [uv Documentation](https://docs.astral.sh/uv/)

## Contributing

When adding new tests:

1. Follow existing naming conventions
2. Use descriptive test names and documentation
3. Tag tests appropriately
4. Keep tests independent (no dependencies between test cases)
5. Use keywords for reusable functionality
6. Update this README with new test files or patterns
