# Robot Framework Quick Start (Claude-written Docs)

## Initial Setup (One-time)

```bash
# Install dependencies and download browsers (takes ~2 minutes)
pnpm test:robot:setup
```

This will:

- Install Robot Framework and Browser library via `uv`
- Download Chromium, Firefox, and WebKit browsers (~160MB)
- Set up everything needed to run tests

## Running Tests

Make sure your dev server is running first:

```bash
# Terminal 1: Start dev server
pnpm dev
```

Then run tests in another terminal:

```bash
# Terminal 2: Run tests

# Run all tests (headless - fast)
pnpm test:robot

# Run with browser visible (debugging)
pnpm test:robot:headed

# Run specific test file
uv run robot tests/robot/smoke.robot

# Run only smoke tests
uv run robot --include smoke tests/robot

# Run only worker tests
uv run robot --include workers tests/robot
```

## Quick Example

Here's what a test looks like:

```robot
*** Test Cases ***
Workers Should Initialize
    [Tags]    smoke    workers
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded

    ${has_backend}=    Evaluate JavaScript    ${None}
    ...    () => window.backend && window.backendStatus

    Should Be True    ${has_backend}
```

## View Results

After running tests, open these files in your browser:

- `tests/robot/results/report.html` - High-level test summary
- `tests/robot/results/log.html` - Detailed execution log
- `tests/robot/results/browser/screenshot/` - Screenshots of failures

## Common Commands

```bash
# Run with Firefox
uv run robot --variable BROWSER:firefox tests/robot

# Run specific test by name
uv run robot --test "Workers Should Initialize" tests/robot

# Run with detailed logging
uv run robot --loglevel DEBUG tests/robot

# Run tests matching multiple tags
uv run robot --include smokeANDworkers tests/robot
```

## Next Steps

- See `tests/robot/README.md` for comprehensive documentation
- Check existing test files for examples
- Run `uv run robot --help` for all options
