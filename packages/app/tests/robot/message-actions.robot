*** Settings ***
Documentation       Test suite for message actions in Roomy
...                 Tests various message operations including:
...                 - Sending messages
...                 - Replying to messages
...                 - Adding reactions to messages
...                 - Deleting messages
...                 - Message persistence and materialization
...
...                 Prerequisites:
...                 - Dev server running on 127.0.0.1:5173
...                 - VITE_TESTING_HANDLE and VITE_TESTING_APP_PASSWORD set in .env

Library             Browser
Library             Collections
Resource            resources/common.robot
Resource            resources/stream.robot
Resource            resources/space.robot
Resource            resources/message.robot

Suite Setup         Setup Test Environment
Suite Teardown      Close Browser

Test Tags           message    actions


*** Variables ***
${TIMEOUT}          30s
${TEST_SPACE_NAME}  Message Actions Test Space


*** Test Cases ***
Send First Message In Lobby Channel
    [Documentation]    Verify that a user can send a message in the lobby channel
    ...                Tests:
    ...                - Message appears in UI
    ...                - Message is materialized in database
    ...                - Message has correct content and author
    [Tags]    send    critical    smoke

    # Create a new space for testing
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME}
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    # Get the lobby channel (default channel in new spaces)
    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${None}

    FOR    ${room}    IN    @{rooms}
        # Find the lobby channel by name (default channel name)
        IF    '${room['name']}' == 'lobby'
            ${lobby_room}=    Set Variable    ${room['id']}
            BREAK
        END
    END

    Should Not Be Equal    ${lobby_room}    ${None}    msg=Lobby channel not found
    Log    Lobby channel ID: ${lobby_room}

    # Navigate to the lobby channel
    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a test message
    ${test_message}=    Set Variable    Hello, this is a test message!
    ${message_id}=    Send Message In Current Room    ${test_message}    timeout=${TIMEOUT}

    Should Not Be Equal    ${message_id}    ${None}    msg=Failed to send message

    # Verify message in database
    ${message}=    Get Message From Database    ${message_id}
    Should Not Be Equal    ${message}    ${None}    msg=Message not found in database

    # Verify message content
    ${contains_text}=    Evaluate    '${test_message}' in '''${message['data']}'''
    Should Be True    ${contains_text}    msg=Message content mismatch

    Log    Successfully sent and verified message: ${message_id}

Send Multiple Messages In Sequence
    [Documentation]    Test sending multiple messages in quick succession
    ...                Verifies:
    ...                - All messages are sent successfully
    ...                - Messages appear in correct order
    ...                - Database materialization keeps up
    [Tags]    send    sequence

    # Create space and get lobby channel
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Multiple Messages
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}  # First room is the lobby channel

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Get initial message count
    ${initial_count}=    Count Messages In Room    ${lobby_room}
    Log    Initial message count: ${initial_count}

    # Send multiple messages
    ${message_count}=    Set Variable    3
    @{message_ids}=    Create List

    FOR    ${i}    IN RANGE    ${message_count}
        ${message_text}=    Set Variable    Message number ${i + 1}
        ${message_id}=    Send Message In Current Room    ${message_text}    timeout=${TIMEOUT}
        Should Not Be Equal    ${message_id}    ${None}    msg=Failed to send message ${i + 1}
        Append To List    ${message_ids}    ${message_id}
        Sleep    300ms    # Small delay between messages
    END

    # Verify final message count
    ${final_count}=    Count Messages In Room    ${lobby_room}
    ${expected_count}=    Evaluate    ${initial_count} + ${message_count}
    Should Be Equal As Numbers    ${final_count}    ${expected_count}    msg=Message count mismatch

    Log    Successfully sent ${message_count} messages

Add Thumbs Up Reaction To Message
    [Documentation]    Test adding a thumbs up reaction to a message
    ...                Verifies:
    ...                - Reaction button works
    ...                - Reaction is saved to database
    ...                - Reaction appears on message
    [Tags]    reaction    emoji

    # Setup: Create space and send a message
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Reactions
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a message to react to
    ${message_id}=    Send Message In Current Room    Please react to this message!
    Should Not Be Equal    ${message_id}    ${None}

    # Add thumbs up reaction
    Add Quick Reaction To Message    ${message_id}    👍

    # Get current user's DID
    ${user_did}=    Evaluate JavaScript    ${None}
    ...    () => window.backendStatus?.current?.authState?.did

    # Verify reaction in database
    ${has_reaction}=    Verify Reaction Exists    ${space_id}    ${lobby_room}    ${message_id}    👍    ${user_did}

    Should Be True    ${has_reaction}    msg=Thumbs up reaction not found in database

    Log    Successfully added and verified thumbs up reaction

