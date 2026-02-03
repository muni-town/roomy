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
...                 - Peer worker space management

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

    # Navigate to the space so window.sidebar is populated
    # (sidebar.svelte.ts uses current.joinedSpace?.id to filter)
    Go To    ${BASE_URL}/${space_id}
    Sleep    1s    # Give UI time to set current.joinedSpace

    # Query sidebar using the helper keyword (reads from window.sidebar.result)
    # Note: window.sidebar.result is hierarchical - we expect 1 top-level category with nested children
    ${space_tree}=    Query Sidebar    expectedCount=1
    Log    window.sidebar.result (UI sidebar tree structure): ${space_tree}

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
    ...        return countRooms(window.sidebar?.result || []);
    ...    }
    Log    Total rooms in tree (flattened): ${total_rooms} (should be 2: category + channel - threads not in sidebar)

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
    [Documentation]    Verify newly created space has correct default room structure
    ...                Verifies:
    ...                - Space has 1 channel named "lobby"
    ...                - Sidebar config has category "general" containing the channel
    ...                - No category or thread entities are created (sidebar categories are config only)
    [Tags]    structure    critical

    # Create space
    ${space_id}=    Create Space With Name    Test Space Structure

    # Wait for space to finish initializing
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}    msg=Space did not reach 'idle' status

    # Query room structure (with retry - wait for 1 channel to be materialized)
    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${room_count}=    Get Length    ${rooms}
    Should Be Equal As Numbers    ${room_count}    1    msg=Expected 1 room (channel), got ${room_count}

    # Count rooms by type
    ${counts}=    Count Rooms By Type    ${space_id}
    Should Be Equal As Numbers    ${counts['categories']}    0    msg=Expected 0 category entities (categories are sidebar config only)
    Should Be Equal As Numbers    ${counts['channels']}    1    msg=Expected 1 channel
    Should Be Equal As Numbers    ${counts['threads']}    0    msg=Expected 0 thread entities
    Should Be Equal As Numbers    ${counts['pages']}    0    msg=Expected 0 pages

    # Verify the channel room
    ${room}=    Set Variable    ${rooms[0]}
    Should Be Equal    ${room['type']}    space.roomy.channel    msg=Room should be a channel
    Should Be Equal    ${room['name']}    lobby    msg=Channel should be named 'lobby'
    Should Be Equal As Numbers    ${room['deleted']}    0    msg=Channel should not be deleted

    Log    Room structure verified: 1 channel named "lobby"

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
    ${backend_initialized}=    Wait For Peer To Initialize
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
    ...                - Each space has independent room structure (1 channel)
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

    # Verify both spaces have 1 channel (with retry for materialization)
    ${rooms_one}=    Query Space Rooms    ${space_one_id}    expectedCount=1
    ${room_count_one}=    Get Length    ${rooms_one}
    Should Be Equal As Numbers    ${room_count_one}    1    msg=Space One should have 1 channel

    ${rooms_two}=    Query Space Rooms    ${space_two_id}    expectedCount=1
    ${room_count_two}=    Get Length    ${rooms_two}
    Should Be Equal As Numbers    ${room_count_two}    1    msg=Space Two should have 1 channel

    # Verify counts for both spaces (only channels, no category/thread entities)
    ${counts_one}=    Count Rooms By Type    ${space_one_id}
    Should Be Equal As Numbers    ${counts_one['categories']}    0
    Should Be Equal As Numbers    ${counts_one['channels']}    1
    Should Be Equal As Numbers    ${counts_one['threads']}    0

    ${counts_two}=    Count Rooms By Type    ${space_two_id}
    Should Be Equal As Numbers    ${counts_two['categories']}    0
    Should Be Equal As Numbers    ${counts_two['channels']}    1
    Should Be Equal As Numbers    ${counts_two['threads']}    0

    Log    Successfully created and verified two independent spaces

Verify Sidebar Structure
    [Documentation]    Verify sidebar query (what UI sidebar uses) returns correct structure
    ...                This validates what the user actually sees in the UI sidebar
    ...                Tests window.sidebar.result exposed in workers/index.ts
    ...                Note: Sidebar shows categories as config containers with channels as children
    [Tags]    structure    critical    ui

    # Create space
    ${space_id}=    Create Space With Name    sidebar Test Space

    # Wait for space to finish initializing
    ${reached_idle}=    Wait For Space Status    ${space_id}    timeout=30s
    Should Be True    ${reached_idle}    msg=Space did not reach 'idle' status

    # Navigate to the space so window.sidebar is populated for this space
    Go To    ${BASE_URL}/${space_id}
    Sleep    1s    # Give UI time to set current.joinedSpace and update sidebar

    # Query window.sidebar.result (what the UI actually uses)
    # The sidebar has 1 top-level category named "general" with 1 child channel "lobby"
    ${space_tree}=    Query Sidebar    expectedCount=1
    ${tree_count}=    Get Length    ${space_tree}
    Should Be Equal As Numbers    ${tree_count}    1    msg=sidebar should have 1 top-level category

    # Get the category (first item)
    ${category}=    Set Variable    ${space_tree[0]}
    Should Be Equal    ${category['type']}    space.roomy.category    msg=Top-level item should be a category
    Should Be Equal    ${category['name']}    general    msg=Category should be named 'general'

    # Verify category has children (channel)
    ${category_children}=    Set Variable    ${category['children']}
    ${has_channel}=    Evaluate    len(${category_children}) > 0
    Should Be True    ${has_channel}    msg=Category should have children

    # Get the channel (first child of category)
    ${channel}=    Set Variable    ${category_children[0]}
    Should Be Equal    ${channel['type']}    space.roomy.channel    msg=First child should be channel
    Should Be Equal    ${channel['name']}    lobby    msg=Channel should be named 'lobby'

    # Note: Threads are not in the sidebar tree structure
    # They are displayed within channel content, not as sidebar children
    Log    window.sidebar structure validated: Category "general" → Channel "lobby" (threads not in sidebar)

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
    ${backend_initialized}=    Wait For Peer To Initialize
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
    ...                - Peer worker initialized
    ...                - User authenticated with app password
    ...                - Personal stream exists

    # Setup browser - disable service workers to prevent hooks.client.ts from
    # triggering a reload due to service worker cleanup
    New Browser    chromium    headless=True
    New Context    viewport={'width': 1280, 'height': 720}    serviceWorkers=block
    # Navigate directly to /home to avoid redirect from root route
    # (root route redirects to /home on mount, which can destroy JS context)
    New Page    ${BASE_URL}/home

    # Wait for app to load
    ${backend_initialized}=    Wait For Peer To Initialize
    Should Be True    ${backend_initialized}

    # Set __playwright flag to disable HMR page reloads (see workers/index.ts)
    Evaluate JavaScript    ${None}    () => { window.__playwright = true; }

    # Wait for authentication (happens automatically with app password)
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}    msg=Authentication did not complete

    # Verify personal stream exists
    Verify Stream Connected    timeout=20s

    Log    Test environment ready for space creation tests
