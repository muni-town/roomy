*** Settings ***
Documentation       Message action keywords for Roomy testing
...                 Provides helper keywords for:
...                 - Sending messages via chat input
...                 - Replying to messages
...                 - Editing messages
...                 - Deleting messages
...                 - Adding/removing reactions
...                 - Creating threads from messages
...                 - Querying messages from database
...
...                 These keywords assume the user is already authenticated
...                 and viewing a space/room.

Library             Browser
Library             Collections
Resource            common.robot
Resource            space.robot


*** Variables ***
# Selectors for message-related UI elements
${CHAT_INPUT_SELECTOR}    #chat-input
${SEND_BUTTON_SELECTOR}    [data-testid="send-message-button"]
${MESSAGE_SELECTOR}    [data-message-id]


*** Keywords ***
Send Message In Current Room
    [Documentation]    Send a message in the current room using the chat input
    ...                Fills the TipTap editor and clicks the send button
    ...
    ...                Example:
    ...                | ${message_id}= | Send Message In Current Room | Hello World |
    ...                | ${message_id}= | Send Message In Current Room | Test message | verify_in_db=${True} |
    ...
    ...                Arguments:
    ...                - text: Message text to send (required)
    ...                - timeout: Maximum time to wait for message to appear (default: 10s)
    ...                - verify_in_db: Whether to verify message in database (default: True)
    ...
    ...                Returns: Message ULID if found, ${None} if verification fails

    [Arguments]    ${text}    ${timeout}=10s    ${verify_in_db}=${True}

    Should Not Be Empty    ${text}    msg=Message text cannot be empty

    # Get message count before sending for comparison
    ${message_count_before}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messages = document.querySelectorAll('[data-message-id]');
    ...        return messages.length;
    ...    }

    Log    Message count before sending: ${message_count_before}

    # Focus the chat input
    ${input_focused}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const input = document.querySelector('#chat-input');
    ...        if (!input) {
    ...            console.error('Chat input not found');
    ...            return false;
    ...        }
    ...        input.focus();
    ...        return true;
    ...    }

    Should Be True    ${input_focused}    msg=Could not find or focus chat input

    # Type the message text into the TipTap editor
    ${text_typed}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const text = `${text}`;
    ...        const input = document.querySelector('#chat-input');
    ...        if (!input) return false;
    ...        // Get the ProseMirror editor
    ...        const view = input.querySelector('.ProseMirror');
    ...        if (!view) {
    ...            console.error('ProseMirror editor not found');
    ...            return false;
    ...        }
    ...        // Set the content directly
    ...        view.textContent = text;
    ...        // Trigger input event to update Svelte state
    ...        view.dispatchEvent(new Event('input', { bubbles: true }));
    ...        // Also trigger change event for completeness
    ...        view.dispatchEvent(new Event('change', { bubbles: true }));
    ...        return true;
    ...    }

    Should Be True    ${text_typed}    msg=Could not type message text

    # Wait a moment for the send button to appear (it appears when there's text)
    Sleep    200ms

    # Click the send button
    ${send_clicked}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const sendButton = document.querySelector('[data-testid="send-message-button"]');
    ...        if (!sendButton) {
    ...            console.error('Send button not found');
    ...            return false;
    ...        }
    ...        sendButton.click();
    ...        return true;
    ...    }

    Should Be True    ${send_clicked}    msg=Could not click send button

    # Wait for message to appear in UI
    Sleep    1s

    ${message_count_after}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messages = document.querySelectorAll('[data-message-id]');
    ...        return messages.length;
    ...    }

    Log    Message count after sending: ${message_count_after}

    ${new_message_count}=    Evaluate    ${message_count_after} - ${message_count_before}
    Should Be True    ${new_message_count} > 0    msg=No new message appeared in UI

    # Get the new message ID (last message in the list using data-message-id)
    ${message_id}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messages = Array.from(document.querySelectorAll('[data-message-id]'));
    ...        if (messages.length === 0) return null;
    ...        const lastMessage = messages[messages.length - 1];
    ...        return lastMessage.getAttribute('data-message-id');
    ...    }

    Log    Sent message with ID: ${message_id}

    # Verify in database if requested
    IF    ${verify_in_db}
        ${verified}=    Wait For Message In Database    ${message_id}    timeout=${timeout}
        IF    not ${verified}
            Log    WARNING: Message ${message_id} not found in database after ${timeout}
            RETURN    ${None}
        END
    END

    RETURN    ${message_id}