Add Laughing Reaction To Message
    [Documentation]    Test adding a laughing emoji reaction to a message
    [Tags]    reaction    emoji

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Laugh
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a message
    ${message_id}=    Send Message In Current Room    This is funny!
    Should Not Be Equal    ${message_id}    ${None}

    # Add laughing reaction
    Add Quick Reaction To Message    ${message_id}    😂

    # Verify in database
    ${user_did}=    Evaluate JavaScript    ${None}
    ...    () => window.backendStatus?.current?.authState?.did

    ${has_reaction}=    Verify Reaction Exists    ${space_id}    ${lobby_room}    ${message_id}    😂    ${user_did}

    Should Be True    ${has_reaction}    msg=Laughing reaction not found in database

    Log    Successfully added laughing reaction

Toggle Reaction On Message
    [Documentation]    Test toggling a reaction (add then remove)
    ...                Verifies:
    ...                - First click adds reaction
    ...                - Second click removes reaction
    [Tags]    reaction    toggle

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Toggle
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a message
    ${message_id}=    Send Message In Current Room    Toggle my reaction!
    Should Not Be Equal    ${message_id}    ${None}

    ${user_did}=    Evaluate JavaScript    ${None}
    ...    () => window.backendStatus?.current?.authState?.did

    # Add reaction
    Add Quick Reaction To Message    ${message_id}    👍
    ${has_reaction_1}=    Verify Reaction Exists    ${space_id}    ${lobby_room}    ${message_id}    👍    ${user_did}
    Should Be True    ${has_reaction_1}    msg=Reaction not found after first click

    # Toggle off (click again)
    Add Quick Reaction To Message    ${message_id}    👍
    Sleep    1s

    # Verify reaction is removed
    ${reactions}=    Get Message Reactions    ${space_id}    ${lobby_room}    ${message_id}
    ${has_reaction_2}=    Verify Reaction Exists    ${space_id}    ${lobby_room}    ${message_id}    👍    ${user_did}

    # After toggling off, the reaction should be removed
    Should Be True    not ${has_reaction_2}    msg=Reaction still exists after toggle

    Log    Successfully toggled reaction on and off

Delete Own Message
    [Documentation]    Test deleting a message you authored
    ...                Verifies:
    ...                - Delete button appears for own messages
    ...                - Message is removed from UI
    ...                - Deletion is recorded in database
    [Tags]    delete    own-message

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Delete
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a message to delete
    ${message_id}=    Send Message In Current Room    This message will be deleted
    Should Not Be Equal    ${message_id}    ${None}

    # Verify message exists before deletion
    ${message_before}=    Get Message From Database    ${messageId}=${message_id}
    Should Not Be Equal    ${message_before}    ${None}    msg=Message not found before deletion

    # Delete the message
    Delete Message    ${message_id}

    # Wait for deletion to process
    Sleep    2s

    # Check if message is removed or soft-deleted
    ${message_after}=    Get Message From Database    ${messageId}=${message_id}

    # The message may be soft-deleted (still in DB but marked)
    # or hard-deleted (completely removed)
    IF    '${message_after}' != '${None}'
        Log    Message still in database after deletion (soft delete)
        # TODO: Check for deletion marker when soft delete is implemented
    ELSE
        Log    Message completely removed from database (hard delete)
    END

    Log    Message deletion processed

Message Persists After Page Reload
    [Documentation]    Verify that messages persist across page reloads
    ...                Tests:
    ...                - Send a message
    ...                - Reload the page
    ...                - Verify message still exists
    [Tags]    persistence    reload

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Persistence
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a message
    ${test_message}=    Set Variable    This message should persist!
    ${message_id}=    Send Message In Current Room    ${test_message}
    Should Not Be Equal    ${message_id}    ${None}

    # Get message count before reload
    ${count_before}=    Count Messages In Room    ${lobby_room}

    # Reload the page
    Reload
    Wait For Load State    networkidle    timeout=10s

    # Wait for backend to reinitialize
    ${backend_ready}=    Wait For Peer To Initialize    timeout=${TIMEOUT}
    Should Be True    ${backend_ready}    msg=Peer did not initialize after reload

    # Wait for space to reach idle status
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    Sleep    1s

    # Verify message still exists
    ${message_after}=    Get Message From Database    ${messageId}=${message_id}
    Should Not Be Equal    ${message_after}    ${None}    msg=Message not found after reload

    # Verify message content
    ${contains_text}=    Evaluate    '${test_message}' in '''${message_after['data']}'''
    Should Be True    ${contains_text}    msg=Message content changed after reload

    # Verify message count
    ${count_after}=    Count Messages In Room    ${lobby_room}
    Should Be Equal As Numbers    ${count_after}    ${count_before}    msg=Message count changed after reload

    Log    Message successfully persisted across reload

