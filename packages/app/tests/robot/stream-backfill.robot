*** Settings ***
Documentation       Test suite for stream backfill correctness
...                 Tests the client's ability to backfill events from Leaf server including:
...                 - Basic backfill with various event counts
...                 - Batch boundary conditions (2500-event batches)
...                 - Event ordering preservation
...                 - No event loss or duplication
...
...                 These tests verify the integration between:
...                 - Leaf server stream storage
...                 - Client backfill mechanism (BackfillState)
...                 - SQLite database materialization
...                 - Event ordering and completeness
...
...                 Test Strategy:
...                 1. Create space (establishes stream)
...                 2. Inject test events directly via Leaf CLI
...                 3. Verify events exist in Leaf server
...                 4. Reload page to trigger backfill
...                 5. Verify all events materialized in SQLite

Library             Browser
Resource            resources/common.robot
Resource            resources/stream.robot
Resource            resources/space.robot
Resource            resources/leaf.robot

Suite Setup         Setup Test Environment For Backfill
Suite Teardown      Close Browser

Test Tags           backfill    stream


*** Keywords ***
Setup Test Environment For Backfill
    [Documentation]    Initialize browser and authenticate for backfill tests
    Setup Browser
    New Context    viewport={'width': 1280, 'height': 720}
    New Page    ${BASE_URL}
    Wait For Backend To Initialize
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}    msg=Authentication failed
    Log    Backfill test environment ready

Create Space And Inject Events
    [Documentation]    Helper to create space, inject events, and verify in Leaf
    ...                Returns space_id and total_event_count
    ...
    ...                Note: We do NOT wait for the space to reach idle before injecting events.
    ...                This ensures the client hasn't already synced when we inject test events,
    ...                forcing a full backfill on reload.
    ...
    ...                Arguments:
    ...                - event_count: Number of events to inject
    ...                - space_name: Name for the space (optional)

    [Arguments]    ${event_count}    ${space_name}=Backfill Test Space

    # Create space
    ${space_id}=    Create Space With Name    ${space_name}

    # Do NOT wait for space status - we want to inject events before client syncs

    # Sleep briefly to let initial events propagate to Leaf
    Sleep    2s

    # Get baseline event count (space creation events)
    ${baseline_result}=    Query Leaf Stream    ${space_id}    events    limit=1000000
    ${baseline_count}=    Get From Dictionary    ${baseline_result}    count
    Log    Baseline event count: ${baseline_count}

    # Generate and send events using Leaf CLI DID (not user DID)
    # The Leaf CLI authenticates as did:web:localhost, so events must be authored by that DID
    ${events}=    Generate Test Events    ${event_count}    ${LEAF_CLI_DID}
    Send Events To Stream    ${space_id}    ${events}

    # Verify total event count (baseline + injected)
    ${expected_total}=    Evaluate    ${baseline_count} + ${event_count}
    Verify Event Count In Leaf Stream    ${space_id}    ${expected_total}

    Log    Created space ${space_id} with ${baseline_count} initial events and injected ${event_count} test events (total: ${expected_total})
    RETURN    ${space_id}    ${expected_total}

