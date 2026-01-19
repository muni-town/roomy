*** Settings ***
Documentation     Authentication Tests for Roomy App
...               Validates that app password authentication works correctly
...               when VITE_TESTING_APP_PASSWORD and VITE_TESTING_HANDLE
...               environment variables are set.
...
...               IMPORTANT: The dev server must be restarted after setting
...               these variables in .env for Vite to pick them up:
...               1. Edit packages/app/.env and set VITE_TESTING_HANDLE and VITE_TESTING_APP_PASSWORD
...               2. Restart dev server: pnpm dev
...               3. Run these tests: pnpm test:robot tests/robot/auth.robot

Resource          resources/common.robot
Library           OperatingSystem
Library           String
Test Setup        Check Auth Configuration
Test Teardown     Close Current Page If Open
Suite Setup       Setup Browser
Suite Teardown    Close Browser

*** Variables ***
# Override default timeout for auth tests (needs longer for app password flow)
${TIMEOUT}        30s
${POLL_INTERVAL}  200ms
${MAX_ATTEMPTS}   100

*** Test Cases ***
Environment Should Be Configured For App Password Auth
    [Documentation]    Verify that the dev server has loaded the environment variables
    ...                This test helps diagnose configuration issues
    [Tags]    auth    config    diagnostic

    # Load the app
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    # Wait a moment for workers to initialize and log messages
    Sleep    2s

    # Check if window.CONFIG has the testing variables
    ${env_check}=    Evaluate JavaScript    ${None}
    ...    () => ({
    ...        configExists: !!window.CONFIG,
    ...        hasHandle: !!window.CONFIG?.testingHandle,
    ...        hasPassword: !!window.CONFIG?.testingAppPassword,
    ...        handle: window.CONFIG?.testingHandle || 'NOT_SET',
    ...        // Don't log the actual password
    ...        passwordSet: window.CONFIG?.testingAppPassword ? 'YES' : 'NO',
    ...        // Also check all CONFIG keys to see what's available
    ...        allKeys: window.CONFIG ? Object.keys(window.CONFIG) : []
    ...    })

    Log    Environment check: ${env_check}

    Should Be True    ${env_check}[configExists]    msg=window.CONFIG does not exist - workers may not have initialized
    Should Be True    ${env_check}[hasHandle]    msg=VITE_TESTING_HANDLE not found in window.CONFIG - dev server may need restart with env vars set
    Should Be True    ${env_check}[hasPassword]    msg=VITE_TESTING_APP_PASSWORD not found in window.CONFIG - dev server may need restart with env vars set

    Log    Environment configured correctly with handle: ${env_check}[handle]

App Password Authentication Should Work When Environment Variables Are Set
    [Documentation]    Verify that the app authenticates using app password
    ...                when VITE_TESTING_APP_PASSWORD and VITE_TESTING_HANDLE are set
    [Tags]    auth    app-password    critical

    # Load the app
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}    msg=Backend worker did not initialize
    
    # Wait longer for client to be created (app password auth may take time)
    ${client_created}=    Wait For Client To Be Created    timeout=60s
    Should Be True    ${client_created}    msg=Client was not created within timeout
    
    # Give authentication some time to complete
    Sleep    5s
    
    # Debug: Check auth state thoroughly
    ${auth_debug}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const authState = window.backendStatus?.current?.authState;
    ...        if (!authState) return { error: 'no authState' };
    ...        if (authState.state !== 'authenticated') return { error: 'not authenticated', state: authState.state };
    ...        return {
    ...            state: authState.state,
    ...            hasDid: !!authState.did,
    ...            did: authState.did || 'none',
    ...            hasPersonalStream: !!authState.personalStream,
    ...            personalStream: authState.personalStream || 'none',
    ...            clientStatus: authState.clientStatus
    ...        };
    ...    }
    Log    Auth debug: ${auth_debug}

    # Verify the auth state has a DID (indicates successful authentication)
    Should Not Contain    ${auth_debug}    error    msg=${auth_debug}
    Should Be Equal    ${auth_debug}[state]    authenticated    msg=Auth state is not authenticated. Debug: ${auth_debug}
    Should Be True    ${auth_debug}[hasDid]    msg=Auth state does not have DID - authentication failed. Debug: ${auth_debug}

    Log    Successfully authenticated with DID: ${auth_debug}[did]

Backend Should Have Valid Agent After App Password Auth
    [Documentation]    Verify that authentication is complete with valid DID
    ...                after app password authentication
    [Tags]    auth    app-password    backend

    # Load the app
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    # Wait for backend and authentication
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}
    ${client_created}=    Wait For Client To Be Created
    Should Be True    ${client_created}

    # Check that authentication is complete
    ${auth_status}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const authState = window.backendStatus?.current?.authState;
    ...        if (!authState || authState.state !== 'authenticated') {
    ...            return { exists: false, state: authState?.state || 'unknown' };
    ...        }
    ...        return {
    ...            exists: true,
    ...            state: authState.state,
    ...            hasDid: !!authState.did,
    ...            did: authState.did,
    ...            hasPersonalStream: !!authState.personalStream,
    ...        };
    ...    }

    Should Be True    ${auth_status}[exists]    msg=Auth state does not exist or not authenticated. State: ${auth_status}[state]
    Should Be True    ${auth_status}[hasDid]    msg=Auth state missing DID
    Should Be True    ${auth_status}[hasPersonalStream]    msg=Auth state missing personal stream

    Log    Agent DID: ${auth_status}[did]

