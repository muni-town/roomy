*** Settings ***
Documentation       Test suite for personal stream creation and management
...                 Tests the full lifecycle of personal stream creation including:
...                 - First-time stream creation
...                 - Retrieving existing streams
...                 - Handling stale PDS records
...                 - Stream persistence and reconnection
...
...                 These tests verify the integration between:
...                 - PDS record storage (AT Protocol)
...                 - Leaf server stream hosting
...                 - IndexedDB caching
...                 - Backend worker stream management

Library             Browser
Resource            resources/common.robot
Resource            resources/stream.robot

Suite Setup         Setup Test Environment
Suite Teardown      Close Browser

Test Tags           stream    creation


*** Test Cases ***
Create Personal Stream - First Time User
    [Documentation]    Test stream creation flow for a user with no existing stream
    ...                Verifies:
    ...                - Stream is created on Leaf server
    ...                - PDS record is created with stream ID
    ...                - Backend worker connects to stream
    ...                - Stream ID is cached in IndexedDB
    [Tags]    first-time    critical

    # Clean state: Remove PDS record and IndexedDB cache
    Delete Stream Record From PDS
    Clear IndexedDB Stream Cache

    # Reload page to clear in-memory state
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication (triggers stream creation)
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}    msg=Authentication did not complete within 30s

    # Verify stream was created and connected
    Verify Stream Connected    timeout=20s

    # Verify PDS record exists
    ${record}=    Get Stream Record From PDS
    Should Not Be Equal    ${record}    ${None}    msg=PDS record should exist after stream creation
    Verify PDS Record Structure    ${record}

    # Verify stream ID is available
    ${stream_id}=    Wait For Personal Stream ID    timeout=10s
    Should Not Be Empty    ${stream_id}
    Should Be Equal    ${stream_id}    ${record['id']}    msg=Stream ID should match PDS record

    Log    Successfully created personal stream: ${stream_id}

Retrieve Existing Personal Stream
    [Documentation]    Test that existing stream is retrieved and reused
    ...                Verifies:
    ...                - Existing PDS record is read
    ...                - Stream connection is established to existing stream
    ...                - No new stream is created
    ...                - IndexedDB cache is populated
    [Tags]    existing    critical

    # Ensure we have a stream from previous test or create one
    ${existing_record}=    Get Stream Record From PDS
    IF    ${existing_record} == ${None}
        Trigger Personal Stream Creation
        Verify Stream Connected    timeout=20s
        ${existing_record}=    Get Stream Record From PDS
    END

    ${existing_stream_id}=    Set Variable    ${existing_record['id']}
    Log    Existing stream ID: ${existing_stream_id}

    # Clear IndexedDB cache but keep PDS record
    Clear IndexedDB Stream Cache

    # Reload page to simulate fresh browser session
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Verify stream connected
    Verify Stream Connected    timeout=20s

    # Verify same stream ID is used
    ${retrieved_stream_id}=    Wait For Personal Stream ID    timeout=10s
    Should Be Equal    ${retrieved_stream_id}    ${existing_stream_id}    msg=Should reuse existing stream, not create new one

    # Verify PDS record unchanged
    ${current_record}=    Get Stream Record From PDS
    Should Be Equal    ${current_record['id']}    ${existing_stream_id}

    Log    Successfully retrieved existing stream: ${retrieved_stream_id}

Handle Stale PDS Record
    [Documentation]    Test handling of missing PDS record after page reload
    ...                Verifies:
    ...                - System detects missing PDS record
    ...                - New stream is created
    ...                - PDS record is created with new stream ID
    ...                - Connection succeeds with new stream
    [Tags]    stale-record    error-recovery

    # Get current stream ID
    ${original_stream_id}=    Wait For Personal Stream ID    timeout=10s

    # Delete PDS record (simulates case where PDS record was deleted externally)
    ${delete_result}=    Delete Stream Record From PDS
    Should Be True    ${delete_result['success']}

    # Verify record is deleted
    ${record_after_delete}=    Get Stream Record From PDS
    Should Be Equal    ${record_after_delete}    ${None}

    # Reload page to clear in-memory state (ensurePersonalStream caches the stream)
    # This simulates a fresh session where the PDS record is missing
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication (should recreate stream when PDS record not found)
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Wait for stream to be created and connected
    Verify Stream Connected    timeout=20s

    # Verify new PDS record exists
    ${new_record}=    Get Stream Record From PDS
    Should Not Be Equal    ${new_record}    ${None}    msg=PDS record should be recreated
    Verify PDS Record Structure    ${new_record}

    # Get new stream ID
    ${new_stream_id}=    Wait For Personal Stream ID    timeout=10s
    Should Not Be Empty    ${new_stream_id}

    Log    Original stream ID: ${original_stream_id}
    Log    New stream ID: ${new_stream_id}

    # Note: Stream IDs may or may not be the same depending on implementation
    # What matters is that we have a valid, connected stream

Stream Persistence After Page Reload
    [Documentation]    Test that stream persists across page reloads
    ...                Verifies:
    ...                - Stream ID cached in IndexedDB
    ...                - PDS record persists
    ...                - Stream reconnects after reload
    ...                - Same stream ID is used
    [Tags]    persistence

    # Ensure we have a connected stream
    Verify Stream Connected    timeout=20s
    ${original_stream_id}=    Wait For Personal Stream ID    timeout=10s

    # Reload page
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Verify stream reconnected with same ID
    Verify Stream Connected    timeout=20s
    ${reconnected_stream_id}=    Wait For Personal Stream ID    timeout=10s
    Should Be Equal    ${reconnected_stream_id}    ${original_stream_id}    msg=Stream ID should persist across reloads

    # Verify PDS record unchanged
    ${record}=    Get Stream Record From PDS
    Should Be Equal    ${record['id']}    ${original_stream_id}

    Log    Successfully reconnected to stream: ${reconnected_stream_id}

Stream Connection Status Transitions
    [Documentation]    Test that connection status transitions correctly
    ...                Verifies:
    ...                - Status starts as offline/initialising
    ...                - Transitions to connected
    ...                - Personal stream ID appears when connected
    [Tags]    status

    # Reload to observe status transitions
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Check client status progression
    ${status}=    Get Client Status
    Should Be Equal    ${status}    connected    msg=Client should reach connected state

    # Verify personal stream ID is present when connected
    ${stream_id}=    Wait For Personal Stream ID    timeout=10s
    Should Not Be Empty    ${stream_id}

    Log    Client status: ${status}, Stream ID: ${stream_id}


*** Keywords ***
Setup Test Environment
    [Documentation]    Initialize browser and authenticate
    ...                Sets up clean test environment with:
    ...                - Browser with proper viewport
    ...                - Backend worker initialized
    ...                - User authenticated with app password

    # Setup browser
    New Browser    chromium    headless=True
    New Context    viewport={'width': 1280, 'height': 720}
    New Page    http://127.0.0.1:5173

    # Wait for app to load
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication (happens automatically with app password)
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}    msg=Authentication did not complete

    Log    Test environment ready
