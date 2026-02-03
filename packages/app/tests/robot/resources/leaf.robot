*** Settings ***
Documentation       Leaf CLI integration keywords for Roomy testing
...                 Provides helper keywords for:
...                 - Querying Leaf server streams directly
...                 - Sending test events to streams
...                 - Generating programmatic test fixtures
...                 - Verifying stream state independent of client
...
...                 These keywords wrap the 'leaf' CLI tool which must be installed globally.
...                 Installation: cd /Users/meri/Code/muni/leaf/clients/typescript && pnpm link --global

Library             Browser
Library             OperatingSystem
Library             Process
Library             Collections


*** Variables ***
${LEAF_URL}         http://localhost:5530
${LEAF_TOKEN}       test123
${LEAF_CLI_DID}     did:web:localhost


*** Keywords ***
Query Leaf Stream
    [Documentation]    Execute SQL query against Leaf server stream
    ...                Queries the materialized state on the Leaf server directly
    ...
    ...                Example:
    ...                | ${result}= | Query Leaf Stream | ${stream_id} | events |
    ...                | ${result}= | Query Leaf Stream | ${stream_id} | events | start=0 | limit=100 |
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to query
    ...                - query_name: Name of query to execute
    ...                - start: Optional start index (default: None)
    ...                - limit: Optional result limit (default: None)
    ...                - params: Optional query parameters as JSON string (default: None)
    ...
    ...                Returns: Dictionary with keys: success, rows, column_names, count

    [Arguments]    ${stream_id}    ${query_name}    ${start}=${None}    ${limit}=${None}    ${params}=${None}

    # Build command with optional arguments
    ${cmd}=    Set Variable    leaf query ${stream_id} ${query_name}
    ${cmd}=    Run Keyword If    '${start}' != '${None}'
    ...    Set Variable    ${cmd} --start ${start}
    ...    ELSE    Set Variable    ${cmd}
    ${cmd}=    Run Keyword If    '${limit}' != '${None}'
    ...    Set Variable    ${cmd} --limit ${limit}
    ...    ELSE    Set Variable    ${cmd}
    ${cmd}=    Run Keyword If    '${params}' != '${None}'
    ...    Set Variable    ${cmd} --params '${params}'
    ...    ELSE    Set Variable    ${cmd}

    # Execute command with environment variables
    ${result}=    Run Process    ${cmd}    shell=True
    ...    env:LEAF_URL=${LEAF_URL}    env:LEAF_TEST_TOKEN=${LEAF_TOKEN}

    # Check for errors
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Leaf query failed with exit code ${result.rc}: ${result.stderr}

    # Parse JSON response
    ${json}=    Evaluate    json.loads('''${result.stdout}''')    json

    # Verify success
    Should Be True    ${json['success']}
    ...    msg=Leaf query returned success=false: ${json.get('error', 'unknown error')}

    Log    Query ${query_name} on stream ${stream_id} returned ${json.get('count', 0)} rows
    RETURN    ${json}

Send Events To Stream
    [Documentation]    Send events directly to Leaf server stream
    ...                Bypasses the Roomy client for fixture creation
    ...
    ...                Example:
    ...                | ${events}= | Generate Test Events | 100 | did:plc:abc123 |
    ...                | Send Events To Stream | ${stream_id} | ${events} |
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to send events to
    ...                - events_json: JSON string of events array
    ...
    ...                Events format:
    ...                [{"user": "did:plc:...", "payload": "base64..."}, ...]

    [Arguments]    ${stream_id}    ${events_json}

    # Create temporary file for events
    ${temp_file}=    Set Variable    /tmp/leaf-events-${stream_id}.json
    Create File    ${temp_file}    ${events_json}

    # Execute command
    ${result}=    Run Process    leaf send-events ${stream_id} ${temp_file}
    ...    shell=True    env:LEAF_URL=${LEAF_URL}    env:LEAF_TEST_TOKEN=${LEAF_TOKEN}

    # Clean up temp file
    Remove File    ${temp_file}

    # Check for errors
    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Leaf send-events failed with exit code ${result.rc}: ${result.stderr}

    Log    Sent events to stream ${stream_id}
    RETURN    ${result.stdout}

Generate Test Events
    [Documentation]    Generate N simple test events for fixture creation
    ...                Creates events with sequential payloads for verification
    ...
    ...                Example:
    ...                | ${events}= | Generate Test Events | 5000 | did:plc:user123 |
    ...                | Send Events To Stream | ${stream_id} | ${events} |
    ...
    ...                Arguments:
    ...                - count: Number of events to generate
    ...                - user_did: DID of user sending events
    ...
    ...                Returns: JSON string of events array

    [Arguments]    ${count}    ${user_did}

    # Generate events list
    ${events}=    Create List
    FOR    ${i}    IN RANGE    ${count}
        # Create simple sequential payload
        ${payload_text}=    Set Variable    test-event-${i}
        ${payload}=    Evaluate    base64.b64encode(b'${payload_text}').decode()    base64
        ${event}=    Create Dictionary    user=${user_did}    payload=${payload}
        Append To List    ${events}    ${event}
    END

    # Convert to JSON
    ${json}=    Evaluate    json.dumps(${events})    json

    Log    Generated ${count} test events for user ${user_did}
    RETURN    ${json}

Get Stream Info
    [Documentation]    Get metadata about a stream from Leaf server
    ...
    ...                Example:
    ...                | ${info}= | Get Stream Info | ${stream_id} |
    ...                | Log | ${info} |
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to query
    ...
    ...                Returns: Dictionary with stream metadata

    [Arguments]    ${stream_id}

    ${result}=    Run Process    leaf stream-info ${stream_id}
    ...    shell=True    env:LEAF_URL=${LEAF_URL}    env:LEAF_TEST_TOKEN=${LEAF_TOKEN}

    Should Be Equal As Integers    ${result.rc}    0
    ...    msg=Leaf stream-info failed with exit code ${result.rc}: ${result.stderr}

    ${json}=    Evaluate    json.loads('''${result.stdout}''')    json
    Should Be True    ${json['success']}
    ...    msg=Leaf stream-info returned success=false: ${json.get('error', 'unknown error')}

    Log    Stream ${stream_id} info: ${json}
    RETURN    ${json}

Verify Event Count In Leaf Stream
    [Documentation]    Query Leaf server to verify exact event count
    ...                Independent verification of stream state
    ...
    ...                Example:
    ...                | Verify Event Count In Leaf Stream | ${stream_id} | 5000 |
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to verify
    ...                - expected_count: Expected number of events

    [Arguments]    ${stream_id}    ${expected_count}

    # Query all events with a high limit
    ${result}=    Query Leaf Stream    ${stream_id}    events    limit=1000000

    # Verify count
    ${actual_count}=    Get From Dictionary    ${result}    count
    Should Be Equal As Integers    ${actual_count}    ${expected_count}
    ...    msg=Leaf stream has ${actual_count} events, expected ${expected_count}

    Log    Verified ${expected_count} events in Leaf stream ${stream_id}

Get User DID From Peer
    [Documentation]    Get the authenticated user's DID from backend status
    ...                Useful for generating events as the test user
    ...
    ...                Example:
    ...                | ${user_did}= | Get User DID From Peer |
    ...
    ...                Returns: User DID (e.g., did:plc:abc123)

    ${user_did}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const did = window.backendStatus?.current?.authState?.did;
    ...        return did || null;
    ...    }

    Should Not Be Empty    ${user_did}    msg=User DID not found in backend status
    Log    User DID: ${user_did}
    RETURN    ${user_did}