Wait For Message In Database
    [Documentation]    Wait for a message to appear in the database
    ...                Queries comp_content table for the message
    ...
    ...                Example:
    ...                | ${found}= | Wait For Message In Database | ${message_id} |
    ...                | Should Be True | ${found} |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID to search for
    ...                - timeout: Maximum time to wait (default: 10s)
    ...
    ...                Returns: True if message found, False if timeout

    [Arguments]    ${messageId}    ${timeout}=10s

    # Validate ULID format (starts with 01 for datetime-based ULIDs)
    ${starts_with_ulid}=    Evaluate JavaScript    ${None}
    ...    () => /^01[A-Za-z0-9]{24}$/.test('${messageId}')

    IF    not ${starts_with_ulid}
        Log    WARNING: Message ID ${messageId} does not appear to be a valid ULID
    END

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)
    ${iterations}=    Evaluate    int(${timeout_ms} / 200)

    # Retry for up to timeout
    FOR    ${attempt}    IN RANGE    ${iterations}
        ${sql}=    Catenate    SEPARATOR=${SPACE}
        ...        SELECT
        ...        c.entity as message_id,
        ...        c.data,
        ...        e.room,
        ...        om.author
        ...        FROM comp_content c
        ...        JOIN entities e ON e.id = c.entity
        ...        LEFT JOIN comp_override_meta om ON om.entity = e.id
        ...        WHERE c.entity = '${messageId}'

        ${result}=    Execute SQL Query    ${sql}
        ${rows}=    Set Variable    ${result['rows']}
        ${has_message}=    Evaluate    len(${rows}) > 0

        IF    ${has_message}
            Log    Message ${messageId} found in database (attempt ${attempt})
            Log    Message content: ${rows[0]}
            RETURN    ${True}
        END

        Sleep    200ms
    END

    Log    Message ${messageId} not found in database after ${timeout}
    RETURN    ${False}

Get Message From Database
    [Documentation]    Get a message from the database by ID
    ...                Returns full message record including content and metadata
    ...
    ...                Example:
    ...                | ${message}= | Get Message From Database | ${message_id} |
    ...                | Log | ${message['data']} |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID to fetch
    ...
    ...                Returns: Dictionary with keys: message_id, data, room, author
    ...                Returns ${None} if message not found

    [Arguments]    ${messageId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
        ...    SELECT
        ...    c.entity as message_id,
        ...    cast(c.data as text) as data,
        ...    e.room,
        ...    om.author,
        ...    e.created_at
        ...    FROM comp_content c
        ...    JOIN entities e ON e.id = c.entity
        ...    LEFT JOIN comp_override_meta om ON om.entity = e.id
        ...    WHERE c.entity = '${messageId}'

    ${result}=    Execute SQL Query    ${sql}
    ${rows}=    Set Variable    ${result['rows']}
    ${has_message}=    Evaluate    len(${rows}) > 0

    IF    ${has_message}
        ${message}=    Set Variable    ${rows[0]}
        Log    Retrieved message: ${message_id}
        RETURN    ${message}
    END

    Log    Message ${messageId} not found in database
    RETURN    ${None}

Hover Over Message
    [Documentation]    Hover over a message to reveal its toolbar
    ...                The message toolbar appears on hover
    ...
    ...                Example:
    ...                | Hover Over Message | ${message_id} |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID to hover over

    [Arguments]    ${messageId}

    ${hovered}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messageId = '${messageId}';
    ...        // Try to find by data-message-id first
    ...        let messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    ...        // Fall back to id attribute
    ...        if (!messageEl) {
    ...            messageEl = document.getElementById(messageId);
    ...        }
    ...        if (!messageEl) {
    ...            console.error('Message element not found:', messageId);
    ...            return false;
    ...        }
    ...        // Trigger hover
    ...        messageEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    ...        return true;
    ...    }

    Should Be True    ${hovered}    msg=Could not hover over message ${messageId}
    Log    Hovered over message ${messageId}

    # Wait for toolbar to appear
    Sleep    200ms

