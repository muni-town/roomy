*** Settings ***
Documentation     Common resources for Roomy Robot Framework tests
...               Shared variables, browser setup, and worker initialization keywords
Library           Browser

*** Variables ***
${BROWSER}          chromium
${HEADLESS}         True
${BASE_URL}         http://127.0.0.1:5173
${DEFAULT_TIMEOUT}  20s
${POLL_INTERVAL}    100ms

*** Keywords ***
Setup Browser
    [Documentation]    Initialize browser with standard settings
    New Browser    browser=${BROWSER}    headless=${HEADLESS}
    Set Browser Timeout    ${DEFAULT_TIMEOUT}

Close Current Page If Open
    [Documentation]    Close the current page if one is open (used in Test Teardown)
    TRY
        ${pages}=    Get Page Ids
        ${has_pages}=    Evaluate    len($pages) > 0
        IF    ${has_pages}
            Close Page
        END
    EXCEPT
        Log    Could not close page - browser may have crashed
    END

Wait For Peer To Initialize
    [Documentation]    Wait for window.backend and window.backendStatus to be initialized
    [Arguments]    ${timeout}=${DEFAULT_TIMEOUT}
    ${backend_exists}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const start = Date.now();
    ...        const check = () => {
    ...            if (window.backend && window.backendStatus) {
    ...                resolve(true);
    ...            } else if (Date.now() - start < 20000) {
    ...                setTimeout(check, 200);
    ...            } else {
    ...                console.error('Peer initialization timeout. window.backend:', !!window.backend, 'window.backendStatus:', !!window.backendStatus);
    ...                console.error('Available window properties:', Object.keys(window).filter(k => k.includes('backend') || k.includes('CONFIG')));
    ...                resolve(false);
    ...            }
    ...        };
    ...        check();
    ...    })
    RETURN    ${backend_exists}

Wait For Debug Workers
    [Documentation]    Wait for window.debugWorkers to be available
    [Arguments]    ${timeout}=${DEFAULT_TIMEOUT}
    ${has_debug}=    Evaluate JavaScript    ${None}
    ...    () => new Promise((resolve) => {
    ...        const check = () => {
    ...            if (window.debugWorkers) {
    ...                resolve(true);
    ...            } else if (Date.now() - start < 20000) {
    ...                setTimeout(check, 100);
    ...            } else {
    ...                resolve(false);
    ...            }
    ...        };
    ...        const start = Date.now();
    ...        check();
    ...    })
    RETURN    ${has_debug}
