*** Settings ***
Documentation       Stream management keywords for Roomy testing
...                 Provides helper keywords for:
...                 - Managing PDS stream records (create, read, delete)
...                 - Verifying stream connection status
...                 - Triggering stream creation
...                 - Validating stream record structure
...
...                 These keywords assume the user is already authenticated.
...                 Use auth.robot keywords for authentication setup.

Library             Browser
Library             DateTime
Library             Collections


*** Keywords ***
Wait For Authentication
    [Documentation]    Wait for authentication to complete and client to be connected
    ...                Polls window.backendStatus until both authenticated and connected
    ...
    ...                Example:
    ...                | ${authenticated}= | Wait For Authentication |
    ...                | Should Be True | ${authenticated} |
    ...
    ...                Arguments:
    ...                - timeout: Maximum time to wait (default: 30s)
    ...
    ...                Returns: True if authenticated and connected, False if timeout

    [Arguments]    ${timeout}=30s

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)

    ${authenticated}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const timeoutMs = ${timeout_ms};
    ...        const start = Date.now();
    ...        const check = () => {
    ...            const authState = window.backendStatus?.current?.authState;
    ...            if (authState?.state === 'authenticated' && authState?.clientStatus === 'connected') {
    ...                resolve(true);
    ...            } else if (Date.now() - start < timeoutMs) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.log('Timeout waiting for authentication. Auth state:', authState?.state, 'Client status:', authState?.clientStatus);
    ...                resolve(false);
    ...            }
    ...        };
    ...        check();
    ...    })

    RETURN    ${authenticated}

Delete Stream Record From PDS
    [Documentation]    Deletes the personal stream record from the authenticated user's PDS
    ...                Uses AT Protocol API com.atproto.repo.deleteRecord
    ...                Handles RecordNotFound errors gracefully
    ...                Returns: { success: true, alreadyDeleted: bool }
    ...
    ...                Example:
    ...                | ${result}= | Delete Stream Record From PDS |
    ...                | Should Be True | ${result['success']} |

    ${result}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        try {
    ...            await window.backend.deleteStreamRecord();
    ...            return { success: true, alreadyDeleted: false };
    ...        } catch (error) {
    ...            if (error.message?.includes('RecordNotFound') || error.message?.includes('Could not locate record')) {
    ...                return { success: true, alreadyDeleted: true };
    ...            }
    ...            throw error;
    ...        }
    ...    }

    Log    Stream record deleted from PDS: ${result}
    RETURN    ${result}

Get Stream Record From PDS
    [Documentation]    Retrieves the personal stream record from the authenticated user's PDS
    ...                Uses AT Protocol API com.atproto.repo.getRecord
    ...                Returns record value or None if not found
    ...
    ...                Example:
    ...                | ${record}= | Get Stream Record From PDS |
    ...                | Should Not Be Equal | ${record} | ${None} |
    ...
    ...                Returns: Record dictionary with 'id' field, or None if not found

    ${result}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        try {
    ...            return await window.backend.getStreamRecord();
    ...        } catch (error) {
    ...            if (error.message?.includes('RecordNotFound') || error.message?.includes('Could not locate record')) {
    ...                return null;
    ...            }
    ...            throw error;
    ...        }
    ...    }

    Log    Stream record: ${result}
    RETURN    ${result}

Verify Stream Connected
    [Documentation]    Verifies that the personal stream is connected in backend worker
    ...                Checks both authentication state and client connection status
    ...                Waits for connection with configurable timeout
    ...
    ...                Example:
    ...                | Verify Stream Connected |
    ...                | Verify Stream Connected | timeout=20s |
    ...
    ...                Arguments:
    ...                - timeout: Maximum time to wait for connection (default: 10s)

    [Arguments]    ${timeout}=10s

    ${authenticated}=    Wait For Authentication    timeout=${timeout}
    Should Be True    ${authenticated}    msg=Personal stream did not reach connected state within ${timeout}

    ${backend_status}=    Evaluate JavaScript    ${None}    () => window.backendStatus.current
    Should Be Equal    ${backend_status['authState']['state']}    authenticated
    Should Be Equal    ${backend_status['authState']['clientStatus']}    connected
    Should Not Be Empty    ${backend_status['authState']['personalStream']}
    Log    Personal stream connected: ${backend_status['authState']['personalStream']}

Trigger Personal Stream Creation
    [Documentation]    Explicitly triggers personal stream creation via backend worker
    ...                Calls Client.ensurePersonalStream() directly
    ...                Useful for testing stream creation flow in isolation
    ...
    ...                Example:
    ...                | Delete Stream Record From PDS |
    ...                | Trigger Personal Stream Creation |
    ...                | Verify Stream Connected |
    ...
    ...                Note: This is idempotent - calling when stream exists will reuse existing stream

    Evaluate JavaScript    ${None}    () => window.backend.ensurePersonalStream()

    Log    Personal stream creation triggered

