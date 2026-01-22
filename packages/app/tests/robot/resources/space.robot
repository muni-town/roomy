*** Settings ***
Documentation       Space management keywords for Roomy testing
...                 Provides helper keywords for:
...                 - Creating and managing spaces
...                 - Querying space metadata and rooms from database
...                 - Verifying space status and structure
...                 - Database verification via SQL queries
...
...                 These keywords assume the user is already authenticated.
...                 Use auth.robot or stream.robot keywords for authentication setup.

Library             Browser
Library             DateTime
Library             Collections


*** Keywords ***
Dump Database State For Space
    [Documentation]    Diagnostic keyword to dump all database tables for a space
    ...                Shows entities, comp_room, comp_info, events to debug materialization
    [Arguments]    ${spaceId}

    Log    ===== DATABASE DUMP FOR SPACE ${spaceId} =====

    # Dump entities table
    ${entities_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT id, stream_id, room
    ...    FROM entities WHERE stream_id = '${spaceId}'
    ...    ORDER BY id
    ${entities}=    Execute SQL Query    ${entities_sql}
    Log    ENTITIES (${entities['rows'].__len__()} rows):
    FOR    ${row}    IN    @{entities['rows']}
        Log    - id=${row['id']}, stream_id=${row['stream_id']}, room=${row['room']}
    END

    # Dump comp_room table
    ${rooms_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT r.entity as entity, r.label, r.deleted
    ...    FROM comp_room r
    ...    JOIN entities e ON e.id = r.entity
    ...    WHERE e.stream_id = '${spaceId}'
    ${rooms}=    Execute SQL Query    ${rooms_sql}
    Log    COMP_ROOM (${rooms['rows'].__len__()} rows):
    FOR    ${row}    IN    @{rooms['rows']}
        Log    - entity=${row['entity']}, label=${row['label']}, deleted=${row['deleted']}
    END

    # Dump comp_info table
    ${info_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT i.entity as entity, i.name
    ...    FROM comp_info i
    ...    JOIN entities e ON e.id = i.entity
    ...    WHERE e.stream_id = '${spaceId}'
    ${info}=    Execute SQL Query    ${info_sql}
    Log    COMP_INFO (${info['rows'].__len__()} rows):
    FOR    ${row}    IN    @{info['rows']}
        Log    - entity=${row['entity']}, name=${row['name']}
    END

    # Dump events count
    ${events_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT COUNT(*) as count FROM events
    ...    WHERE stream_id = '${spaceId}'
    ${events}=    Execute SQL Query    ${events_sql}
    Log    EVENTS COUNT: ${events['rows'][0]['count']}

Execute SQL Query
    [Documentation]    Execute arbitrary SQL query via backend.runQuery()
    ...                Foundation keyword for all database verification.
    ...
    ...                Example:
    ...                | ${results}= | Execute SQL Query | SELECT 1 as test |
    ...                | Log | ${results} |
    ...
    ...                Arguments:
    ...                - sql: SQL query string
    ...
    ...                Returns: Query results as list of dictionaries

    [Arguments]    ${sql}

    ${result}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        const sql = `${sql}`;
    ...        try {
    ...            const result = await window.backend.runQuery({ sql });
    ...            return result;
    ...        } catch (error) {
    ...            console.error('SQL query failed:', error);
    ...            throw error;
    ...        }
    ...    }

    Log    SQL Query: ${sql}
    Log    Result: ${result}
    RETURN    ${result}

Create Space With Name
    [Documentation]    Create a new space using the UI form
    ...                This navigates to /new and fills out the create space form
    ...
    ...                Example:
    ...                | ${space_id}= | Create Space With Name | My Test Space |
    ...                | ${space_id}= | Create Space With Name | My Space | description=A great space |
    ...
    ...                Arguments:
    ...                - name: Space name (required)
    ...                - description: Space description (optional, default: empty string)
    ...
    ...                Returns: Space ID (DidStream)

    [Arguments]    ${name}    ${description}=${EMPTY}

    Should Not Be Empty    ${name}    msg=Space name is required

    # First, verify the backend is in the right state
    ${pre_check}=    Evaluate JavaScript    ${None}
    ...    () => ({
    ...        hasBackend: !!window.backend,
    ...        roomyState: window.backendStatus?.current?.roomyState?.state,
    ...        hasPersonalSpace: !!window.backendStatus?.current?.roomyState?.personalSpace,
    ...        personalSpace: window.backendStatus?.current?.roomyState?.personalSpace
    ...    })
    Log    Pre-check state: ${pre_check}
    Should Be Equal    ${pre_check}[roomyState]    connected    msg=Backend must be connected before creating space

    # Navigate to the create space page
    Go To    ${BASE_URL}/new
    Wait For Load State    networkidle    timeout=10s

    # Fill in the space name
    Fill Text    id=name    ${name}

    # Fill in description if provided
    IF    '${description}' != '${EMPTY}'
        Fill Text    textarea    ${description}
    END

    # Get the current URL to compare after form submission
    ${before_url}=    Get Url

    # Submit the form
    Click    button[type="submit"]

    # Wait for URL to change from /new to something else (the new space)
    Wait For Load State    networkidle    timeout=30s

    # Wait until URL changes from /new
    ${new_url}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const check = () => {
    ...            if (!window.location.pathname.endsWith('/new')) {
    ...                resolve(window.location.href);
    ...            } else {
    ...                setTimeout(check, 100);
    ...            }
    ...        };
    ...        check();
    ...        // Timeout after 25s
    ...        setTimeout(() => resolve(window.location.href), 25000);
    ...    })
    Log    Navigated to: ${new_url}

    # Parse the space ID from the URL (format: http://127.0.0.1:5173/did:plc:xxxx)
    ${space_id}=    Evaluate JavaScript    ${None}
    ...    () => window.location.pathname.split('/')[1] || null

    Should Not Be Empty    ${space_id}    msg=Space ID should not be empty (URL: ${new_url})
    Log    Created space: ${space_id}
    RETURN    ${space_id}

Wait For Space Status
    [Documentation]    Poll until space reaches target status in backend
    ...                Checks window.backendStatus.spaces[spaceId] for status
    ...
    ...                Example:
    ...                | ${reached}= | Wait For Space Status | ${space_id} |
    ...                | Should Be True | ${reached} |
    ...                | ${reached}= | Wait For Space Status | ${space_id} | expectedStatus=loading | timeout=10s |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to monitor
    ...                - expectedStatus: Target status (default: "idle")
    ...                - timeout: Maximum wait time (default: 20s)
    ...
    ...                Returns: True if status reached, False if timeout

    [Arguments]    ${spaceId}    ${expectedStatus}=idle    ${timeout}=20s

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)

    ${reached}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const spaceId = '${spaceId}';
    ...        const expectedStatus = '${expectedStatus}';
    ...        const timeoutMs = ${timeout_ms};
    ...        const start = Date.now();
    ...        const check = () => {
    ...            const status = window.backendStatus?.current?.spaces?.[spaceId];
    ...            console.log('[Wait For Space Status] spaceId=', spaceId, ', current=', status, ', expected=', expectedStatus);
    ...            if (status === expectedStatus) {
    ...                resolve(true);
    ...            } else if (Date.now() - start < timeoutMs) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.log('Timeout waiting for space status. Expected:', expectedStatus, ', Got:', status);
    ...                resolve(false);
    ...            }
    ...        };
    ...        check();
    ...    })

    Log    Space ${spaceId} reached status: ${expectedStatus} = ${reached}
    RETURN    ${reached}

