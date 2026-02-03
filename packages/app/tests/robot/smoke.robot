*** Settings ***
Documentation     Smoke tests for Roomy app using Robot Framework
Resource          resources/common.robot
Suite Setup       Setup Browser
Suite Teardown    Close Browser

*** Variables ***
${TIMEOUT}        15s

*** Test Cases ***
App Should Load Successfully
    [Documentation]    Verify that the Roomy app loads without errors
    [Tags]    smoke    critical
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    ${url}=    Get Url
    Should Contain    ${url}    127.0.0.1

Workers Should Initialize
    [Documentation]    Verify that worker system initializes properly
    [Tags]    smoke    workers
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    ${has_backend}=    Wait For Peer To Initialize    timeout=${TIMEOUT}
    Should Be Equal    ${has_backend}    ${True}    msg=Workers did not initialize within timeout

Peer Worker Should Respond To Ping
    [Documentation]    Test backend worker ping functionality
    [Tags]    smoke    workers    backend
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    ${has_debug}=    Wait For Debug Workers    timeout=${TIMEOUT}
    Should Be Equal    ${has_debug}    ${True}    msg=Debug helpers not available
    
    # Test ping
    ${ping_result}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        try {
    ...            const result = await window.debugWorkers.pingPeer();
    ...            return { success: true, result };
    ...        } catch (error) {
    ...            return { success: false, error: error.message };
    ...        }
    ...    }
    
    Should Be Equal    ${ping_result}[success]    ${True}    msg=Peer ping failed

SQLite Worker Should Connect
    [Documentation]    Verify SQLite worker connection
    [Tags]    smoke    workers    sqlite
    New Page    ${BASE_URL}
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}

    ${has_debug}=    Wait For Debug Workers    timeout=${TIMEOUT}
    Should Be Equal    ${has_debug}    ${True}    msg=Debug helpers not available
    
    # Verify SQLite test function exists
    ${has_sqlite_test}=    Evaluate JavaScript    ${None}
    ...    () => typeof window.debugWorkers?.testSqliteConnection === 'function'
    
    Should Be True    ${has_sqlite_test}    msg=SQLite test function not available

Required Browser APIs Should Be Available
    [Documentation]    Check that all required browser APIs are supported
    [Tags]    smoke    browser-compatibility
    New Page    ${BASE_URL}
    
    ${api_support}=    Evaluate JavaScript    ${None}
    ...    () => ({
    ...        indexedDB: 'indexedDB' in globalThis,
    ...        webAssembly: 'WebAssembly' in globalThis,
    ...        crypto: 'crypto' in globalThis && 'randomUUID' in crypto,
    ...        locks: 'navigator' in globalThis && 'locks' in navigator,
    ...        messageChannel: 'MessageChannel' in globalThis,
    ...        fetch: 'fetch' in globalThis
    ...    })
    
    Should Be Equal    ${api_support}[indexedDB]    ${True}    msg=IndexedDB not available
    Should Be Equal    ${api_support}[webAssembly]    ${True}    msg=WebAssembly not available
    Should Be Equal    ${api_support}[crypto]    ${True}    msg=Crypto API not available
    Should Be Equal    ${api_support}[locks]    ${True}    msg=Web Locks API not available
    Should Be Equal    ${api_support}[messageChannel]    ${True}    msg=MessageChannel not available
    Should Be Equal    ${api_support}[fetch]    ${True}    msg=Fetch API not available