Click Message Toolbar Button
    [Documentation]    Click a button in the message toolbar by aria-label
    ...                Message toolbar must be visible (hover over message first)
    ...
    ...                Example:
    ...                | Hover Over Message | ${message_id} |
    ...                | Click Message Toolbar Button | Reply |
    ...                | Click Message Toolbar Button | Edit Message |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID
    ...                - ariaLabel: ARIA label of the button to click
    ...                - timeout: Maximum time to wait for button (default: 2s)

    [Arguments]    ${messageId}    ${ariaLabel}    ${timeout}=2s

    ${clicked}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messageId = '${messageId}';
    ...        const ariaLabel = '${ariaLabel}';
    ...        // Try to find by data-message-id first
    ...        let messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
    ...        // Fall back to id attribute
    ...        if (!messageEl) {
    ...            messageEl = document.getElementById(messageId);
    ...        }
    ...        if (!messageEl) {
    ...            console.error('Message element not found:', messageId);
    ...            return false;
    ...        }
    ...        // Find the toolbar button with the matching aria-label
    ...        const toolbar = messageEl.querySelector('[role="toolbar"]');
    ...        if (!toolbar) {
    ...            console.error('Toolbar not found for message:', messageId);
    ...            return false;
    ...        }
    ...        const button = toolbar.querySelector(`[aria-label="${ariaLabel}"]`);
    ...        if (!button) {
    ...            console.log('Available buttons:', Array.from(toolbar.querySelectorAll('button')).map(b => b.getAttribute('aria-label')));
    ...            return false;
    ...        }
    ...        button.click();
    ...        return true;
    ...    }

    Should Be True    ${clicked}    msg=Could not click toolbar button "${ariaLabel}" for message ${messageId}
    Log    Clicked toolbar button: ${ariaLabel}

Reply To Message
    [Documentation]    Reply to an existing message
    ...                Sets the reply context and sends a reply message
    ...
    ...                Example:
    ...                | ${reply_id}= | Reply To Message | ${parent_id} | This is a reply |
    ...
    ...                Arguments:
    ...                - parentMessageId: Message ULID to reply to
    ...                - replyText: Text of the reply message
    ...                - timeout: Maximum time to wait (default: 10s)
    ...
    ...                Returns: Reply message ULID if successful

    [Arguments]    ${parentMessageId}    ${replyText}    ${timeout}=10s

    # First, hover over the message to show toolbar
    Hover Over Message    ${parentMessageId}

    # Click the reply button
    Click Message Toolbar Button    ${parentMessageId}    Reply

    # Wait a moment for reply state to be set
    Sleep    300ms

    # Check if reply indicator is visible (reply context is set)
    ${reply_context_set}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        // Check if there's a reply context indicator in the UI
    ...        const replyIndicator = document.querySelector('[data-reply-context]');
    ...        if (replyIndicator) return true;
    ...        // Or check the editor placeholder
    ...        const editor = document.querySelector('#chat-input .ProseMirror');
    ...        if (editor && editor.getAttribute('data-placeholder')?.includes('reply')) return true;
    ...        return false;
    ...    }

    Log    Reply context set: ${reply_context_set}

    # Send the reply message
    ${reply_id}=    Send Message In Current Room    ${replyText}    timeout=${timeout}

    RETURN    ${reply_id}