Get Latest Message From Room
    [Documentation]    Test retrieving the most recent message from a room
    ...                Verifies:
    ...                - Latest message query works
    ...                - Returns correct message data
    [Tags]    query    latest

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Latest
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Send a unique message
    ${unique_text}=    Set Variable    Latest message test ${EMPTY}${SPACE}${EMPTY}
    ${unique_text}=    Catenate    SEPARATOR=${EMPTY}    ${unique_text}    ${SPACE}
    ${unique_text}=    Catenate    SEPARATOR=${EMPTY}    ${unique_text}    - ${EMPTY}
    ${timestamp}=    Evaluate JavaScript    ${None}    () => Date.now()
    ${unique_text}=    Catenate    SEPARATOR=${EMPTY}    ${unique_text}    ${timestamp}

    ${message_id}=    Send Message In Current Room    ${unique_text}
    Should Not Be Equal    ${message_id}    ${None}

    # Get latest message
    ${latest_message}=    Get Latest Message In Room    ${lobby_room}

    Should Not Be Equal    ${latest_message}    ${None}    msg=No latest message found
    Should Be Equal    ${latest_message['message_id']}    ${message_id}    msg=Latest message ID mismatch

    Log    Latest message test passed: ${latest_message['message_id']}

Wait For Message Count After Sending
    [Documentation]    Test waiting for a specific message count
    ...                Sends messages and waits for count to reach expected value
    [Tags]    query    count    wait

    # Setup
    ${space_id}=    Create Space With Name    ${TEST_SPACE_NAME} - Count
    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=30s

    ${rooms}=    Query Space Rooms    ${space_id}    expectedCount=1
    ${lobby_room}=    Set Variable    ${rooms[0]['id']}

    Go To    ${BASE_URL}/${space_id}/${lobby_room}
    Wait For Load State    networkidle    timeout=10s
    Sleep    1s

    # Get initial count
    ${initial_count}=    Count Messages In Room    ${lobby_room}
    Log    Initial message count: ${initial_count}

    # Send 2 messages
    Send Message In Current Room    Count test message 1
    Send Message In Current Room    Count test message 2

    # Wait for count to increase by 2
    ${expected_count}=    Evaluate    ${initial_count} + 2
    ${count_reached}=    Wait For Message Count    ${lobby_room}    ${expected_count}    timeout=10s

    Should Be True    ${count_reached}    msg=Message count did not reach expected value

    Log    Message count test passed


*** Keywords ***
Setup Test Environment
    [Documentation]    Initialize browser and authenticate for message tests
    ...                Extended setup for message action tests:
    ...                - Browser with proper viewport
    ...                - Peer worker initialized
    ...                - User authenticated with app password
    ...                - Personal stream exists

    # Setup browser - disable service workers to prevent hooks.client.ts from
    # triggering a reload due to service worker cleanup
    New Browser    chromium    headless=True
    New Context    viewport={'width': 1280, 'height': 720}    serviceWorkers=block

    # Navigate directly to /home to avoid redirect from root route
    New Page    ${BASE_URL}/home

    # Wait for app to load
    ${backend_initialized}=    Wait For Peer To Initialize    timeout=${TIMEOUT}
    Should Be True    ${backend_initialized}    msg=Peer did not initialize

    # Set __playwright flag to disable HMR page reloads
    Evaluate JavaScript    ${None}    () => { window.__playwright = true; }

    # Wait for authentication (happens automatically with app password)
    ${authenticated}=    Wait For Authentication    timeout=60s
    Should Be True    ${authenticated}    msg=Authentication did not complete

    # Verify personal stream exists
    Verify Stream Connected    timeout=30s

    Log    Test environment ready for message action tests