Verify PDS Record Structure
    [Documentation]    Validates the structure of a stream record from PDS
    ...                Checks that required fields exist and have valid values
    ...
    ...                Example:
    ...                | ${record}= | Get Stream Record From PDS |
    ...                | Verify PDS Record Structure | ${record} |
    ...
    ...                Arguments:
    ...                - record: Record dictionary returned from Get Stream Record From PDS
    ...
    ...                Validates:
    ...                - Record is not empty
    ...                - Contains 'id' field
    ...                - ID is not empty and has valid hash format (length > 20)

    [Arguments]    ${record}

    Should Not Be Empty    ${record}
    Dictionary Should Contain Key    ${record}    id
    Should Not Be Empty    ${record['id']}

    # Validate stream ID format (should be base58-encoded hash)
    ${id_length}=    Get Length    ${record['id']}
    Should Be True    ${id_length} > 20    msg=Stream ID should be valid hash (length > 20, got ${id_length})

    Log    Stream record validated: ${record}

Wait For Personal Stream ID
    [Documentation]    Waits for personal stream ID to appear in backend status
    ...                Useful after triggering stream creation
    ...
    ...                Example:
    ...                | Trigger Personal Stream Creation |
    ...                | ${stream_id}= | Wait For Personal Stream ID |
    ...
    ...                Arguments:
    ...                - timeout: Maximum time to wait (default: 10s)
    ...
    ...                Returns: Stream hash ID

    [Arguments]    ${timeout}=10s

    ${timeout_ms}=    Convert Time    ${timeout}    result_format=number
    ${timeout_ms}=    Evaluate    int(${timeout_ms} * 1000)

    ${stream_id}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const timeoutMs = ${timeout_ms};
    ...        const start = Date.now();
    ...        const check = () => {
    ...            const streamId = window.backendStatus?.current?.authState?.personalStream;
    ...            if (streamId) {
    ...                resolve(streamId);
    ...            } else if (Date.now() - start < timeoutMs) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.log('Timeout waiting for personal stream ID');
    ...                resolve(null);
    ...            }
    ...        };
    ...        check();
    ...    })

    Should Not Be Empty    ${stream_id}    msg=Personal stream ID did not appear in backend status within ${timeout}
    Log    Personal stream ID: ${stream_id}
    RETURN    ${stream_id}

Get Client Status
    [Documentation]    Returns current client connection status from backend worker
    ...
    ...                Example:
    ...                | ${status}= | Get Client Status |
    ...                | Should Be Equal | ${status} | connected |
    ...
    ...                Possible values:
    ...                - 'error': Connection error
    ...                - 'offline': Not connected
    ...                - 'initialising': Streams initializing
    ...                - 'connected': Fully connected

    ${backend_status}=    Evaluate JavaScript    ${None}    () => window.backendStatus.current
    ${client_status}=    Set Variable    ${backend_status['authState']['clientStatus']}
    Log    Client status: ${client_status}
    RETURN    ${client_status}

Clear IndexedDB Stream Cache
    [Documentation]    Clears the IndexedDB cache of stream IDs
    ...                Useful for testing first-time stream creation scenarios
    ...                Forces the app to fetch stream info from PDS instead of cache
    ...
    ...                Example:
    ...                | Clear IndexedDB Stream Cache |
    ...                | Delete Stream Record From PDS |
    ...                | Trigger Personal Stream Creation |
    ...
    ...                Note: This requires reloading the page to take effect

    ${result}=    Evaluate JavaScript    ${None}
    ...    async () => {
    ...        const dbName = 'roomy';
    ...        const storeName = 'personalStream';
    ...
    ...        const db = await new Promise((resolve, reject) => {
    ...            const request = indexedDB.open(dbName);
    ...            request.onsuccess = () => resolve(request.result);
    ...            request.onerror = () => reject(request.error);
    ...        });
    ...
    ...        if (db.objectStoreNames.contains(storeName)) {
    ...            const tx = db.transaction([storeName], 'readwrite');
    ...            const store = tx.objectStore(storeName);
    ...            await new Promise((resolve, reject) => {
    ...                const request = store.clear();
    ...                request.onsuccess = () => resolve();
    ...                request.onerror = () => reject(request.error);
    ...            });
    ...            db.close();
    ...            return { success: true };
    ...        }
    ...
    ...        db.close();
    ...        return { success: true, notFound: true };
    ...    }

    Should Be True    ${result['success']}
    ${not_found}=    Get From Dictionary    ${result}    notFound    default=False
    Log    IndexedDB stream cache cleared (store not found: ${not_found})
