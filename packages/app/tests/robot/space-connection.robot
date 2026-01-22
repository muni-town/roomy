*** Settings ***
Documentation       Test suite for space connection status synchronization
...                 Tests the scenario where spaces appear in one tab
...                 while being created in another tab (multi-tab testing).
...                 Verifies that spaces reach 'idle' status in backendStatus
...                 when receiving joinSpace events via personal stream subscription.
...
...                 These tests verify the integration between:
...                 - Personal stream event subscription
...                 - Space materialization from joinSpace events
...                 - Backend status updates (spaces[idle])
...                 - Multi-tab state synchronization

Library             Browser
Library             Collections
Resource            resources/common.robot
Resource            resources/stream.robot
Resource            resources/space.robot

Suite Setup         Setup Multi-Tab Test Environment
Suite Teardown      Close Browser

Test Tags           space    connection    multi-tab


*** Test Cases ***
[DIAGNOSTIC] Observe Space Creation From Another Tab
    [Documentation]    Diagnostic test to observe space connection behavior
    ...                Creates a space in Tab B while Tab A observes
    ...                Monitors backendStatus to see if space reaches idle
    ...                This reproduces the loading spinner issue
    [Tags]    diagnostic

    # Tab A is already authenticated and observing personal stream
    # Get initial state
    ${initial_spaces}=    Evaluate JavaScript    ${None}
    ...    () => Object.keys(window.backendStatus?.current?.spaces || {})
    Log    Initial spaces in Tab A: ${initial_spaces}

    # Switch to Tab B (creator) to create a space
    Switch To Creator Tab
    Log    Switched to Tab B (creator)

    # Verify Tab B is authenticated
    ${authenticated_b}=    Wait For Authentication    timeout=10s
    Should Be True    ${authenticated_b}    msg=Tab B should be authenticated

    # Create space in Tab B
    ${space_id}=    Create Space With Name    Observed Space
    Log    Created space in Tab B: ${space_id}

    # Wait for space to reach idle in Tab B (this should work)
    ${reached_idle_b}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s
    Log    Tab B - Space reached idle: ${reached_idle_b}

    # Now switch back to Tab A to observe connection
    Switch To Observer Tab
    Log    Switched to Tab A (observer)

    # Wait for space to appear in Tab A's backendStatus
    # This tests if the personal stream subscription delivers joinSpace event
    ${space_appeared}=    Verify Space In Backend Status    ${space_id}    timeout=30s
    Log    Tab A - Space appeared in backendStatus: ${space_appeared}

    # Check the status immediately after appearing
    ${initial_status}=    Get Space Status    ${space_id}
    Log    Tab A - Initial space status: ${initial_status}

    # Now poll for idle status with a longer timeout
    # This is the key test - does the space reach idle in Tab A?
    ${reached_idle_a}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    IF    not ${reached_idle_a}
        Log    ISSUE: Space ${space_id} did NOT reach idle in Tab A (reproduced the bug!)

        # Dump diagnostic information
        ${final_status}=    Get Space Status    ${space_id}
        Log    Tab A - Final space status: ${final_status}

        ${all_spaces}=    Evaluate JavaScript    ${None}
        ...    () => window.backendStatus?.current?.spaces || {}
        Log    Tab A - All spaces in backendStatus: ${all_spaces}

        ${backend_status}=    Evaluate JavaScript    ${None}
        ...    () => {
        ...        const status = window.backendStatus?.current;
        ...        return {
        ...            authState: status?.authState,
        ...            roomyState: status?.roomyState,
        ...            spacesCount: Object.keys(status?.spaces || {}).length
        ...        };
        ...    }
        Log    Tab A - Backend status summary: ${backend_status}

        # Check if space is materialized in database
        ${materialized}=    Check Space Materialized In Database    ${space_id}
        Log    Tab A - Space materialized in database: ${materialized}
    ELSE
        Log    SUCCESS: Space ${space_id} reached idle in Tab A
    END

    # This assertion will fail if the bug is reproduced
    Should Be True    ${reached_idle_a}    msg=Space did not reach idle status in observing tab (bug reproduced)

Multiple Spaces Created In Another Tab
    [Documentation]    Test that multiple spaces reach idle status when created in another tab
    ...                Verifies multi-tab synchronization for multiple space joins
    [Tags]    multiple

    # Tab A is already authenticated and observing
    ${initial_count}=    Evaluate JavaScript    ${None}
    ...    () => Object.keys(window.backendStatus?.current?.spaces || {}).length
    Log    Tab A - Initial space count: ${initial_count}

    # Switch to Tab B
    Switch To Creator Tab

    # Create 3 spaces in Tab B
    ${space_1}=    Create Space With Name    Multi Test Space 1
    ${space_2}=    Create Space With Name    Multi Test Space 2
    ${space_3}=    Create Space With Name    Multi Test Space 3

    # Wait for all spaces to reach idle in Tab B
    Wait For Space Status    ${space_1}    expectedStatus=idle    timeout=30s
    Wait For Space Status    ${space_2}    expectedStatus=idle    timeout=30s
    Wait For Space Status    ${space_3}    expectedStatus=idle    timeout=30s
    Log    Tab B - All 3 spaces reached idle

    # Switch back to Tab A
    Switch To Observer Tab

    # Verify all 3 spaces appear and reach idle in Tab A
    ${idle_1}=    Wait For Space Status    ${space_1}    expectedStatus=idle    timeout=30s
    ${idle_2}=    Wait For Space Status    ${space_2}    expectedStatus=idle    timeout=30s
    ${idle_3}=    Wait For Space Status    ${space_3}    expectedStatus=idle    timeout=30s

    Should Be True    ${idle_1}    msg=Space 1 did not reach idle in Tab A
    Should Be True    ${idle_2}    msg=Space 2 did not reach idle in Tab A
    Should Be True    ${idle_3}    msg=Space 3 did not reach idle in Tab A

    Log    All 3 spaces reached idle in Tab A

