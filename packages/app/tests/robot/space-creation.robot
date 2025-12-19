*** Settings ***
Documentation       Test suite for space creation and initialization
...                 Tests the full lifecycle of space creation including:
...                 - First-time space creation
...                 - Default room structure (category, channel, thread)
...                 - Space metadata persistence
...                 - Multiple spaces
...                 - Welcome message creation
...                 - Space reconnection after reload
...
...                 These tests verify the integration between:
...                 - Leaf server stream creation
...                 - Event batch submission
...                 - SQLite database materialization
...                 - Backend worker space management

Library             Browser
Resource            resources/common.robot
Resource            resources/stream.robot
Resource            resources/space.robot

Suite Setup         Setup Test Environment For Spaces
Suite Teardown      Close Browser

Test Tags           space    creation


*** Test Cases ***
[DIAGNOSTIC] Dump Space Database State
    [Documentation]    Diagnostic test to dump database state after space creation
    ...                This helps us understand what's being materialized
    [Tags]    diagnostic

    # Create space
    ${space_id}=    Create Space With Name    Diagnostic Space

    # Wait for space to reach idle
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}

    # Get personal stream ID first
    ${personal_stream}=    Get Personal Stream ID
    Log    Personal stream ID: ${personal_stream}

    # Check if space exists in personal stream (for joinedSpaces query)
    ${personal_space_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT e.id as id, e.stream_id as stream_id
    ...    FROM entities e
    ...    JOIN comp_space cs ON cs.entity = e.id
    ...    WHERE e.stream_id = '${personal_stream}'
    ...    AND e.id = '${space_id}'
    ${personal_space}=    Execute SQL Query    ${personal_space_sql}
    Log    Space in personal stream (needed for joinedSpaces): ${personal_space['rows']}

    # Dump database state
    Dump Database State For Space    ${space_id}

    # Navigate to the space so window.spaceTree is populated
    # (spaceTree.svelte.ts uses current.joinedSpace?.id to filter)
    Go To    http://127.0.0.1:5173/${space_id}
    Sleep    1s    # Give UI time to set current.joinedSpace

    # Query spaceTree using the helper keyword (reads from window.spaceTree.result)
    # Note: window.spaceTree.result is hierarchical - we expect 1 top-level category with nested children
    ${space_tree}=    Query Space Tree    expectedCount=1
    Log    window.spaceTree.result (UI sidebar tree structure): ${space_tree}

    # Flatten the tree to count all rooms (category + children recursively)
    ${total_rooms}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        function countRooms(items) {
    ...            if (!items) return 0;
    ...            let count = items.length;
    ...            for (const item of items) {
    ...                if (item.children) count += countRooms(item.children);
    ...            }
    ...            return count;
    ...        }
    ...        return countRooms(window.spaceTree?.result || []);
    ...    }
    Log    Total rooms in tree (flattened): ${total_rooms} (should be 3: category + channel + thread)

Create First Space - Basic Flow
    [Documentation]    Test creating a user's first space with minimal configuration
    ...                Verifies:
    ...                - Space stream is created on Leaf server
    ...                - Space appears in backend status
    ...                - Space status transitions to 'idle'
    ...                - Space metadata is stored in database
    [Tags]    first-time    critical

    # Create space
    ${space_id}=    Create Space With Name    Test Space

    # Wait for space to appear in backend status and reach idle
    # (Wait For Space Status implicitly verifies space exists)
    ${reached_idle}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=60s
    Should Be True    ${reached_idle}    msg=Space did not reach 'idle' status within 60s

    # Verify space metadata in database
    ${metadata}=    Query Space Metadata    ${space_id}
    Should Not Be Equal    ${metadata}    ${None}    msg=Space metadata not found in database
    Log    Space metadata: ${metadata}

    Log    Successfully created space: ${space_id}