Get Space Status
    [Documentation]    Get current status of a space from backend
    ...                Returns status from window.backendStatus.spaces[spaceId]
    ...
    ...                Example:
    ...                | ${status}= | Get Space Status | ${space_id} |
    ...                | Should Be Equal | ${status} | idle |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to query
    ...
    ...                Possible return values:
    ...                - 'loading': Space is being loaded/backfilled
    ...                - 'idle': Space is ready
    ...                - 'error': Space encountered an error
    ...                - ${None}: Space not found in backend status

    [Arguments]    ${spaceId}

    ${status}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const spaceId = '${spaceId}';
    ...        const status = window.backendStatus?.current?.spaces?.[spaceId];
    ...        console.log('Space', spaceId, 'status:', status);
    ...        return status || null;
    ...    }

    Log    Space ${spaceId} status: ${status}
    RETURN    ${status}

Send Space Join Event
    [Documentation]    Send space.roomy.space.personal.joinSpace.v0 event to personal stream
    ...                Makes the authenticated user join the specified space
    ...
    ...                Example:
    ...                | Send Space Join Event | ${space_id} |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to join
    ...
    ...                Note: This is called automatically by createSpace mutation,
    ...                but provided here for testing specific scenarios

    [Arguments]    ${spaceId}

    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        const spaceDid = '${spaceId}';
    ...        const personalStreamId = window.backendStatus?.current?.roomyState?.personalSpace;
    ...        if (!personalStreamId) {
    ...            throw new Error('Personal space ID not found');
    ...        }
    ...        // Generate a simple ULID-like ID for testing (not cryptographically secure)
    ...        const id = Date.now().toString(36) + Math.random().toString(36).substring(2);
    ...        await window.backend.sendEvent(personalStreamId, {
    ...            id: id,
    ...            $type: 'space.roomy.space.personal.joinSpace.v0',
    ...            spaceDid: spaceDid
    ...        });
    ...        console.log('Sent space.join event for space:', spaceDid);
    ...    }

    Log    Sent join event for space: ${spaceId}