Space Connection After Tab A Reload
    [Documentation]    Test that spaces connect properly after a page reload
    ...                Simulates user refreshing their browser while spaces exist
    [Tags]    persistence

    # Create a space in Tab B first
    Switch To Creator Tab
    ${space_id}=    Create Space With Name    Reload Test Space
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s
    Log    Tab B - Created space: ${space_id}

    # Switch to Tab A and verify it appears
    Switch To Observer Tab
    ${appeared}=    Verify Space In Backend Status    ${space_id}    timeout=30s
    Log    Tab A - Space appeared: ${appeared}

    # Reload Tab A
    Reload
    Wait For Load State    networkidle    timeout=10s

    # Wait for backend to reinitialize
    ${backend_ready}=    Wait For Backend To Initialize
    Should Be True    ${backend_ready}

    # Re-authenticate
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Set __playwright flag again
    Evaluate JavaScript    ${None}    () => { window.__playwright = true; }

    # Wait for space to reach idle after reload
    ${reached_idle}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=60s
    Should Be True    ${reached_idle}    msg=Space did not reach idle after reload

    Log    Space reached idle after reload in Tab A

Backend Status Consistency Across Tabs
    [Documentation]    Verify that backend status is consistent between tabs
    ...                Checks that spaces show same status in both tabs
    [Tags]    consistency

    # Create a space in Tab B
    Switch To Creator Tab
    ${space_id}=    Create Space With Name    Consistency Test Space
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s
    ${status_b}=    Get Space Status    ${space_id}
    Log    Tab B - Space status: ${status_b}

    # Check status in Tab A
    Switch To Observer Tab
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s
    ${status_a}=    Get Space Status    ${space_id}
    Log    Tab A - Space status: ${status_a}

    # Verify both tabs show same status
    Should Be Equal    ${status_a}    ${status_b}    msg=Space status differs between tabs

    Log    Status consistent across tabs: ${status_a}


*** Keywords ***
Setup Multi-Tab Test Environment
    [Documentation]    Initialize two browser tabs for multi-tab testing
    ...                Tab 0: Observer tab (receives events via personal stream)
    ...                Tab 1: Creator tab (creates spaces and sends events)
    ...                Both tabs authenticate with same user

    # Create browser with service workers blocked
    New Browser    chromium    headless=True
    New Context    viewport={'width': 1280, 'height': 720}    serviceWorkers=block

    # Create Tab 0 (observer) - navigate to /home
    New Page    ${BASE_URL}/home
    ${backend_init_0}=    Wait For Backend To Initialize
    Should Be True    ${backend_init_0}    msg=Tab 0 backend initialization failed

    # Set __playwright flag in Tab 0
    Evaluate JavaScript    ${None}    () => { window.__playwright = true; }

    # Wait for Tab 0 authentication
    ${auth_0}=    Wait For Authentication    timeout=30s
    Should Be True    ${auth_0}    msg=Tab 0 authentication failed

    # Verify personal stream exists in Tab 0
    Verify Stream Connected    timeout=20s

    # Store page IDs for switching
    ${page_ids}=    Get Page Ids
    Set Suite Variable    ${OBSERVER_TAB_ID}    ${page_ids}[0]

    Log    Tab 0 (observer) ready: authenticated and connected to personal stream

    # Create Tab 1 (creator) - new page in same context (shared authentication)
    New Page    ${BASE_URL}/home
    ${backend_init_1}=    Wait For Backend To Initialize
    Should Be True    ${backend_init_1}    msg=Tab 1 backend initialization failed

    # Set __playwright flag in Tab 1
    Evaluate JavaScript    ${None}    () => { window.__playwright = true; }

    # Wait for Tab 1 authentication
    ${auth_1}=    Wait For Authentication    timeout=30s
    Should Be True    ${auth_1}    msg=Tab 1 authentication failed

    # Get updated page IDs and store creator tab
    ${page_ids}=    Get Page Ids
    Set Suite Variable    ${CREATOR_TAB_ID}    ${page_ids}[1]

    Log    Tab 1 (creator) ready: authenticated

    # Switch back to Tab 0 for initial state
    Switch Page    ${OBSERVER_TAB_ID}

    Log    Multi-tab test environment ready

Switch To Observer Tab
    [Documentation]    Switch to the observer tab (Tab A)
    Switch Page    ${OBSERVER_TAB_ID}

Switch To Creator Tab
    [Documentation]    Switch to the creator tab (Tab B)
    Switch Page    ${CREATOR_TAB_ID}

Check Space Materialized In Database
    [Documentation]    Check if a space entity exists in the database
    ...                This helps distinguish between:
    ...                - Space materialized in DB but not in backendStatus
    ...                - Space not materialized at all
    [Arguments]    ${spaceId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT COUNT(*) as count
    ...    FROM entities e
    ...    JOIN comp_space cs ON cs.entity = e.id
    ...    WHERE e.id = '${spaceId}'

    ${result}=    Execute SQL Query    ${sql}
    ${count}=    Set Variable    ${result['rows'][0]['count']}
    ${is_materialized}=    Evaluate    ${count} > 0

    Log    Space ${spaceId} materialization check: count=${count}, materialized=${is_materialized}
    RETURN    ${is_materialized}