Reload And Wait For Backfill
    [Documentation]    Reload page and wait for space to backfill
    ...
    ...                Arguments:
    ...                - space_id: Space ID to wait for
    ...                - timeout: Max time to wait (default: 60s)

    [Arguments]    ${space_id}    ${timeout}=60s

    # Reload page to force reconnection and backfill
    Reload

    # Wait for backend to reinitialize
    Wait For Backend To Initialize

    # Wait for authentication
    ${authenticated}=    Wait For Authentication    timeout=30s
    Should Be True    ${authenticated}

    # Check if OPFS/SQLite persisted
    ${comp_space_count}=    Execute SQL Query    SELECT COUNT(*) as count FROM comp_space
    Log    comp_space table has ${comp_space_count['rows'][0]['count']} rows after reload

    # Check backfilled_to for our space
    ${backfilled_sql}=    Set Variable    SELECT backfilled_to FROM comp_space WHERE entity = '${space_id}'
    ${backfilled_result}=    Execute SQL Query    ${backfilled_sql}
    Log    backfilled_to query result: ${backfilled_result}

    # Check if space is in backend status
    ${all_spaces}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const spaces = window.backendStatus?.current?.spaces || {};
    ...        return Object.keys(spaces);
    ...    }
    Log    All spaces in backend status: ${all_spaces}

    # Wait for space to reach idle (backfill complete)
    ${reached_idle}=    Wait For Space Status    ${space_id}    expectedStatus=idle    timeout=${timeout}
    Should Be True    ${reached_idle}    msg=Space did not complete backfill within ${timeout}

    # Diagnostic: check debug summary
    ${debug_summary}=    Evaluate JavaScript    ${None}
    ...    () => {
    ...        const logs = console.log.history || [];
    ...        const debugLogs = logs.filter(l => l && l.includes && l.includes('DEBUG]'));
    ...        return {
    ...            backendDebugCount: debugLogs.filter(l => l.includes('[BACKEND DEBUG]')).length,
    ...            streamDebugCount: debugLogs.filter(l => l.includes('[STREAM DEBUG]')).length,
    ...            backfillDebugCount: debugLogs.filter(l => l.includes('[BACKFILL DEBUG]')).length,
    ...            sampleLogs: debugLogs.slice(0, 10)
    ...        };
    ...    }
    Log    Debug log summary: ${debug_summary}

    # Diagnostic: dump database state
    Dump Database State For Space    ${space_id}

    Log    Page reloaded and space ${space_id} backfilled successfully

Dump Console Logs
    [Documentation]    Dump browser console logs for debugging (filtered for DEBUG messages)
    ${logs}=    Get Console Log    full=True
    Log    ===== CONSOLE LOGS (FILTERED) =====
    FOR    ${log}    IN    @{logs}
        ${is_debug}=    Evaluate    'DEBUG]' in '''${log['text']}'''
        IF    ${is_debug}
            Log    [${log['type']}] ${log['text']}
        END
    END
    Log    ===== END CONSOLE LOGS =====

Verify Event Count In SQLite
    [Documentation]    Query SQLite to verify event count
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to query
    ...                - expected_count: Expected number of events

    [Arguments]    ${stream_id}    ${expected_count}

    ${sql}=    Set Variable    SELECT COUNT(*) as count FROM events WHERE stream_id = '${stream_id}'
    ${result}=    Execute SQL Query    ${sql}

    ${actual_count}=    Set Variable    ${result['rows'][0]['count']}
    Should Be Equal As Integers    ${actual_count}    ${expected_count}
    ...    msg=SQLite has ${actual_count} events, expected ${expected_count}

    Log    Verified ${expected_count} events in SQLite for stream ${stream_id}

Verify Event Ordering
    [Documentation]    Verify events are ordered correctly by idx with no gaps
    ...
    ...                Arguments:
    ...                - stream_id: Stream ID to verify
    ...                - expected_count: Expected number of events

    [Arguments]    ${stream_id}    ${expected_count}

    # Get first and last event idx
    ${first_sql}=    Set Variable    SELECT idx FROM events WHERE stream_id = '${stream_id}' ORDER BY idx ASC LIMIT 1
    ${first_result}=    Execute SQL Query    ${first_sql}
    ${first_idx}=    Set Variable    ${first_result['rows'][0]['idx']}

    ${last_sql}=    Set Variable    SELECT idx FROM events WHERE stream_id = '${stream_id}' ORDER BY idx DESC LIMIT 1
    ${last_result}=    Execute SQL Query    ${last_sql}
    ${last_idx}=    Set Variable    ${last_result['rows'][0]['idx']}

    # First event should be idx=1
    Should Be Equal As Integers    ${first_idx}    1
    ...    msg=First event has idx=${first_idx}, expected 1

    # Last event idx should equal event count
    Should Be Equal As Integers    ${last_idx}    ${expected_count}
    ...    msg=Last event has idx=${last_idx}, expected ${expected_count}

    # Verify no gaps: count distinct idx values should equal expected_count
    ${distinct_sql}=    Set Variable    SELECT COUNT(DISTINCT idx) as count FROM events WHERE stream_id = '${stream_id}'
    ${distinct_result}=    Execute SQL Query    ${distinct_sql}
    ${distinct_count}=    Set Variable    ${distinct_result['rows'][0]['count']}

    Should Be Equal As Integers    ${distinct_count}    ${expected_count}
    ...    msg=Found ${distinct_count} distinct idx values, expected ${expected_count} (indicates gaps or duplicates)

    Log    Event ordering verified: idx from 1 to ${expected_count} with no gaps