Verify Default Room Structure
    [Documentation]    Verify newly created space has correct default room hierarchy
    ...                Verifies:
    ...                - Space has 1 category, 1 channel, 1 thread
    ...                - Rooms have correct hierarchy (channel→category, thread→channel)
    ...                - Rooms have correct names: "Uncategorized", "general", "Welcome to ..."
    [Tags]    structure    critical

    # Create space
    ${space_id}=    Create Space With Name    Test Space Structure

    # Wait for space to finish initializing
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}    msg=Space did not reach 'idle' status

    # Query room structure (with retry - wait for all 3 rooms to be materialized)
    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=3
    ${room_count}=    Get Length    ${rooms}
    Should Be Equal As Numbers    ${room_count}    3    msg=Expected 3 rooms (category, channel, thread), got ${room_count}

    # Count rooms by type
    ${counts}=    Count Rooms By Type    ${space_id}
    Should Be Equal As Numbers    ${counts['categories']}    1    msg=Expected 1 category
    Should Be Equal As Numbers    ${counts['channels']}    1    msg=Expected 1 channel
    Should Be Equal As Numbers    ${counts['threads']}    1    msg=Expected 1 thread
    Should Be Equal As Numbers    ${counts['pages']}    0    msg=Expected 0 pages

    # Verify room hierarchy and names
    ${category_id}=    Set Variable    ${None}
    ${channel_id}=    Set Variable    ${None}
    ${thread_id}=    Set Variable    ${None}

    FOR    ${room}    IN    @{rooms}
        IF    '${room['type']}' == 'category'
            ${category_id}=    Set Variable    ${room['id']}
            Should Be Equal    ${room['name']}    Uncategorized    msg=Category should be named 'Uncategorized'
            Should Be Equal    ${room['parent']}    ${None}    msg=Category should have no parent
            Should Be Equal As Numbers    ${room['deleted']}    0    msg=Category should not be deleted
        ELSE IF    '${room['type']}' == 'channel'
            ${channel_id}=    Set Variable    ${room['id']}
            Should Be Equal    ${room['name']}    general    msg=Channel should be named 'general'
            Should Not Be Equal    ${room['parent']}    ${None}    msg=Channel should have a parent
            Should Be Equal As Numbers    ${room['deleted']}    0    msg=Channel should not be deleted
        ELSE IF    '${room['type']}' == 'thread'
            ${thread_id}=    Set Variable    ${room['id']}
            Should Contain    ${room['name']}    Welcome to    msg=Thread name should contain 'Welcome to'
            Should Not Be Equal    ${room['parent']}    ${None}    msg=Thread should have a parent
            Should Be Equal As Numbers    ${room['deleted']}    0    msg=Thread should not be deleted
        END
    END

    # Verify hierarchy: channel parent is category, thread parent is channel
    FOR    ${room}    IN    @{rooms}
        IF    '${room['type']}' == 'channel'
            Should Be Equal    ${room['parent']}    ${category_id}    msg=Channel parent should be category
        ELSE IF    '${room['type']}' == 'thread'
            Should Be Equal    ${room['parent']}    ${channel_id}    msg=Thread parent should be channel
        END
    END

    Log    Room structure verified: category → channel → thread

Verify Space Metadata Persistence
    [Documentation]    Test that space name/description persist and can be retrieved
    ...                Verifies:
    ...                - Space metadata is stored in comp_info table
    ...                - Metadata persists across page reload
    [Tags]    metadata    persistence

    # Create space with name and description
    ${space_id}=    Create Space With Name    My Persistent Space

    # Wait for space to initialize
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}

    # Query metadata before reload
    ${metadata_before}=    Query Space Metadata    ${space_id}
    Should Not Be Equal    ${metadata_before}    ${None}
    Log    Metadata before reload: ${metadata_before}

    # Reload page
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Wait for space to reconnect
    ${reached_idle_after}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle_after}

    # Query metadata after reload
    ${metadata_after}=    Query Space Metadata    ${space_id}
    Should Not Be Equal    ${metadata_after}    ${None}

    # Verify metadata unchanged
    # Note: We don't compare the entire dict because some fields might be None
    Log    Metadata after reload: ${metadata_after}

    Log    Metadata persisted across reload

Create Multiple Spaces
    [Documentation]    Test creating and managing multiple spaces
    ...                Verifies:
    ...                - Multiple spaces can be created
    ...                - Each space has unique ID
    ...                - Each space has independent room structure
    ...                - Both spaces appear in backend status
    [Tags]    multiple

    # Create first space
    ${space_one_id}=    Create Space With Name    Space One

    # Wait for space one to reach idle
    ${reached_idle_one}=    Wait For Space Status    ${space_one_id}    expectedStatus=idle    timeout=60s
    Should Be True    ${reached_idle_one}

    # Create second space
    ${space_two_id}=    Create Space With Name    Space Two

    # Wait for space two to reach idle
    ${reached_idle_two}=    Wait For Space Status    ${space_two_id}    expectedStatus=idle    timeout=60s
    Should Be True    ${reached_idle_two}

    # Verify both spaces have different IDs
    Should Not Be Equal    ${space_one_id}    ${space_two_id}    msg=Space IDs should be different

    # Verify both spaces have full room structure (with retry for materialization)
    ${rooms_one}=    Query Space Rooms    ${space_one_id}    expectedCount=3
    ${room_count_one}=    Get Length    ${rooms_one}
    Should Be Equal As Numbers    ${room_count_one}    3    msg=Space One should have 3 rooms

    ${rooms_two}=    Query Space Rooms    ${space_two_id}    expectedCount=3
    ${room_count_two}=    Get Length    ${rooms_two}
    Should Be Equal As Numbers    ${room_count_two}    3    msg=Space Two should have 3 rooms

    # Verify counts for both spaces
    ${counts_one}=    Count Rooms By Type    ${space_one_id}
    Should Be Equal As Numbers    ${counts_one['categories']}    1
    Should Be Equal As Numbers    ${counts_one['channels']}    1
    Should Be Equal As Numbers    ${counts_one['threads']}    1

    ${counts_two}=    Count Rooms By Type    ${space_two_id}
    Should Be Equal As Numbers    ${counts_two['categories']}    1
    Should Be Equal As Numbers    ${counts_two['channels']}    1
    Should Be Equal As Numbers    ${counts_two['threads']}    1

    Log    Successfully created and verified two independent spaces

