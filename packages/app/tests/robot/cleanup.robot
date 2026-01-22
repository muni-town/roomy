*** Settings ***
Documentation       Cleanup test suite for resetting test spaces
...                 Deletes the personal stream record from PDS,
...                 effectively removing all joined spaces.
...
...                 Run with: pnpm test:robot:cleanup

Library             Browser
Resource            resources/common.robot
Resource            resources/stream.robot


*** Test Cases ***
Cleanup Test Spaces
    [Documentation]    Delete personal stream record from PDS
    ...                This removes all joined spaces and resets the personal space.
    ...                After running this, reload the app to start fresh.

    # Setup browser and authenticate
    Setup Browser
    New Context    viewport={'width': 1280, 'height': 720}
    New Page    http://127.0.0.1:5173

    # Wait for backend initialization
    ${backend_initialized}=    Wait For Backend To Initialize
    Should Be True    ${backend_initialized}    msg=Backend initialization failed

    # Wait for authentication (happens automatically with app password)
    ${authenticated}=    Wait For Authentication
    Should Be True    ${authenticated}    msg=Authentication did not complete

    Log    Deleting personal stream record...
    ${result}=    Delete Stream Record From PDS

    Log    Stream record deleted: ${result}
    Log    All test spaces have been cleared. Reload the app to start fresh.

    [Teardown]    Close Browser