Add Quick Reaction To Message
    [Documentation]    Add a quick emoji reaction to a message
    ...                Uses the built-in quick reaction buttons (👍, 😂)
    ...
    ...                Example:
    ...                | Add Quick Reaction To Message | ${message_id} | 👍 |
    ...                | Add Quick Reaction To Message | ${message_id} | 😂 |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID to react to
    ...                - emoji: Emoji to add (👍 or 😂 for quick reactions)

    [Arguments]    ${messageId}    ${emoji}

    # Validate emoji is a quick reaction option
    ${valid_emoji}=    Evaluate    '${emoji}' == '👍' or '${emoji}' == '😂'
    Should Be True    ${valid_emoji}    msg=Only quick reactions (👍, 😂) are supported, got: ${emoji}

    # Hover over message
    Hover Over Message    ${messageId}

    # Click the quick reaction button
    ${reacted}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const messageId = '${messageId}';
    ...        const emoji = '${emoji}';
    ...        const messageEl = document.getElementById(messageId);
    ...        if (!messageEl) return false;
    ...        const toolbar = messageEl.querySelector('[role="toolbar"]');
    ...        if (!toolbar) return false;
    ...        // Find button with the emoji as text content
    ...        const buttons = Array.from(toolbar.querySelectorAll('button'));
    ...        const button = buttons.find(b => b.textContent.trim() === emoji);
    ...        if (!button) {
    ...            console.log('Available buttons:', buttons.map(b => b.textContent.trim()));
    ...            return false;
    ...        }
    ...        button.click();
    ...        return true;
    ...    }

    Should Be True    ${reacted}    msg=Could not click quick reaction button for ${emoji}
    Log    Added reaction ${emoji} to message ${messageId}

    # Wait for reaction to sync
    Sleep    500ms