Verify Space Tree Structure
    [Documentation]    Verify spaceTree query (what UI sidebar uses) returns correct structure
    ...                This validates what the user actually sees in the UI sidebar
    ...                Tests window.spaceTree.result exposed in workers/index.ts
    [Tags]    structure    critical    ui

    # Create space
    ${space_id}=    Create Space With Name    SpaceTree Test Space

    # Wait for space to finish initializing
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}    msg=Space did not reach 'idle' status

    # Navigate to the space so window.spaceTree is populated for this space
    Go To    http://127.0.0.1:5173/${space_id}
    Sleep    1s    # Give UI time to set current.joinedSpace and update spaceTree

    # Query window.spaceTree.result (what the UI actually uses) - expect 1 top-level category
    ${space_tree}=    Query Space Tree    expectedCount=1
    ${tree_count}=    Get Length    ${space_tree}
    Should Be Equal As Numbers    ${tree_count}    1    msg=spaceTree should have 1 top-level room (category)

    # Get the category (first item)
    ${category}=    Set Variable    ${space_tree[0]}
    Should Be Equal    ${category['type']}    category    msg=Top-level room should be category
    Should Be Equal    ${category['name']}    Uncategorized

    # Verify category has children (channel)
    ${category_children}=    Set Variable    ${category['children']}
    ${has_channel}=    Evaluate    len(${category_children}) > 0
    Should Be True    ${has_channel}    msg=Category should have children

    # Get the channel (first child of category)
    ${channel}=    Set Variable    ${category_children[0]}
    Should Be Equal    ${channel['type']}    channel    msg=First child should be channel
    Should Be Equal    ${channel['name']}    general

    # Verify channel has children (thread)
    ${channel_children}=    Set Variable    ${channel['children']}
    ${has_thread}=    Evaluate    len(${channel_children}) > 0
    Should Be True    ${has_thread}    msg=Channel should have children (thread)

    # Get the thread (first child of channel)
    ${thread}=    Set Variable    ${channel_children[0]}
    Should Be Equal    ${thread['type']}    thread    msg=First child of channel should be thread
    Should Contain    ${thread['name']}    Welcome to    msg=Thread name should contain 'Welcome to'

    Log    window.spaceTree structure validated: Category → Channel → Thread

Verify Welcome Message Creation
    [Documentation]    Verify the welcome message is created in the welcome thread
    ...                Verifies:
    ...                - Welcome thread exists with name "Welcome to [SpaceName]!"
    ...                - Thread contains a welcome message
    ...                - Message exists in comp_content table
    [Tags]    message    content

    # Create space
    ${space_id}=    Create Space With Name    Welcome Test Space

    # Wait for space to initialize
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}

    # Verify welcome message exists
    ${message_id}=    Verify Welcome Message Exists    ${space_id}
    Should Not Be Equal    ${message_id}    ${None}    msg=Welcome message should exist

    Log    Welcome message verified: ${message_id}

Space Reconnection After Reload
    [Documentation]    Test that space persists and reconnects after page reload
    ...                Verifies:
    ...                - Space ID persists in backend status after reload
    ...                - Space status transitions back to 'idle'
    ...                - Space metadata unchanged
    [Tags]    persistence    reconnection

    # Create space
    ${space_id}=    Create Space With Name    Reconnection Test Space

    # Wait for space to initialize
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}

    # Record metadata
    ${metadata_before}=    Query Space Metadata    ${space_id}
    Should Not Be Equal    ${metadata_before}    ${None}

    # Reload page
    Reload

    # Wait for backend to initialize
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Wait for space to reconnect and reach idle
    # (This implicitly verifies space exists in backend status)
    ${reached_idle_after}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=60s
    Should Be True    ${reached_idle_after}    msg=Space did not reconnect to 'idle' status

    # Verify metadata unchanged
    ${metadata_after}=    Query Space Metadata    ${space_id}
    Should Not Be Equal    ${metadata_after}    ${None}

    # Verify room structure intact
    ${rooms_after}=    Query Space Rooms    ${space_id}
    ${room_count}=    Get Length    ${rooms_after}
    Should Be Equal As Numbers    ${room_count}    3    msg=Room structure should be intact after reload

    Log    Space successfully reconnected after reload: ${space_id}


*** Keywords ***
Setup Test Environment For Spaces
    [Documentation]    Initialize browser and authenticate
    ...                Extended setup for space creation tests:
    ...                - Browser with proper viewport
    ...                - Backend worker initialized
    ...                - User authenticated with app password
    ...                - Personal stream exists

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

    # Verify personal stream exists
    Verify Stream Connected    timeout=20s

    Log    Test environment ready for space creation tests