Query Space Metadata
    [Documentation]    Get space metadata from comp_space and comp_info tables
    ...                Queries database for space name, avatar, description, and hidden status
    ...
    ...                Example:
    ...                | ${metadata}= | Query Space Metadata | ${space_id} |
    ...                | Should Be Equal | ${metadata['name']} | My Space |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to query
    ...
    ...                Returns: Dictionary with keys: id, name, avatar, description, hidden
    ...                Returns ${None} if space not found

    [Arguments]    ${spaceId}

    # Prepare the SQL query with the space ID
    ${sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT
    ...    cs.entity as id,
    ...    ci.name,
    ...    ci.avatar,
    ...    ci.description,
    ...    cs.hidden
    ...    FROM comp_space cs
    ...    LEFT JOIN comp_info ci ON ci.entity = cs.entity
    ...    WHERE cs.entity = '${spaceId}'

    ${results}=    Execute SQL Query    ${sql}

    ${rows}=    Set Variable    ${results['rows']}
    ${metadata}=    Set Variable If    ${rows}    ${rows[0]}    ${None}
    Log    Space metadata for ${spaceId}: ${metadata}
    RETURN    ${metadata}

Query Space Rooms
    [Documentation]    Get all rooms in a space from database
    ...                Queries entities, comp_room, and comp_info tables
    ...
    ...                Example:
    ...                | ${rooms}= | Query Space Rooms | ${space_id} |
    ...                | ${room_count}= | Get Length | ${rooms} |
    ...                | Should Be Equal As Numbers | ${room_count} | 3 |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to query
    ...                - expectedCount: Optional - if provided, will retry for up to 5s until this many rooms appear
    ...
    ...                Returns: List of dictionaries with keys: id, type, name, parent, deleted

    [Arguments]    ${spaceId}    ${expectedCount}=${None}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT
    ...    e.id as id,
    ...    r.label as type,
    ...    i.name,
    ...    e.room as parent,
    ...    r.deleted
    ...    FROM entities e
    ...    JOIN comp_room r ON r.entity = e.id
    ...    LEFT JOIN comp_info i ON i.entity = e.id
    ...    WHERE e.stream_id = '${spaceId}'
    ...    ORDER BY e.id

    # If expectedCount is provided, retry for up to 5 seconds
    IF    '${expectedCount}' != '${None}'
        FOR    ${attempt}    IN RANGE    25
            ${result}=    Execute SQL Query    ${sql}
            ${rooms}=    Set Variable    ${result['rows']}
            ${count}=    Evaluate    len(${rooms})
            IF    ${count} >= ${expectedCount}
                Log    Found ${rooms.__len__()} rooms in space ${spaceId} (expected ${expectedCount})
                RETURN    ${rooms}
            END
            Sleep    200ms
        END
        Log    WARNING: Only found ${rooms.__len__()} rooms after 5 seconds, expected ${expectedCount}
        RETURN    ${rooms}
    END

    ${result}=    Execute SQL Query    ${sql}
    ${rooms}=    Set Variable    ${result['rows']}

    Log    Found ${rooms.__len__()} rooms in space ${spaceId}
    RETURN    ${rooms}

Count Rooms By Type
    [Documentation]    Count rooms by type (category, channel, thread, page) in a space
    ...                Returns dictionary with counts for each room type
    ...
    ...                Example:
    ...                | ${counts}= | Count Rooms By Type | ${space_id} |
    ...                | Should Be Equal As Numbers | ${counts['categories']} | 1 |
    ...                | Should Be Equal As Numbers | ${counts['channels']} | 1 |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to query
    ...
    ...                Returns: Dictionary with keys: categories, channels, threads, pages

    [Arguments]    ${spaceId}

    ${sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT
    ...    r.label,
    ...    COUNT(*) as count
    ...    FROM entities e
    ...    JOIN comp_room r ON r.entity = e.id
    ...    WHERE e.stream_id = '${spaceId}'
    ...    AND (r.deleted = 0 OR r.deleted IS NULL)
    ...    GROUP BY r.label

    ${result}=    Execute SQL Query    ${sql}
    ${results}=    Set Variable    ${result['rows']}

    # Convert results to dictionary with default values
    # Note: Room kinds are now fully-qualified NSIDs like 'space.roomy.channel'
    ${counts}=    Create Dictionary    categories=0    channels=0    threads=0    pages=0
    FOR    ${row}    IN    @{results}
        IF    '${row['label']}' == 'space.roomy.category'
            Set To Dictionary    ${counts}    categories=${row['count']}
        ELSE IF    '${row['label']}' == 'space.roomy.channel'
            Set To Dictionary    ${counts}    channels=${row['count']}
        ELSE IF    '${row['label']}' == 'space.roomy.thread'
            Set To Dictionary    ${counts}    threads=${row['count']}
        ELSE IF    '${row['label']}' == 'space.roomy.page'
            Set To Dictionary    ${counts}    pages=${row['count']}
        END
    END

    Log    Room counts for space ${spaceId}: ${counts}
    RETURN    ${counts}

Query Sidebar
    [Documentation]    Get the actual sidebar result from the UI (window.sidebar.result)
    ...                This is the EXACT data the UI sidebar uses - no query duplication
    ...                Exposed in workers/index.ts for debugging
    ...
    ...                Arguments:
    ...                - expectedCount: Optional - if provided, will retry for up to 10s until this many rooms appear
    ...
    ...                Returns: List of room tree items (same structure as UI uses)

    [Arguments]    ${expectedCount}=${None}

    # If expectedCount is provided, retry for up to 10 seconds
    IF    '${expectedCount}' != '${None}'
        FOR    ${attempt}    IN RANGE    50
            ${tree}=    Evaluate JavaScript    ${None}
            ...    () => window.sidebar?.result || []
            ${count}=    Evaluate    len(${tree})
            IF    ${count} >= ${expectedCount}
                Log    window.sidebar.result has ${count} rooms after ${attempt * 200}ms (expected ${expectedCount})
                RETURN    ${tree}
            END
            Sleep    200ms
        END
        Log    WARNING: window.sidebar.result only has ${count} rooms after 10 seconds, expected ${expectedCount}
        Log    Rooms found: ${tree}
        RETURN    ${tree}
    END

    ${tree}=    Evaluate JavaScript    ${None}
    ...    () => window.sidebar?.result || []
    Log    window.sidebar.result has ${tree.__len__()} rooms
    RETURN    ${tree}

Verify Welcome Message Exists
    [Documentation]    Verify welcome message exists in a space
    ...                Finds the welcome thread and checks for the welcome message
    ...                Retries for up to 5 seconds to allow for materialization
    ...
    ...                Example:
    ...                | ${message_id}= | Verify Welcome Message Exists | ${space_id} |
    ...                | Should Not Be Equal | ${message_id} | ${None} |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to check
    ...
    ...                Returns: Message ID if found, ${None} if not found

    [Arguments]    ${spaceId}

    # First, find all threads in the space
    ${rooms}=    Query Space Rooms    ${spaceId}    expectedCount=3

    # Find the thread (should be named "Welcome to ...")
    ${thread_id}=    Set Variable    ${None}
    FOR    ${room}    IN    @{rooms}
        IF    '${room['type']}' == 'thread'
            ${thread_id}=    Set Variable    ${room['id']}
            Log    Found welcome thread: ${thread_id}
            BREAK
        END
    END

    IF    '${thread_id}' == '${None}'
        Log    Welcome thread not found in space
        RETURN    ${None}
    END

    # Query for message in the thread (with retry for materialization)
    ${sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT
    ...    e.id as message_id,
    ...    c.data,
    ...    om.author as author
    ...    FROM entities e
    ...    JOIN comp_content c ON c.entity = e.id
    ...    LEFT JOIN comp_override_meta om ON om.entity = e.id
    ...    WHERE e.room = '${thread_id}'
    ...    ORDER BY e.id
    ...    LIMIT 1

    # Retry for up to 5 seconds (25 attempts x 200ms)
    FOR    ${attempt}    IN RANGE    25
        ${result}=    Execute SQL Query    ${sql}
        ${results}=    Set Variable    ${result['rows']}
        ${has_results}=    Evaluate    len(${results}) > 0
        IF    ${has_results}
            ${message_id}=    Set Variable    ${results[0]['message_id']}
            Log    Welcome message ID: ${message_id}
            RETURN    ${message_id}
        END
        Sleep    200ms
    END

    Log    No welcome message found after 5 seconds
    RETURN    ${None}

Get Personal Stream ID
    [Documentation]    Get the authenticated user's personal space ID
    ...                Reads from window.backendStatus.current.roomyState.personalSpace
    ...
    ...                Example:
    ...                | ${personal_stream}= | Get Personal Stream ID |
    ...                | Should Not Be Empty | ${personal_stream} |
    ...
    ...                Returns: Personal space ID (DidStream)

    ${personal_stream}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const streamId = window.backendStatus?.current?.roomyState?.personalSpace;
    ...        return streamId || null;
    ...    }

    Should Not Be Empty    ${personal_stream}    msg=Personal space ID not found in backend status
    Log    Personal space ID: ${personal_stream}
    RETURN    ${personal_stream}

Verify Space In Backend Status
    [Documentation]    Verify that a space appears in backend status
    ...                Polls until space appears in window.backendStatus.spaces
    ...
    ...                Example:
    ...                | Verify Space In Backend Status | ${space_id} |
    ...                | Verify Space In Backend Status | ${space_id} | timeout=10s |
    ...
    ...                Arguments:
    ...                - spaceId: Space ID to verify
    ...                - timeout: Maximum time to wait (default: 5s)

    [Arguments]    ${spaceId}    ${timeout}=30s

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)

    ${exists}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        const spaceId = '${spaceId}';
    ...        const timeoutMs = ${timeout_ms};
    ...        const start = Date.now();
    ...        while (Date.now() - start < timeoutMs) {
    ...            const spaces = window.backendStatus?.current?.spaces;
    ...            if (spaces) {
    ...                if (spaceId in spaces) {
    ...                    console.log('Found space in backend status:', spaceId);
    ...                    return true;
    ...                }
    ...            }
    ...            await new Promise(resolve => setTimeout(resolve, 200));
    ...        }
    ...        console.log('Timeout waiting for space. SpaceId:', spaceId);
    ...        console.log('Available spaces:', Object.keys(window.backendStatus?.current?.spaces || {}));
    ...        return false;
    ...    }

    Should Be True    ${exists}    msg=Space ${spaceId} not found in backend status within ${timeout}
    Log    Space ${spaceId} exists in backend status
