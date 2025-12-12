*** Settings ***
Documentation       Test suite to validate stream helper keywords
...                 This suite tests the helper keywords in resources/stream.robot
...                 to ensure they work correctly before building the full stream creation tests

Library             Browser
Resource            resources/common.robot
Resource            resources/stream.robot

Suite Setup         Setup Test Environment
Suite Teardown      Close Browser

Test Tags           stream    keywords    validation


*** Test Cases ***
Test Get Stream Record From PDS
    [Documentation]    Verify we can retrieve stream record from PDS
    [Tags]    pds

    ${record}=    Get Stream Record From PDS
    Log    Retrieved record: ${record}

    IF    ${record} != ${None}
        Log    Stream record exists
        Verify PDS Record Structure    ${record}
    ELSE
        Log    No stream record found (expected if first run or after cleanup)
    END

Test Verify Stream Connected
    [Documentation]    Verify stream connection status check works
    [Tags]    connection

    Verify Stream Connected    timeout=15s
    Log    Stream connection verified

Test Get Client Status
    [Documentation]    Verify we can get client connection status
    [Tags]    connection

    ${status}=    Get Client Status
    Should Be Equal    ${status}    connected
    Log    Client status: ${status}

Test Wait For Personal Stream ID
    [Documentation]    Verify we can retrieve personal stream ID
    [Tags]    stream-id

    ${stream_id}=    Wait For Personal Stream ID    timeout=15s
    Should Not Be Empty    ${stream_id}
    Log    Personal stream ID: ${stream_id}

Test Delete And Recreate Stream Record
    [Documentation]    Test the full cycle: delete record, reload, verify recreation
    [Tags]    full-cycle    critical

    # Save current stream ID for comparison
    ${original_stream_id}=    Wait For Personal Stream ID

    # Delete the PDS record
    ${delete_result}=    Delete Stream Record From PDS
    Should Be True    ${delete_result['success']}

    # Verify record is gone
    ${record_after_delete}=    Get Stream Record From PDS
    Should Be Equal    ${record_after_delete}    ${None}    msg=Record should be deleted

    # Reload page to clear in-memory state
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication (should recreate stream when PDS record not found)
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Wait for stream to be created
    Verify Stream Connected    timeout=20s

    # Verify record exists again
    ${record_after_create}=    Get Stream Record From PDS
    Should Not Be Equal    ${record_after_create}    ${None}    msg=Record should exist after creation
    Verify PDS Record Structure    ${record_after_create}

    # Verify we got a stream ID (may or may not be the same as original)
    ${new_stream_id}=    Wait For Personal Stream ID
    Should Not Be Empty    ${new_stream_id}
    Log    Original stream ID: ${original_stream_id}
    Log    New stream ID: ${new_stream_id}

Test Delete Stream Record Idempotence
    [Documentation]    Verify deleting non-existent record doesn't fail
    ...                Backend silently ignores RecordNotFound errors
    [Tags]    cleanup

    # Delete record multiple times - should not fail
    ${result1}=    Delete Stream Record From PDS
    Should Be True    ${result1['success']}

    # Second delete should also succeed (idempotent operation)
    ${result2}=    Delete Stream Record From PDS
    Should Be True    ${result2['success']}


*** Keywords ***
Setup Test Environment
    [Documentation]    Initialize browser and authenticate

    # Setup browser
    New Browser    chromium    headless=True
    New Context    viewport={'width': 1280, 'height': 720}
    New Page    http://127.0.0.1:5173

    # Wait for app to load
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication (happens automatically with app password)
    ${authenticated}=    Wait For Authentication
    Should Be True    ${authenticated}    msg=Authentication did not complete

    Log    Test environment ready