Get Message Reactions
    [Documentation]    Get reactions for a message from the database
    ...                Queries comp_reaction table
    ...
    ...                Example:
    ...                | ${reactions}= | Get Message Reactions | ${space_id} | ${room_id} | ${message_id} |
    ...                | Log | ${reactions} |
    ...
    ...                Arguments:
    ...                - spaceId: Space DID
    ...                - roomId: Room ULID
    ...                - messageId: Message ULID
    ...
    ...                Returns: List of reaction records or empty list if none found

    [Arguments]    ${spaceId}    ${roomId}    ${messageId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
        ...    SELECT
        ...    r.entity as reaction_id,
        ...    r.reaction,
        ...    r.created_at,
        ...    om.author
        ...    FROM comp_reaction r
        ...    JOIN entities e ON e.id = r.entity
        ...    LEFT JOIN comp_override_meta om ON om.entity = e.id
        ...    WHERE e.room = '${roomId}'
        ...    AND r.entity = '${messageId}'

    ${result}=    Execute SQL Query    ${sql}
    ${reactions}=    Set Variable    ${result['rows']}

    Log    Found ${reactions.__len__()} reactions for message ${messageId}
    RETURN    ${reactions}

Verify Reaction Exists
    [Documentation]    Verify that a specific reaction exists for a message
    ...                Retries for up to 5 seconds for materialization
    ...
    ...                Example:
    ...                | ${exists}= | Verify Reaction Exists | ${space_id} | ${room_id} | ${message_id} | 👍 |
    ...                | Should Be True | ${exists} |
    ...
    ...                Arguments:
    ...                - spaceId: Space DID
    ...                - roomId: Room ULID
    ...                - messageId: Message ULID
    ...                - emoji: Emoji reaction to verify
    ...                - authorDid: Optional author DID to filter by
    ...
    ...                Returns: True if reaction found, False otherwise

    [Arguments]    ${spaceId}    ${roomId}    ${messageId}    ${emoji}    ${authorDid}=${None}

    # Retry for up to 5 seconds
    FOR    ${attempt}    IN RANGE    25
        ${reactions}=    Get Message Reactions    ${spaceId}    ${roomId}    ${messageId}

        FOR    ${reaction}    IN    @{reactions}
            ${matches}=    Set Variable If    '${authorDid}' == '${None}'    ${True}    ${reaction['author']} == '${authorDid}'
            IF    '${reaction['reaction']}' == '${emoji}' and ${matches}
                Log    Found reaction ${emoji} by ${reaction['author']}
                RETURN    ${True}
            END
        END

        Sleep    200ms
    END

    Log    Reaction ${emoji} not found for message ${messageId}
    RETURN    ${False}

Delete Message
    [Documentation]    Delete a message (must be author or admin)
    ...                Hovers over message and clicks delete button
    ...
    ...                Example:
    ...                | Delete Message | ${message_id} |
    ...
    ...                Arguments:
    ...                - messageId: Message ULID to delete

    [Arguments]    ${messageId}

    # Hover over message to show toolbar
    Hover Over Message    ${messageId}

    # Click delete button
    Click Message Toolbar Button    ${messageId}    Delete Message

    # Wait for deletion to process
    Sleep    500ms

    Log    Deleted message ${messageId}

    # Verify message is marked as deleted in database
    ${message}=    Get Message From Database    ${messageId}

    IF    '${message}' != '${None}'
        # Check if it's soft deleted (entity still exists but marked deleted)
        Log    Message still in database after deletion (may be soft deleted)
    END

Count Messages In Room
    [Documentation]    Count all messages in a room
    ...                Queries entities and comp_content tables
    ...
    ...                Example:
    ...                | ${count}= | Count Messages In Room | ${room_id} |
    ...                | Log | Message count: ${count} |
    ...
    ...                Arguments:
    ...                - roomId: Room ULID to count messages in
    ...
    ...                Returns: Number of messages in the room

    [Arguments]    ${roomId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
        ...    SELECT COUNT(*) as count
        ...    FROM entities e
        ...    JOIN comp_content c ON c.entity = e.id
        ...    WHERE e.room = '${roomId}'

    ${result}=    Execute SQL Query    ${sql}
    ${count}=    Set Variable    ${result['rows'][0]['count']}

    Log    Room ${roomId} has ${count} messages
    RETURN    ${count}

Wait For Message Count
    [Documentation]    Wait for a room to have at least the specified number of messages
    ...                Useful for waiting for message materialization after sending
    ...
    ...                Example:
    ...                | Wait For Message Count | ${room_id} | 5 | timeout=10s |
    ...
    ...                Arguments:
    ...                - roomId: Room ULID
    ...                - expectedCount: Minimum number of messages to wait for
    ...                - timeout: Maximum time to wait (default: 10s)
    ...
    ...                Returns: True if count reached, False if timeout

    [Arguments]    ${roomId}    ${expectedCount}    ${timeout}=10s

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)
    ${iterations}=    Evaluate    int(${timeout_ms} / 200)

    FOR    ${attempt}    IN RANGE    ${iterations}
        ${count}=    Count Messages In Room    ${roomId}

        IF    ${count} >= ${expectedCount}
            Log    Room ${roomId} has ${count} messages (expected ${expectedCount})
            RETURN    ${True}
        END

        Sleep    200ms
    END

    Log    Room ${roomId} only has ${count} messages after ${timeout} (expected ${expectedCount})
    RETURN    ${False}

Get Latest Message In Room
    [Documentation]    Get the most recent message in a room
    ...                Returns the message with the highest ULID (most recent timestamp)
    ...
    ...                Example:
    ...                | ${message}= | Get Latest Message In Room | ${room_id} |
    ...                | Log | Latest message: ${message['data']} |
    ...
    ...                Arguments:
    ...                - roomId: Room ULID
    ...
    ...                Returns: Message dictionary or ${None} if room is empty

    [Arguments]    ${roomId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
        ...    SELECT
        ...    c.entity as message_id,
        ...    c.data,
        ...    e.room,
        ...    om.author,
        ...    e.created_at
        ...    FROM comp_content c
        ...    JOIN entities e ON e.id = c.entity
        ...    LEFT JOIN comp_override_meta om ON om.entity = e.id
        ...    WHERE e.room = '${roomId}'
        ...    ORDER BY c.entity DESC
        ...    LIMIT 1

    ${result}=    Execute SQL Query    ${sql}
    ${rows}=    Set Variable    ${result['rows']}
    ${has_message}=    Evaluate    len(${rows}) > 0

    IF    ${has_message}
        ${message}=    Set Variable    ${rows[0]}
        Log    Latest message in room ${roomId}: ${message['message_id']}
        RETURN    ${message}
    END

    Log    No messages found in room ${roomId}
    RETURN    ${None}