*** Test Cases ***
Backfill 1000 Events
    [Documentation]    Test backfill with 1000 events (sub-batch size)
    ...                Verifies basic backfill works with events under single batch
    [Tags]    basic

    ${space_id}    ${total_count}=    Create Space And Inject Events    1000    1000 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=30s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Backfill 5000 Events Across Batches
    [Documentation]    Test backfill with 5000 events (2 batches of 2500)
    ...                Verifies backfill works correctly across batch boundaries
    [Tags]    basic    batch-boundary

    ${space_id}    ${total_count}=    Create Space And Inject Events    5000    5000 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=60s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Backfill 10000 Events Multiple Batches
    [Documentation]    Test backfill with 10000 events (4 batches of 2500)
    ...                Verifies backfill scales to multiple batches
    [Tags]    basic    large

    ${space_id}    ${total_count}=    Create Space And Inject Events    10000    10000 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=90s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Backfill Exactly 2500 Events Single Batch
    [Documentation]    Test backfill with exactly 2500 events (single full batch)
    ...                Edge case: batch size boundary
    [Tags]    batch-boundary    edge-case

    ${space_id}    ${total_count}=    Create Space And Inject Events    2500    2500 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=30s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Backfill 2501 Events Two Batches
    [Documentation]    Test backfill with 2501 events (one full batch + one event)
    ...                Edge case: just over batch size boundary
    [Tags]    batch-boundary    edge-case

    ${space_id}    ${total_count}=    Create Space And Inject Events    2501    2501 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=30s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Backfill 7500 Events Three Full Batches
    [Documentation]    Test backfill with 7500 events (3 batches of 2500)
    ...                Edge case: multiple full batches
    [Tags]    batch-boundary

    ${space_id}    ${total_count}=    Create Space And Inject Events    7500    7500 Events Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=90s

    # Verify all events materialized
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify ordering
    Verify Event Ordering    ${space_id}    ${total_count}

Verify No Duplicate Events
    [Documentation]    Test that backfill doesn't create duplicate events
    ...                Verifies each event appears exactly once
    [Tags]    ordering    correctness

    ${space_id}    ${total_count}=    Create Space And Inject Events    3000    Duplicate Check Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=60s

    # Verify total count
    Verify Event Count In SQLite    ${space_id}    ${total_count}

    # Verify no duplicate idx values
    ${duplicate_sql}=    Catenate    SEPARATOR=${SPACE}
    ...    SELECT idx, COUNT(*) as count FROM events
    ...    WHERE stream_id = '${space_id}'
    ...    GROUP BY idx HAVING count > 1
    ${duplicate_result}=    Execute SQL Query    ${duplicate_sql}

    ${duplicate_count}=    Get Length    ${duplicate_result['rows']}
    Should Be Equal As Integers    ${duplicate_count}    0
    ...    msg=Found ${duplicate_count} duplicate idx values: ${duplicate_result['rows']}

    Log    No duplicate events found in stream ${space_id}

Verify Event Indices Monotonic
    [Documentation]    Test that event idx values are strictly monotonic
    ...                Verifies ordering is preserved correctly
    [Tags]    ordering

    ${space_id}    ${total_count}=    Create Space And Inject Events    2000    Monotonic Test

    # Reload to trigger backfill
    Reload And Wait For Backfill    ${space_id}    timeout=60s

    # Get all idx values in order
    ${sql}=    Set Variable    SELECT idx FROM events WHERE stream_id = '${space_id}' ORDER BY idx ASC
    ${result}=    Execute SQL Query    ${sql}

    # Verify strictly increasing
    ${rows}=    Set Variable    ${result['rows']}
    ${prev_idx}=    Set Variable    0
    FOR    ${row}    IN    @{rows}
        ${curr_idx}=    Set Variable    ${row['idx']}
        ${is_increasing}=    Evaluate    ${curr_idx} > ${prev_idx}
        Should Be True    ${is_increasing}
        ...    msg=Event idx not strictly increasing: prev=${prev_idx}, curr=${curr_idx}
        ${prev_idx}=    Set Variable    ${curr_idx}
    END

    Log    All event indices are strictly monotonic for stream ${space_id}