Client Should Connect To Leaf Server After Authentication
    [Documentation]    Verify that after app password auth, the client can connect
    ...                to the Leaf server and authenticate
    [Tags]    auth    app-password    leaf    integration
    
    # Load the app
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    
    # Wait for backend and client
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}
    ${client_created}=    Wait For Client To Be Created
    Should Be True    ${client_created}
    
    # Wait for Leaf to be authenticated
    ${leaf_authenticated}=    Wait For Leaf Authentication
    Should Be True    ${leaf_authenticated}    msg=Leaf server did not authenticate
    
    # Verify client status shows connection
    ${client_status}=    Get Client Connection Status
    Should Not Be Equal    ${client_status}    ${None}    msg=Could not get client status
    
    Log    Client connection status: ${client_status}

App Password Auth Should Skip OAuth Flow
    [Documentation]    Verify that when app password is used, OAuth flow is skipped
    [Tags]    auth    app-password    oauth
    
    # Load the app
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    
    # Get the current URL - should NOT redirect to OAuth
    ${url}=    Get Url
    Should Not Contain    ${url}    /oauth/    msg=App redirected to OAuth despite app password being set
    Should Contain    ${url}    127.0.0.1    msg=Unexpected URL
    
    # Verify we're authenticated without OAuth
    ${client_created}=    Wait For Client To Be Created    timeout=30s
    Should Be True    ${client_created}    msg=Client not created - app password auth may have failed

*** Keywords ***
Check Auth Configuration
    # Read from .env file in the app directory
    ${env_file}=    Set Variable    ${CURDIR}/../../.env
    ${env_exists}=    Run Keyword And Return Status    File Should Exist    ${env_file}
    
    IF    ${env_exists}
        ${env_content}=    Get File    ${env_file}
        ${handle}=    Get Env Value    ${env_content}    VITE_TESTING_HANDLE
        ${password}=    Get Env Value    ${env_content}    VITE_TESTING_APP_PASSWORD
    ELSE
        # Fall back to environment variables
        ${handle}=    Get Environment Variable    VITE_TESTING_HANDLE    default=
        ${password}=    Get Environment Variable    VITE_TESTING_APP_PASSWORD    default=
    END
    
    ${handle_empty}=    Run Keyword And Return Status    Should Be Empty    ${handle}
    ${password_empty}=    Run Keyword And Return Status    Should Be Empty    ${password}
    
    IF    ${handle_empty} or ${password_empty}
        Skip    Test requires VITE_TESTING_HANDLE and VITE_TESTING_APP_PASSWORD to be set in .env file or environment
    END
    
    Log    Using handle: ${handle}

Get Env Value
    [Documentation]    Extract value for a given key from .env file content
    [Arguments]    ${content}    ${key}
    
    ${lines}=    Split To Lines    ${content}
    FOR    ${line}    IN    @{lines}
        ${line}=    Strip String    ${line}
        ${is_comment}=    Run Keyword And Return Status    Should Start With    ${line}    \#
        ${is_empty}=    Run Keyword And Return Status    Should Be Empty    ${line}
        
        IF    not ${is_comment} and not ${is_empty}
            ${contains_key}=    Run Keyword And Return Status    Should Contain    ${line}    ${key}=
            IF    ${contains_key}
                ${parts}=    Split String    ${line}    =    max_split=1
                ${found_key}=    Strip String    ${parts}[0]
                IF    '${found_key}' == '${key}'
                    ${value}=    Strip String    ${parts}[1]
                    RETURN    ${value}
                END
            END
        END
    END
    
    RETURN    ${EMPTY}

Wait For Client To Be Created
    [Documentation]    Wait for authentication to complete (backendStatus.auth === 'authenticated')
    [Arguments]    ${timeout}=30s

    ${client_exists}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const start = Date.now();
    ...        const check = () => {
    ...            if (window.backendStatus?.current?.authState?.state === 'authenticated') {
    ...                resolve(true);
    ...            } else if (Date.now() - start < 30000) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.log('Timeout waiting for auth. Current state:', window.backendStatus?.current?.authState);
    ...                resolve(false);
    ...            }
    ...        };
    ...        check();
    ...    })

    RETURN    ${client_exists}

Wait For Leaf Authentication
    [Documentation]    Wait for client to be in 'connected' state (indicates Leaf authenticated)
    [Arguments]    ${timeout}=30s

    ${leaf_authenticated}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const start = Date.now();
    ...        const check = () => {
    ...            const authState = window.backendStatus?.current?.authState;
    ...            if (!authState || authState.state !== 'authenticated') {
    ...                if (Date.now() - start < 30000) {
    ...                    setTimeout(check, 200);
    ...                } else {
    ...                    console.log('Timeout: Auth state:', authState);
    ...                    resolve(false);
    ...                }
    ...                return;
    ...            }
    ...            // Check if client status is 'connected' (indicates Leaf is ready)
    ...            if (authState.clientStatus === 'connected') {
    ...                resolve(true);
    ...            } else if (Date.now() - start < 30000) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.log('Timeout: clientStatus:', authState.clientStatus);
    ...                resolve(false);
    ...            }
    ...        };
    ...        check();
    ...    })

    RETURN    ${leaf_authenticated}

Get Client Connection Status
    [Documentation]    Get the current authentication and connection status

    ${status}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const authState = window.backendStatus?.current?.authState;
    ...        if (!authState || authState.state !== 'authenticated') return null;
    ...        return {
    ...            clientStatus: authState.clientStatus,
    ...            hasDid: !!authState.did,
    ...            hasPersonalStream: !!authState.personalStream,
    ...        };
    ...    }

    RETURN    ${status}
